// Isolated acceptance daemon: synthetic provider only; never contacts CapSolver.
import { appendFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const directory = process.env.VELMREN_TEST_AGENT_DIRECTORY ?? fileURLToPath(new URL('../../', import.meta.url))
const { startBroker } = await import(pathToFileURL(path.join(directory, 'broker.mjs')))
const { CaptchaService } = await import(pathToFileURL(path.join(directory, 'capsolver-service.mjs')))
const { parseManagedOptions, resolveManagedOptions, runManagedBroker } = await import(pathToFileURL(path.join(directory, 'managed-runtime.mjs')))
const { installLifecycle } = await import(pathToFileURL(path.join(directory, 'lifecycle.mjs')))

const options = await resolveManagedOptions(parseManagedOptions(process.argv.slice(2)))
installLifecycle(options.stateDir)
const service = new CaptchaService(options.stateDir, {
  protector: { available: true, ensureDirectory: async () => {}, protect: async () => 'U3ludGhldGlj', unprotect: async () => 'SyntheticRecoveryKey' },
  provider: { balance: async () => ({ balanceUsd: 10 }), async solve(task, { signal, onDispatch }) {
    const kind = task.websiteKey === 'synthetic-terminal' ? 'terminal' : 'pending'
    await onDispatch()
    await appendFile(path.join(options.stateDir, 'synthetic-provider.jsonl'), JSON.stringify({ kind, pid: process.pid }) + '\n')
    if (kind === 'terminal') return { token: 'SyntheticRecoveryToken' }
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { code: 'CAPTCHA_CANCELLED' })), { once: true })
    })
  } }
})
await service.ready
await service.settings({ action: 'save', enabled: true, key: 'SyntheticRecoveryKey', maxRequestsPerDay: 10, maxConcurrent: 2, maxAttemptsPerTask: 2 })
const app = await runManagedBroker(options, { startBroker: async config => {
  const app = await startBroker({ ...config, captchaService: service })
  await writeFile(path.join(options.stateDir, 'synthetic-browser-pid'), String(app.broker.browser.process.pid))
  return app
} })
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(signal); process.exit(0) })
