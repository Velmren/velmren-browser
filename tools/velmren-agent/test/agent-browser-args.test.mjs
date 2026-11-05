import test from 'node:test'
import assert from 'node:assert/strict'
import { agentBrowserArgs } from '../cdp.mjs'
import { persistentBrowserArgs } from '../profile-state.mjs'

const feature = 'ImprovedStartupBestEffortDelay'
const required = `${feature}:StartupDelayVisibleTabTimeout/0ms/StartupDelayFailsafeTimeout/1000ms`
const values = (args, name) => args.filter(arg => arg.startsWith(`${name}=`)).flatMap(arg => arg.slice(name.length + 1).split(','))

test('hidden agent startup receives the bounded startup feature without changing input arguments', () => {
  const input = Object.freeze(['--lang=en-US', '--headless=new'])
  assert.deepEqual(agentBrowserArgs(input), [...input, `--enable-features=${required}`])
  assert.deepEqual(agentBrowserArgs([]), [`--enable-features=${required}`])
})

test('multiple enable lists merge unrelated features and preserve their parameters and trials', () => {
  const result = agentBrowserArgs(['--enable-features=One:mode/old,Two<Study.Group', '--lang=en', '--enable-features=One:mode/new,*Three'])
  assert.deepEqual(result, ['--lang=en', `--enable-features=One:mode/new,Two<Study.Group,*Three,${required}`])
})

test('competing startup enable specifications and disables are replaced by exactly one required feature', () => {
  const result = agentBrowserArgs([
    `--enable-features=${feature},Keep`,
    `--enable-features=*${feature}<Trial.Group:StartupDelayFailsafeTimeout/9m`,
    `--disable-features=Disabled,${feature}`,
    `--disable-features=${feature}<Other,Disabled`
  ])
  assert.deepEqual(values(result, '--enable-features'), [required, 'Keep'])
  assert.deepEqual(values(result, '--disable-features'), ['Disabled'])
  assert.equal(result.filter(arg => arg.startsWith('--enable-features=')).length, 1)
  assert.equal(result.filter(arg => arg.startsWith('--disable-features=')).length, 1)
})

test('unrelated disables retain precedence with no duplicate or contradictory feature entries', () => {
  const result = agentBrowserArgs(['--enable-features=One,Two:mode/test,Three', '--disable-features=Two,Four', '--disable-features=One,Four'])
  assert.deepEqual(values(result, '--enable-features'), ['Three', required])
  assert.deepEqual(values(result, '--disable-features'), ['Two', 'Four', 'One'])
})

test('group-only startup specifications cannot retain a conflicting synthetic trial', () => {
  const result = agentBrowserArgs([
    `--enable-features=${feature}.Experiment:StartupDelayVisibleTabTimeout/5s/StartupDelayFailsafeTimeout/3m,Keep.Group:mode/test`
  ])
  assert.deepEqual(values(result, '--enable-features'), [required, 'Keep.Group:mode/test'])
})

test('split, empty and repeated switches normalize deterministically', () => {
  const result = agentBrowserArgs(['--enable-features', ' One ,,Two ', '--enable-features=', '--disable-features', `${feature},Three`, '--disable-features=', '--lang=en'])
  assert.deepEqual(result, ['--lang=en', `--enable-features=One,Two,${required}`, '--disable-features=Three'])
  assert.deepEqual(agentBrowserArgs(result), result)
  assert.deepEqual(agentBrowserArgs(['--enable-features', '--lang=en']), ['--lang=en', `--enable-features=${required}`])
})

test('persistent cookie policy survives normalization while ordinary profile arguments remain independent', () => {
  const ordinary = persistentBrowserArgs([])
  assert.deepEqual(ordinary, ['--restore-last-session', '--disable-features=BraveCleanupSessionCookiesOnSessionRestore'])
  const result = agentBrowserArgs(persistentBrowserArgs([`--disable-features=${feature},Other`, '--enable-features=BraveCleanupSessionCookiesOnSessionRestore,Keep']))
  assert.ok(result.includes('--restore-last-session'))
  assert.deepEqual(values(result, '--disable-features'), ['BraveCleanupSessionCookiesOnSessionRestore', 'Other'])
  assert.deepEqual(values(result, '--enable-features'), ['Keep', required])
  assert.deepEqual(ordinary, ['--restore-last-session', '--disable-features=BraveCleanupSessionCookiesOnSessionRestore'])
})
