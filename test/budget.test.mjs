import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BudgetStore,
  applyEnv,
  computeChatCostUsd,
  computeResponsesCostUsd,
  dayKey,
  isPeak,
  normalizeConfig,
  resolveModel,
} from '../lib/budget.mjs'

const flash = { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 }
const pro = { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 }

test('environment variables override the config file', () => {
  const config = applyEnv(
    { dailyLimitCny: 1, listen: { host: '127.0.0.1', port: 1 } },
    {
      DAILY_LIMIT_CNY: '25',
      USD_TO_CNY: '7.3',
      PORT: '9000',
      HOST: '0.0.0.0',
      STATE_FILE: '/data/state.json',
      LOG_FILE: '/data/proxy.log',
      RESET_TIME_ZONE: 'Europe/Moscow',
      HOLIDAYS: '2026-01-01, 2026-02-17',
    },
  )
  assert.equal(config.dailyLimitCny, 25)
  assert.equal(config.usdToCny, 7.3)
  assert.equal(config.listen.port, 9000)
  assert.equal(config.listen.host, '0.0.0.0')
  assert.equal(config.stateFile, '/data/state.json')
  assert.equal(config.logFile, '/data/proxy.log')
  assert.equal(config.resetTimeZone, 'Europe/Moscow')
  assert.deepEqual(config.holidays, ['2026-01-01', '2026-02-17'])
})

test('invalid numeric environment variables fail loud', () => {
  assert.throws(() => applyEnv({}, { DAILY_LIMIT_CNY: 'fifteen' }), /DAILY_LIMIT_CNY must be a number/)
})

test('chat usage prices cache hit and miss separately', () => {
  const usage = {
    prompt_tokens: 2_000_000,
    prompt_cache_hit_tokens: 1_000_000,
    prompt_cache_miss_tokens: 1_000_000,
    completion_tokens: 1_000_000,
  }
  assert.ok(Math.abs(computeChatCostUsd(usage, flash, true) - 1.506) < 1e-9)
  assert.ok(Math.abs(computeChatCostUsd(usage, flash, false) - 0.753) < 1e-9)
})

test('chat usage without cache fields bills the whole prompt as miss', () => {
  assert.ok(Math.abs(computeChatCostUsd({ prompt_tokens: 1_000_000 }, flash, true) - 0.3) < 1e-9)
})

test('responses usage prices cached input as a subset', () => {
  const usage = {
    input_tokens: 2_000_000,
    input_tokens_details: { cached_tokens: 1_000_000 },
    output_tokens: 1_000_000,
  }
  assert.ok(Math.abs(computeResponsesCostUsd(usage, flash, true) - 1.506) < 1e-9)
})

test('peak windows follow UTC weekdays', () => {
  const config = { holidays: [], peakHoursUtc: [[1, 4], [6, 10]] }
  assert.equal(isPeak(Date.parse('2026-11-18T02:00:00Z'), config), true)
  assert.equal(isPeak(Date.parse('2026-11-18T05:00:00Z'), config), false)
  assert.equal(isPeak(Date.parse('2026-11-21T02:00:00Z'), config), false)
})

test('a Chinese holiday removes the peak rate', () => {
  const config = { holidays: ['2026-11-18'], peakHoursUtc: [[1, 4], [6, 10]] }
  assert.equal(isPeak(Date.parse('2026-11-18T02:00:00Z'), config), false)
})

test('aliases and fallback resolve to a priced model', () => {
  const config = { aliases: { 'deepseek-v4-flash': 'deepseek-flash' }, models: { 'deepseek-flash': flash, 'deepseek-v4-pro': pro }, fallbackModel: 'deepseek-v4-pro' }
  assert.equal(resolveModel('deepseek-v4-flash', config), 'deepseek-flash')
  assert.equal(resolveModel('unknown', config), 'deepseek-v4-pro')
})

test('day key uses the configured zone', () => {
  assert.equal(dayKey(Date.parse('2026-11-18T23:30:00Z'), 'Asia/Shanghai'), '2026-11-19')
  assert.equal(dayKey(Date.parse('2026-11-18T23:30:00Z'), 'UTC'), '2026-11-18')
})

test('the store shares one counter through the lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zed-budget-'))
  try {
    const config = normalizeConfig({ stateFile: join(dir, 'state.json'), logFile: join(dir, 'log.txt') })
    const store = new BudgetStore(config)
    await Promise.all([store.record(Date.now(), 1), store.record(Date.now(), 1)])
    const state = JSON.parse(await readFile(config.stateFile, 'utf8'))
    assert.equal(state.spentUsd, 2)
    assert.equal(state.requests, 2)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
