import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig } from '../lib/budget.mjs'
import { createProxy } from '../lib/proxy.mjs'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

async function close(server) {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}

async function waitFor(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      if (await check()) return
    } catch {
      // The state file may not exist yet.
    }
    if (Date.now() > deadline) throw new Error('timeout waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('streaming usage is charged and the next request is blocked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zed-budget-'))
  let upstreamBody
  const upstream = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      upstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n')
      res.write('data: {"choices":[],"usage":{"prompt_tokens":1000000,"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":1000000,"completion_tokens":1000000}}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  const upstreamPort = await listen(upstream)
  const config = normalizeConfig({
    upstream: `http://127.0.0.1:${upstreamPort}`,
    stateFile: join(dir, 'state.json'),
    logFile: join(dir, 'proxy.log'),
    dailyLimitCny: 0.5,
    usdToCny: 1,
    peakHoursUtc: [],
    models: { 'deepseek-flash': { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 } },
  })
  const proxy = createProxy(config)
  const proxyPort = await listen(proxy)

  try {
    const request = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    }
    const first = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, request)
    const firstText = await first.text()
    assert.equal(first.status, 200)
    assert.match(firstText, /"content":"ok"/)
    assert.equal(upstreamBody.stream_options.include_usage, true)

    await waitFor(async () => {
      const state = JSON.parse(await readFile(config.stateFile, 'utf8'))
      return Math.abs(state.spentUsd - 0.75) < 1e-9
    })

    const second = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, request)
    assert.equal(second.status, 402)
    const error = await second.json()
    assert.match(error.error.message, /лимит/i)
  } finally {
    await close(proxy)
    await close(upstream)
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('non-streaming JSON usage is charged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zed-budget-'))
  const upstream = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-test',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
        usage: {
          prompt_tokens: 1_000_000,
          prompt_cache_hit_tokens: 0,
          prompt_cache_miss_tokens: 1_000_000,
          completion_tokens: 1_000_000,
        },
      }))
    })
  })
  const upstreamPort = await listen(upstream)
  const config = normalizeConfig({
    upstream: `http://127.0.0.1:${upstreamPort}`,
    stateFile: join(dir, 'state.json'),
    logFile: join(dir, 'proxy.log'),
    dailyLimitCny: 100,
    usdToCny: 1,
    peakHoursUtc: [],
  })
  const proxy = createProxy(config)
  const proxyPort = await listen(proxy)

  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.choices[0].message.content, 'ok')

    const state = JSON.parse(await readFile(config.stateFile, 'utf8'))
    assert.ok(Math.abs(state.spentUsd - 0.75) < 1e-9)
  } finally {
    await close(proxy)
    await close(upstream)
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('health reports the shared daily counter', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zed-budget-'))
  const proxy = createProxy(normalizeConfig({
    stateFile: join(dir, 'state.json'),
    logFile: join(dir, 'proxy.log'),
    dailyLimitCny: 15,
    usdToCny: 1,
  }))
  const proxyPort = await listen(proxy)

  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/healthz`)
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.limitCny, 15)
    assert.equal(payload.spentCny, 0)
    assert.equal(payload.remainingCny, 15)
    assert.equal(payload.ok, true)
  } finally {
    await close(proxy)
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('model listing is forwarded even when the budget is exhausted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zed-budget-'))
  let listingCalls = 0
  const upstream = http.createServer((req, res) => {
    listingCalls += 1
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'deepseek-flash' }] }))
    })
  })
  const upstreamPort = await listen(upstream)
  const config = normalizeConfig({
    upstream: `http://127.0.0.1:${upstreamPort}`,
    stateFile: join(dir, 'state.json'),
    logFile: join(dir, 'proxy.log'),
    dailyLimitCny: 0,
    usdToCny: 1,
  })
  const proxy = createProxy(config)
  const proxyPort = await listen(proxy)

  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`)
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.data[0].id, 'deepseek-flash')
    assert.equal(listingCalls, 1)
  } finally {
    await close(proxy)
    await close(upstream)
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
