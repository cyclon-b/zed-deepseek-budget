/**
 * Local HTTP proxy in front of the official DeepSeek API for Zed.
 *
 * Zed's native Agent talks to `language_models.deepseek.api_url`, which this
 * proxy replaces with `http://127.0.0.1:8787/v1`. Requests are forwarded
 * unchanged except for `stream_options.include_usage`, and provider-reported
 * usage is priced into the shared daily budget before the next request.
 *
 * @module zed-deepseek-budget/proxy
 */
import http from 'node:http'
import https from 'node:https'
import {
  BudgetStore,
  appendLog,
  computeCostUsd,
  exhaustedMessage,
  extractUsage,
  isPeak,
  resolveModel,
  usageSummary,
} from './budget.mjs'

const MAX_BODY_BYTES = 32 * 1024 * 1024
const MAX_JSON_RESPONSE_BYTES = 64 * 1024 * 1024
const HOP_BY_HOP = ['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive']

/**
 * Create the budget proxy server.
 * @param config - normalized config from `normalizeConfig`.
 * @returns an unlistened `http.Server`.
 */
export function createProxy(config) {
  const store = new BudgetStore(config)
  const limitUsd = config.dailyLimitCny / config.usdToCny

  const server = http.createServer((req, res) => {
    handleRequest(req, res, config, store, limitUsd).catch((error) => {
      void appendLog(config.logFile, `proxy error: ${error?.stack ?? error}`)
      if (!res.headersSent) {
        respondJson(res, 502, {
          error: {
            message: `Zed DeepSeek budget proxy: ${error?.message ?? error}`,
            type: 'proxy_error',
            code: 'proxy_error',
          },
        })
      } else {
        res.destroy()
      }
    })
  })
  server.keepAliveTimeout = 65_000
  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })
  return server
}

async function handleRequest(req, res, config, store, limitUsd) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)

  if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/budget')) {
    const state = await store.snapshot()
    respondJson(res, 200, health(config, state))
    return
  }

  const hasBody = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH'
  const body = hasBody ? await readBody(req) : undefined
  const payload = parseJson(body)
  const budgeted = isBudgetedRequest(req.method, url.pathname) && payload !== undefined && typeof payload.model === 'string'

  if (!budgeted) {
    forward(config, req, res, body, undefined)
    return
  }

  const state = await store.snapshot()
  if (state.spentUsd >= limitUsd) {
    void appendLog(config.logFile, `blocked model=${payload.model} spent=$${state.spentUsd.toFixed(6)} limit=$${limitUsd.toFixed(6)}`)
    respondJson(res, 402, {
      error: {
        message: exhaustedMessage(config, state),
        type: 'insufficient_quota',
        param: null,
        code: 'insufficient_quota',
      },
    })
    return
  }

  const context = {
    config,
    store,
    model: payload.model,
    price: config.models[resolveModel(payload.model, config)],
    peak: isPeak(Date.now(), config),
    startedAt: Date.now(),
    lastUsage: undefined,
    recorded: false,
  }
  const prepared = prepareBody(payload)
  forward(config, req, res, prepared ?? body, context)
}

function isBudgetedRequest(method, pathname) {
  if (method !== 'POST') return false
  return /\/(chat\/completions|responses)$/.test(pathname)
}

/** Ask DeepSeek to include usage in the final streaming chunk. */
function prepareBody(payload) {
  if (payload.stream !== true) return undefined
  if (payload.stream_options?.include_usage === true) return undefined
  const next = {
    ...payload,
    stream_options: { ...(payload.stream_options ?? {}), include_usage: true },
  }
  return Buffer.from(JSON.stringify(next), 'utf8')
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function parseJson(buffer) {
  if (buffer === undefined || buffer.length === 0) return undefined
  try {
    const value = JSON.parse(buffer.toString('utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

function forward(config, req, res, body, context) {
  let target
  try {
    const upstreamBase = config.upstream.replace(/\/+$/, '')
    const path = req.url?.startsWith('/') ? req.url : `/${req.url}`
    target = new URL(upstreamBase + path)
  } catch (error) {
    respondJson(res, 502, { error: { message: `invalid upstream URL: ${error?.message ?? error}`, type: 'proxy_error' } })
    return
  }

  const headers = { ...req.headers }
  for (const name of ['host', 'content-length', 'connection', 'proxy-connection', 'transfer-encoding']) {
    delete headers[name]
  }
  headers.host = target.host
  headers['accept-encoding'] = 'identity'
  if (body !== undefined) headers['content-length'] = String(body.length)

  const transport = target.protocol === 'https:' ? https : http
  let finished = false
  const upstreamReq = transport.request(target, { method: req.method, headers }, (upstreamRes) => {
    handleUpstream(upstreamRes, res, context, config, () => {
      finished = true
    })
  })

  upstreamReq.on('error', (error) => {
    void appendLog(context?.config.logFile ?? config.logFile, `upstream error: ${error?.message ?? error}`)
    if (!res.headersSent) {
      respondJson(res, 502, {
        error: { message: `DeepSeek upstream error: ${error?.message ?? error}`, type: 'proxy_error', code: 'proxy_error' },
      })
    } else {
      res.destroy()
    }
  })

  res.on('close', () => {
    if (!finished) upstreamReq.destroy()
  })

  if (body !== undefined) upstreamReq.end(body)
  else upstreamReq.end()
}

function handleUpstream(upstreamRes, res, context, config, markFinished) {
  const status = upstreamRes.statusCode ?? 502
  const contentType = String(upstreamRes.headers['content-type'] ?? '')
  const headers = { ...upstreamRes.headers }
  for (const name of HOP_BY_HOP) delete headers[name]

  if (contentType.includes('text/event-stream')) {
    res.writeHead(status, headers)
    const parser = new SseUsageParser((extracted) => {
      if (context !== undefined) context.lastUsage = extracted
    })
    upstreamRes.on('data', (chunk) => {
      parser.feed(chunk)
      if (!res.write(chunk)) upstreamRes.pause()
    })
    res.on('drain', () => upstreamRes.resume())
    upstreamRes.on('end', () => {
      parser.end()
      markFinished()
      void recordLastUsage(context).finally(() => res.end())
    })
    upstreamRes.on('error', (error) => {
      void appendLog(context?.config.logFile ?? config.logFile, `stream error: ${error?.message ?? error}`)
      markFinished()
      void recordLastUsage(context).finally(() => res.destroy())
    })
    res.on('close', () => {
      markFinished()
      void recordLastUsage(context)
    })
    return
  }

  if (contentType.includes('application/json')) {
    const chunks = []
    let size = 0
    upstreamRes.on('data', (chunk) => {
      size += chunk.length
      if (size <= MAX_JSON_RESPONSE_BYTES) chunks.push(chunk)
    })
    upstreamRes.on('end', () => {
      const body = Buffer.concat(chunks)
      const extracted = extractUsage(parseJson(body))
      if (extracted !== undefined && context !== undefined) context.lastUsage = extracted
      markFinished()
      void recordLastUsage(context).finally(() => {
        headers['content-length'] = String(body.length)
        if (!res.headersSent) res.writeHead(status, headers)
        res.end(body)
      })
    })
    upstreamRes.on('error', (error) => {
      void appendLog(context?.config.logFile ?? config.logFile, `response error: ${error?.message ?? error}`)
      markFinished()
      res.destroy()
    })
    res.on('close', () => {
      markFinished()
      void recordLastUsage(context)
    })
    return
  }

  res.writeHead(status, headers)
  upstreamRes.pipe(res)
  upstreamRes.on('end', () => {
    markFinished()
    void recordLastUsage(context)
  })
  upstreamRes.on('error', () => {
    markFinished()
    res.destroy()
  })
}

async function recordLastUsage(context) {
  if (context === undefined || context.recorded || context.lastUsage === undefined) return
  context.recorded = true
  try {
    const costUsd = computeCostUsd(context.lastUsage, context.price, context.peak)
    const state = await context.store.record(context.startedAt, costUsd)
    const spentCny = state.spentUsd * context.config.usdToCny
    await appendLog(
      context.config.logFile,
      `model=${context.model} cost=$${costUsd.toFixed(6)} spent=$${state.spentUsd.toFixed(6)} (${spentCny.toFixed(2)} ¥) ${usageSummary(context.lastUsage)}`,
    )
  } catch (error) {
    await appendLog(context.config.logFile, `record failed: ${error?.message ?? error}`)
  }
}

class SseUsageParser {
  constructor(onUsage) {
    this.onUsage = onUsage
    this.buffer = ''
  }

  feed(chunk) {
    this.buffer += chunk.toString('utf8')
    for (;;) {
      const match = this.buffer.match(/\r?\n\r?\n/)
      if (match === null || match.index === undefined) return
      this.dispatch(this.buffer.slice(0, match.index))
      this.buffer = this.buffer.slice(match.index + match[0].length)
    }
  }

  end() {
    if (this.buffer.trim().length > 0) this.dispatch(this.buffer)
    this.buffer = ''
  }

  dispatch(event) {
    for (const line of event.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (data === '' || data === '[DONE]') continue
      let payload
      try {
        payload = JSON.parse(data)
      } catch {
        continue
      }
      const extracted = extractUsage(payload)
      if (extracted !== undefined) this.onUsage(extracted)
    }
  }
}

function health(config, state) {
  const spentCny = state.spentUsd * config.usdToCny
  return {
    ok: true,
    date: state.date,
    limitCny: config.dailyLimitCny,
    spentCny: Number(spentCny.toFixed(4)),
    remainingCny: Number(Math.max(config.dailyLimitCny - spentCny, 0).toFixed(4)),
    requests: state.requests,
    peak: isPeak(Date.now(), config),
    upstream: config.upstream,
    stateFile: config.stateFile,
  }
}

function respondJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
  })
  res.end(body)
}
