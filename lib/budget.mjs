/**
 * Shared pricing, calendar and state helpers for the Zed DeepSeek budget proxy.
 *
 * Prices are the published DeepSeek peak rates in USD per 1M tokens; off-peak
 * is half. The state file is shared with the dsh `dsh-daily-budget` plugin so
 * the native Zed Agent and the external DeepSeek Harness share one daily cap.
 *
 * @module zed-deepseek-budget/budget
 */
import { appendFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const PER_MILLION = 1_000_000

export function dshHome() {
  const configured = process.env.DSH_HOME?.trim()
  if (configured === undefined || configured === '') return join(homedir(), '.dsh')
  if (configured === '~') return homedir()
  if (configured.startsWith('~/') || configured.startsWith('~\\')) return join(homedir(), configured.slice(2))
  return configured
}

export const DEFAULT_STATE_FILE = join(dshHome(), 'limits', 'daily-budget.json')
export const DEFAULT_LOG_FILE = join(dshHome(), 'limits', 'zed-agent-budget.log')

export const DEFAULT_MODELS = {
  'deepseek-flash': { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
  'deepseek-v4-pro': { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
}

export const DEFAULT_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'DeepSeek-V4.1-Flash': 'deepseek-flash',
  'DeepSeek V4.1 Flash': 'deepseek-flash',
  'DeepSeek-V4-Pro': 'deepseek-v4-pro',
  'DeepSeek V4 Pro': 'deepseek-v4-pro',
}

export const DEFAULT_CONFIG = {
  listen: { host: '127.0.0.1', port: 8787 },
  upstream: 'https://api.deepseek.com',
  dailyLimitCny: 15,
  usdToCny: 7.2,
  fallbackModel: 'deepseek-v4-pro',
  models: DEFAULT_MODELS,
  aliases: DEFAULT_ALIASES,
  peakHoursUtc: [[1, 4], [6, 10]],
  holidays: [],
  stateFile: DEFAULT_STATE_FILE,
  logFile: DEFAULT_LOG_FILE,
  resetTimeZone: '',
}

export function applyEnv(input = {}, env = process.env) {
  const config = { ...input, listen: { ...(input.listen ?? {}) } }

  const number = (name) => {
    const raw = env[name]
    if (raw === undefined || raw.trim() === '') return undefined
    const value = Number(raw)
    if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`)
    return value
  }
  const string = (name) => {
    const raw = env[name]
    return raw === undefined || raw.trim() === '' ? undefined : raw.trim()
  }

  const dailyLimit = number('DAILY_LIMIT_CNY')
  if (dailyLimit !== undefined) config.dailyLimitCny = dailyLimit
  const usdToCny = number('USD_TO_CNY')
  if (usdToCny !== undefined) config.usdToCny = usdToCny
  const port = number('PORT')
  if (port !== undefined) config.listen.port = port
  const host = string('HOST')
  if (host !== undefined) config.listen.host = host
  const upstream = string('UPSTREAM')
  if (upstream !== undefined) config.upstream = upstream
  const stateFile = string('STATE_FILE')
  if (stateFile !== undefined) config.stateFile = stateFile
  const logFile = string('LOG_FILE')
  if (logFile !== undefined) config.logFile = logFile
  const resetTimeZone = string('RESET_TIME_ZONE')
  if (resetTimeZone !== undefined) config.resetTimeZone = resetTimeZone
  const holidays = string('HOLIDAYS')
  if (holidays !== undefined) config.holidays = holidays.split(',').map((part) => part.trim()).filter(Boolean)

  return config
}

const pad = (value) => String(value).padStart(2, '0')

export function normalizeConfig(input = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    ...input,
    listen: { ...DEFAULT_CONFIG.listen, ...(input.listen ?? {}) },
    models: { ...DEFAULT_MODELS, ...(input.models ?? {}) },
    aliases: { ...DEFAULT_ALIASES, ...(input.aliases ?? {}) },
    peakHoursUtc: input.peakHoursUtc ?? DEFAULT_CONFIG.peakHoursUtc,
    holidays: input.holidays ?? DEFAULT_CONFIG.holidays,
  }
  if (!(config.usdToCny > 0)) throw new Error('usdToCny must be positive')
  if (!(config.dailyLimitCny >= 0)) throw new Error('dailyLimitCny must be zero or positive')
  if (!Number.isInteger(config.listen.port) || config.listen.port < 0 || config.listen.port > 65535) {
    throw new Error(`invalid listen.port ${config.listen.port}`)
  }
  if (config.resetTimeZone) new Intl.DateTimeFormat('en-US', { timeZone: config.resetTimeZone })
  if (!Object.hasOwn(config.models, config.fallbackModel)) {
    throw new Error(`fallbackModel ${JSON.stringify(config.fallbackModel)} has no price entry`)
  }
  return config
}

export function dayKey(now = Date.now(), timeZone = '') {
  if (timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(now))
    const part = (type) => parts.find((entry) => entry.type === type)?.value ?? ''
    return `${part('year')}-${part('month')}-${part('day')}`
  }
  const date = new Date(now)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function isPeak(now = Date.now(), config) {
  const date = new Date(now)
  const weekday = date.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  if (config.holidays.length > 0 && config.holidays.includes(dayKey(now, 'Asia/Shanghai'))) return false
  const hour = date.getUTCHours()
  return config.peakHoursUtc.some(([start, end]) => hour >= start && hour < end)
}

export function resolveModel(model, config) {
  const canonical = config.aliases[model] ?? model
  return Object.hasOwn(config.models, canonical) ? canonical : config.fallbackModel
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Price an OpenAI chat-completions usage record.
 * DeepSeek reports cache hit/miss prompt tokens separately; when they are
 * absent, the whole prompt is billed as cache miss.
 */
export function computeChatCostUsd(usage, price, peak) {
  const scale = (peak ? 1 : 0.5) / PER_MILLION
  const hit = finite(usage?.prompt_cache_hit_tokens)
  const miss = finite(usage?.prompt_cache_miss_tokens)
  const prompt = finite(usage?.prompt_tokens)
  const uncached = hit > 0 || miss > 0 ? miss : prompt
  const output = finite(usage?.completion_tokens)
  return (uncached * price.cacheMiss + hit * price.cacheHit + output * price.output) * scale
}

/** Price a Responses API usage record; cached input is a subset of input_tokens. */
export function computeResponsesCostUsd(usage, price, peak) {
  const scale = (peak ? 1 : 0.5) / PER_MILLION
  const input = finite(usage?.input_tokens)
  const cached = finite(usage?.input_tokens_details?.cached_tokens)
  const uncached = Math.max(input - cached, 0)
  const output = finite(usage?.output_tokens)
  return (uncached * price.cacheMiss + cached * price.cacheHit + output * price.output) * scale
}

/**
 * Find a usage object in a chat-completion or Responses payload.
 * @returns `{ kind: 'chat' | 'responses', usage }` or undefined.
 */
export function extractUsage(payload) {
  const usage = payload?.usage ?? payload?.response?.usage
  if (usage === null || typeof usage !== 'object') return undefined
  if ('prompt_tokens' in usage || 'completion_tokens' in usage) return { kind: 'chat', usage }
  if ('input_tokens' in usage || 'output_tokens' in usage) return { kind: 'responses', usage }
  return undefined
}

export function computeCostUsd(extracted, price, peak) {
  return extracted.kind === 'chat'
    ? computeChatCostUsd(extracted.usage, price, peak)
    : computeResponsesCostUsd(extracted.usage, price, peak)
}

export function usageSummary(extracted) {
  const usage = extracted.usage
  if (extracted.kind === 'chat') {
    return `prompt=${finite(usage.prompt_tokens)} hit=${finite(usage.prompt_cache_hit_tokens)} miss=${finite(usage.prompt_cache_miss_tokens)} output=${finite(usage.completion_tokens)}`
  }
  return `input=${finite(usage.input_tokens)} cached=${finite(usage.input_tokens_details?.cached_tokens)} output=${finite(usage.output_tokens)}`
}

export function formatDay(key) {
  const [year, month, day] = key.split('-')
  return `${day}.${month}.${year}`
}

export function exhaustedMessage(config, state) {
  const spent = (state.spentUsd * config.usdToCny).toFixed(2)
  const limit = config.dailyLimitCny.toFixed(2)
  return `Дневной лимит DeepSeek исчерпан: ${spent} ¥ из ${limit} ¥ за ${formatDay(state.date)}. Лимит обновится завтра в 00:00. Настройка: DAILY_LIMIT_CNY (Docker) или config.json.`
}

export async function appendLog(path, text) {
  try {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${new Date().toISOString()} ${text}\n`, 'utf8')
  } catch {
    // Logging must never break a model request.
  }
}

async function readState(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.date !== 'string') return undefined
    return parsed
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    return undefined
  }
}

async function writeState(path, state) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

function normalizeState(stored, date) {
  return {
    version: 1,
    date,
    spentUsd: finite(stored.spentUsd),
    requests: Number.isSafeInteger(stored.requests) && stored.requests > 0 ? stored.requests : 0,
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : undefined,
  }
}

const LOCK_TIMEOUT_MS = 5_000
const LOCK_STALE_MS = 30_000

/**
 * Serialize state changes across processes (the proxy and the dsh plugin).
 * The lock is a `wx` file; a stale lock left by a crash is removed after 30 s.
 */
export async function withFileLock(lockPath, operation) {
  await mkdir(dirname(lockPath), { recursive: true })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx')
      try {
        return await operation()
      } finally {
        await handle.close().catch(() => {})
        await unlink(lockPath).catch(() => {})
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (Date.now() > deadline) {
        try {
          const info = await stat(lockPath)
          if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
            await unlink(lockPath).catch(() => {})
            continue
          }
        } catch {
          // The lock disappeared between attempts; retry immediately.
          continue
        }
        throw new Error(`timeout waiting for ${lockPath}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

export class BudgetStore {
  constructor(config) {
    this.config = config
    this.path = config.stateFile
    this.lockPath = `${config.stateFile}.lock`
  }

  /** Read the current day's state, resetting it on a new day. */
  async snapshot(now = Date.now()) {
    return withFileLock(this.lockPath, async () => {
      const date = dayKey(now, this.config.resetTimeZone)
      const stored = await readState(this.path)
      if (stored?.date === date) return normalizeState(stored, date)
      const fresh = { version: 1, date, spentUsd: 0, requests: 0, updatedAt: undefined }
      if (stored !== undefined) await writeState(this.path, fresh)
      return fresh
    })
  }

  /** Add one request's cost and return the updated state. */
  async record(now, costUsd) {
    return withFileLock(this.lockPath, async () => {
      const date = dayKey(now, this.config.resetTimeZone)
      const stored = await readState(this.path)
      const state = stored?.date === date
        ? normalizeState(stored, date)
        : { version: 1, date, spentUsd: 0, requests: 0, updatedAt: undefined }
      state.spentUsd += costUsd
      state.requests += 1
      state.updatedAt = new Date(now).toISOString()
      await writeState(this.path, state)
      return state
    })
  }
}
