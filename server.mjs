import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyEnv, appendLog, normalizeConfig } from './lib/budget.mjs'
import { createProxy } from './lib/proxy.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const configPath = process.env.CONFIG_PATH || join(root, 'config.json')

let loaded = {}
try {
  loaded = JSON.parse(await readFile(configPath, 'utf8'))
} catch (error) {
  if (error?.code !== 'ENOENT') {
    console.error(`zed-deepseek-budget: cannot load ${configPath}: ${error?.message ?? error}`)
    process.exit(1)
  }
}

let config
try {
  config = normalizeConfig(applyEnv(loaded))
} catch (error) {
  console.error(`zed-deepseek-budget: invalid configuration: ${error?.message ?? error}`)
  process.exit(1)
}

const server = createProxy(config)

server.on('error', (error) => {
  const line = `listen error: ${error?.stack ?? error}`
  void appendLog(config.logFile, line)
  console.error(`zed-deepseek-budget: ${error.message}`)
  process.exit(1)
})

server.listen(config.listen.port, config.listen.host, () => {
  const address = server.address()
  const line = `listening on http://${address.address}:${address.port} -> ${config.upstream}; limit ${config.dailyLimitCny} ¥/day; state ${config.stateFile}`
  void appendLog(config.logFile, line)
  console.log(line)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void appendLog(config.logFile, `received ${signal}, shutting down`)
    server.close(() => process.exit(0))
  })
}

process.on('uncaughtException', (error) => {
  void appendLog(config.logFile, `uncaught: ${error?.stack ?? error}`)
  console.error(error)
  process.exit(1)
})

process.on('unhandledRejection', (error) => {
  void appendLog(config.logFile, `unhandled rejection: ${error?.stack ?? error}`)
})
