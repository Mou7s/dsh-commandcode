// Offline, read-only product audit. These checks record defects in the current
// code rather than adding failing assertions to the regular regression suite.
// Run: node scripts/audit-0.8.0.mjs
import { readFile } from 'node:fs/promises'
import { buildEntries, routeForModel } from '../lib/catalog.js'
import { syncPlan, pruneGeneratedRoutes } from '../lib/pi-ai.js'
import { fetchUsageReport } from '../lib/usage.js'
import { makeSearchProvider } from '../lib/search.js'
import { apply, Config } from '../lib/index.js'

const results = []
const sample = { id: 'vendor/reasoner', name: 'Reasoner', contextWindow: 100000, supportedEndpoints: ['/chat/completions'] }
const catalog = [{ ...sample, minPlanName: 'GOAT', vision: true, reasoning: true }]
const keys = { chat: 'commandcode-goat-autosync', claude: 'commandcode-goat-anthropic', pro: 'commandcode-pro-autosync' }
const entry = { id: sample.id, input: ['text'] }
const routes = { openai: [entry], anthropic: [], responses: [] }
const tick = () => new Promise(setImmediate)
function record(id, title, bug, observed, expected) {
  results.push({ id, title, reproduced: Boolean(bug), observed, expected })
}
async function usingFetch(fetcher, task) {
  const before = globalThis.fetch
  globalThis.fetch = fetcher
  try { return await task() } finally { globalThis.fetch = before }
}
function settings(providers = {}) {
  return {
    value: { providers: structuredClone(providers) }, revision: 0,
    describe() { return [{ ns: 'llm-pi-ai', revision: this.revision, value: this.value }] },
    async mutate(_ns, ops, revision) {
      if (revision !== this.revision) throw Object.assign(new Error('conflict'), { code: 'SETTINGS_CONFLICT' })
      for (const op of ops) {
        let parent = this.value
        for (const part of op.path.slice(0, -1)) parent = parent[part] ??= {}
        if (op.op === 'unset') delete parent[op.path.at(-1)]
        else parent[op.path.at(-1)] = structuredClone(op.value)
      }
      this.revision++
    },
  }
}
function host(services) {
  const effects = []
  const listeners = new Map()
  const ctx = {
    ...services, fiber: { entry: { options: { id: 'commandcode-goat' } } },
    logger: { info() {}, warn() {} }, get(name) { return this[name] },
    inject(names, fn) { if (names.every((name) => this[name])) fn(this) },
    effect(fn) { const dispose = fn(); effects.push(dispose); return dispose },
    on(name, fn) { listeners.set(name, [...listeners.get(name) ?? [], fn]) },
  }
  return { ctx, effects, emit(name) { for (const fn of listeners.get(name) ?? []) fn() }, dispose() { for (const fn of [...effects].reverse()) fn?.() } }
}
const request = (body = {}) => ({ method: 'POST', headers: { host: 'localhost:3080' }, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } })
async function drive(route, body) {
  let output
  await route.handler(request(body), { setHeader() {}, end(value) { output = JSON.parse(value) } })
  return output
}
function server() {
  return { routes: [], register(route) { this.routes.push(route); return () => {} } }
}
const accountFetch = (body) => async (url) => ({ ok: true, status: 200, json: async () => body(String(url)) })

// Model discovery, synchronization and user customization.
{
  const s = settings({ [keys.claude]: { api: 'anthropic-messages', models: [{ id: 'retired-claude' }] } })
  const synced = await syncPlan({ settings: s, plan: 'goat', routes })
  record('B01', 'same-plan empty protocol retains retired models', !!s.value.providers[keys.claude],
    { skipped: synced.skipped, retained: s.value.providers[keys.claude]?.models }, 'remove or deactivate the obsolete generated channel')
}
{
  const custom = { ...entry, reasoningEfforts: { high: 'custom-high' }, maxTokens: 4096 }
  const s = settings({ [keys.chat]: { models: [custom] } })
  await syncPlan({ settings: s, plan: 'goat', routes })
  record('B02', 'sync erases explicit per-model settings', !s.value.providers[keys.chat].models[0].reasoningEfforts,
    s.value.providers[keys.chat].models[0], 'retain explicit reasoning and output-cap overrides')
}
{
  const s = settings({ [keys.chat]: { api: 'anthropic-messages', models: [entry] } })
  await syncPlan({ settings: s, plan: 'goat', routes })
  const p = s.value.providers[keys.chat]
  record('B03', 'retained protocol receives incompatible default compat', p.api === 'anthropic-messages' && p.compat?.thinkingFormat === 'openai',
    { api: p.api, compat: p.compat }, 'validate defaults and model assignment against the actual retained protocol')
}
{
  const s = settings({ [keys.pro]: { apiKeyEnv: 'OTHER_ACCOUNT', models: [entry] } })
  await syncPlan({ settings: s, plan: 'goat', routes })
  await pruneGeneratedRoutes({ settings: s, plan: 'goat' })
  record('B04', 'manual tier cleanup deletes another account instance routes', !s.value.providers[keys.pro],
    Object.keys(s.value.providers), 'do not delete routes owned by another active instance/account')
}
{
  const healthy = buildEntries({ apiList: [sample], catalog }).routes.openai[0]
  const degraded = buildEntries({ apiList: [sample], catalog: [] }).routes.openai[0]
  record('B05', 'temporary capability-catalog failure removes vision', healthy.input.includes('image') && !degraded.input.includes('image'),
    { healthy: healthy.input, degraded: degraded.input }, 'preserve last-known good capabilities on a transient discovery failure')
}
{
  const input = { id: 'vendor/embedder', supportedEndpoints: ['/embeddings'] }
  const chosen = routeForModel(input)
  record('B06', 'explicit unsupported endpoints are routed to chat anyway', chosen === 'openai',
    { endpoints: input.supportedEndpoints, chosen }, 'exclude unsupported protocols and report why')
}
{
  const p = buildEntries({ apiList: [], catalog: [], extraIds: ['private/model'], maxContextWindow: 16000 }).routes.openai[0]
  record('B07', 'global context cap is not applied to private extraIds', p.contextWindow === undefined,
    p, 'private models also receive the explicit 16000-token cap')
}
{
  const p = buildEntries({ apiList: [sample], catalog, maxContextWindow: 123.5 }).routes.openai[0]
  record('B08', 'fractional context cap generates invalid provider configuration', !Number.isInteger(p.contextWindow),
    p.contextWindow, 'reject or normalize the non-integer cap before generating settings')
}

// Usage contract and numeric boundary cases.
{
  const p = await usingFetch(accountFetch((url) => url.endsWith('/summary') ? { totalCount: 100, completedCount: 1, successRate: 1 } : {}), () => fetchUsageReport('fake', 'https://offline.invalid'))
  record('B09', 'one percent success is rendered as one hundred percent', p.usage.successRate === 1,
    { rawPercentage: 1, normalizedFraction: p.usage.successRate }, 'normalize as 0.01, or derive 1/100 from the request counts')
}
{
  const p = await usingFetch(accountFetch(() => ({ error: 'account unavailable' })), () => fetchUsageReport('fake', 'https://offline.invalid'))
  record('B10', 'HTTP 200 error objects are treated as healthy zero usage', p.failures.length === 0 && p.usage?.totalCount === 0,
    { failures: p.failures, usage: p.usage }, 'report schema/upstream errors; leave unknown usage unavailable')
}
{
  let error
  try {
    await usingFetch(accountFetch((url) => url.endsWith('/subscriptions') ? { data: { planId: 'individual-goat', currentPeriodEnd: 1e20 } } : {}), () => fetchUsageReport('fake', 'https://offline.invalid'))
  } catch (failure) { error = failure.name }
  record('B11', 'out-of-range subscription timestamp crashes the whole usage report', error === 'RangeError',
    error ?? 'no exception', 'ignore the bad date while preserving valid endpoint data')
}
{
  const webServer = server()
  const config = { autoSync: false, enableBridge: true, targetApiKeyEnv: 'OLD_ACCOUNT' }
  const h = host({ webServer, credentials: { resolve: async () => ({ value: 'fake' }) } })
  apply(h.ctx, config)
  const usage = webServer.routes.find((r) => r.path.endsWith('/usage'))
  const describe = webServer.routes.find((r) => r.path.endsWith('/describe'))
  let release, started
  const begun = new Promise((r) => { started = r })
  const wait = new Promise((r) => { release = r })
  await usingFetch(async (url) => {
    if (String(url).endsWith('/whoami')) { started(); await wait }
    return { ok: true, status: 200, json: async () => String(url).endsWith('/subscriptions') ? { data: { planId: 'individual-goat' } } : {} }
  }, async () => {
    const pending = drive(usage)
    await begun
    config.targetApiKeyEnv = 'NEW_ACCOUNT'
    h.emit('loader/volatile-update')
    release()
    await pending
    const status = await drive(describe)
    record('B12', 'late usage read publishes previous-account subscription under new credentials', status.value.subscription?.planId === 'individual-goat' && status.value.apiKeyEnv === 'NEW_ACCOUNT',
      { env: status.value.apiKeyEnv, subscription: status.value.subscription }, 'discard account results when their credential/config generation is no longer current')
  })
  h.dispose()
}

// Search lifecycle and payload validation.
{
  let provider, signal, release, started
  const begun = new Promise((r) => { started = r })
  const wait = new Promise((r) => { release = r })
  const web = { registerSearchProvider(p) { provider = p; return () => {} } }
  const h = host({ web, credentials: { resolve: async () => ({ value: 'fake' }) } })
  apply(h.ctx, Config({ autoSync: false, webSearch: true }))
  const caller = new AbortController()
  await usingFetch(async (_url, init) => {
    signal = init.signal
    started()
    await wait
    return { ok: true, json: async () => ({ results: [] }) }
  }, async () => {
    const pending = provider.search({ query: 'offline audit' }, caller.signal)
    await begun
    h.dispose()
    record('B13', 'unloading the plugin does not cancel an active web search', !signal?.aborted,
      { signalProvided: !!signal, aborted: signal?.aborted ?? false }, 'link the search call to plugin lifetime cancellation')
    release()
    await pending
  })
}
{
  const provider = makeSearchProvider({ isEnabled: () => true, apiBase: () => 'https://offline.invalid', keyEnv: () => 'FAKE', resolveKey: async () => 'fake' })
  const p = await usingFetch(async () => ({ ok: true, json: async () => ({ error: 'quota exceeded' }) }), () => provider.search({ query: 'offline audit' }))
  record('B14', 'HTTP 200 search error becomes a successful empty result', p.sources.length === 0,
    p, 'report the quota/schema failure instead of claiming no search results')
}

// Exercise the actual browser controller through its registered slot face.
let registration
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
new Function('window', source)({ __ModuleLoader__: { load(value) { registration = value } } })
const exports = registration.factory((name) => { if (name === 'react') return {}; throw new Error(name) })
{
  const fields = [...exports.__internals.TEXT_FIELDS.map((x) => x.key), ...exports.__internals.BOOL_FIELDS]
  const missing = ['recoverUpstreamOverflow', 'contextGuardRatio', 'maxContextWindow'].filter((name) => !fields.includes(name))
  record('B15', 'custom settings card omits all context-protection controls', missing.length === 3,
    missing, 'expose these controls or provide a working route to the full host form')
}
{
  const effects = [], slots = [], dictionaries = {}
  let release, started
  const begun = new Promise((r) => { started = r })
  const wait = new Promise((r) => { release = r })
  const state = { value: { plan: 'goat', autoSync: false }, user: {} }
  const scope = { getSnapshot: () => state, subscribe: () => () => {},
    async set(key, value) { started(); await wait; state.value[key] = value; return true }, unset: async () => true }
  const ctx = { effect(fn) { const dispose = fn(); effects.push(dispose); return dispose },
    locale: { register(ns, value) { dictionaries[ns] = value }, bind: (ns) => (key) => dictionaries[ns]?.zh?.[key] ?? key },
    configForms: { get: () => scope }, slots: { inject(_name, fn) { fn() }, register(options) { slots.push(options); return () => {} } } }
  await usingFetch(async (url) => ({ ok: true, json: async () => ({ ok: true, value: String(url).endsWith('/describe') ? { entryId: 'commandcode-goat' } : {} }) }), async () => {
    exports.apply(ctx)
    await tick()
    const face = slots[0].inject()
    face.actions.edit('plan', 'pro')
    const pending = face.actions.save()
    await begun
    for (const dispose of [...effects].reverse()) dispose?.()
    const before = face.store.getSnapshot()
    release()
    await pending
    const after = face.store.getSnapshot()
    record('B16', 'save completion mutates an already disposed settings controller', after !== before && after.phase === 'saved',
      { before: before.phase, after: after.phase }, 'ignore late save/reset completions after disposal')
  })
}

const upstreamArgument = process.argv.find((argument) => argument.startsWith('--upstream-catalog='))
if (upstreamArgument) {
  // Optional: Node 22+ can strip the annotations from this reviewed pure
  // function. This does not load an upstream package or exercise its runtime.
  const upstream = await readFile(upstreamArgument.slice('--upstream-catalog='.length), 'utf8')
  const start = upstream.indexOf('function resolveModelReasoning(')
  const end = upstream.indexOf('\n}', start) + 2
  if (start < 0 || end <= start) throw new Error('Upstream reasoning resolver not found')
  const { stripTypeScriptTypes } = await import('node:module')
  const resolver = new Function(`${stripTypeScriptTypes(upstream.slice(start, end))}\nreturn resolveModelReasoning`)()
  const model = buildEntries({ apiList: [sample], catalog }).routes.openai[0]
  const resolved = resolver(keys.chat, model, undefined)
  record('B17', 'reasoning model on a custom provider resolves as non-reasoning by default',
    resolved.reasoning === false, { generated: model, upstreamResolved: resolved },
    'declare verified model reasoning capabilities; route compat cannot substitute for model capability')
}

for (const result of results) console.log(JSON.stringify(result))
console.log(JSON.stringify({ checks: results.length, reproduced: results.filter((r) => r.reproduced).length,
  node: process.version, note: 'Offline audit evidence, not live-provider or real-browser verification.' }))
// Optional snapshot assertion; after fixes, normal runs should simply report
// which historical problems no longer reproduce rather than fail CI for them.
if (process.argv.includes('--assert-snapshot') && results.some((r) => !r.reproduced)) process.exitCode = 1
