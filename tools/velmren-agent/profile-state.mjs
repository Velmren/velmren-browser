import { readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { effectivePolicyIdentity } from './policy-identity.mjs'

// Checked before Chromium starts: previously registered workers can run before
// DevTools attachment, so a persistent profile must never change policy.
export async function bindProfilePolicy(stateDir, policy) {
  const identity = effectivePolicyIdentity(policy)
  const file = path.join(stateDir, 'profile-policy.json')
  let binding
  try { binding = JSON.parse(await readFile(file, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Persistent profile policy binding is unreadable') }
  if (binding) {
    if (binding.schema !== 1 || binding.identity !== identity || policy.profileMode !== 'persistent') {
      throw new Error('Persistent profile policy mismatch; use a separate agent state directory')
    }
    return
  }
  if (policy.profileMode !== 'persistent') return
  const contents = await readdir(path.join(stateDir, 'browser-profile')).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  if (contents.length) throw new Error('Existing unbound browser profile cannot be reused as a persistent agent profile')
  await writeFile(file, JSON.stringify({ schema: 1, identity }), { flag: 'wx', mode: 0o600 })
}

export function persistentBrowserArgs(args) {
  const features = new Set(['BraveCleanupSessionCookiesOnSessionRestore'])
  const rest = []
  for (const arg of args) {
    if (arg.startsWith('--disable-features=')) {
      for (const feature of arg.slice('--disable-features='.length).split(',')) if (feature) features.add(feature)
    } else rest.push(arg)
  }
  return [...rest, '--restore-last-session', `--disable-features=${[...features].join(',')}`]
}
