import assert from 'node:assert/strict'
import { it } from 'node:test'
import { syncPlan } from '../lib/pi-ai.js'
import { buildEntries } from '../lib/catalog.js'
import { fetchUsageReport } from '../lib/usage.js'
import { makeSearchProvider, mapSearchPayload } from '../lib/search.js'

const routes = { openai: [{ id: 'vendor/a', input: ['text'] }], anthropic: [], responses: [] }
function settings(providers) {
  return { value: { providers }, revision: 0,
    describe() { return [{ ns: 'llm-pi-ai', value: this.value, revision: this.revision }] },
    async mutate(ns, ops) {
      for (const op of ops) {
        let parent = this.value
        for (const key of op.path.slice(0, -1)) parent = parent[key] ??= {}
        if (op.op === 'unset') delete parent[op.path.at(-1)]
        else parent[op.path.at(-1)] = op.value
      }
      this.revision++
    } }
}
it('B01 removes an obsolete same-plan protocol channel in the sync transaction', async () => {
  const service = settings({ 'commandcode-goat-anthropic': { api: 'anthropic-messages', models: [{ id: 'retired' }] } })
  await syncPlan({ settings: service, plan: 'goat', routes })
  assert.equal(service.value.providers['commandcode-goat-anthropic'], undefined)
  assert.ok(service.value.providers['commandcode-goat-autosync'])
  assert.equal(service.revision, 1)
})
it('B03 refuses a retained protocol mismatch before any settings mutation', async () => {
  const service = settings({ 'commandcode-goat-autosync': { api: 'anthropic-messages', models: [] } })
  await assert.rejects(syncPlan({ settings: service, plan: 'goat', routes }), { code: 'protocol-conflict' })
  assert.equal(service.revision, 0)
})
it('B06/B07/B08 reject unsupported endpoints and fractional caps, including private model caps', () => {
  const result = buildEntries({ apiList: [{ id: 'embed', supportedEndpoints: ['/embeddings'] }], catalog: [], extraIds: ['private'], maxContextWindow: 16000 })
  assert.deepEqual(result.routes.openai.map((model) => model.id), ['private'])
  assert.equal(result.routes.openai[0].contextWindow, 16000)
  assert.throws(() => buildEntries({ apiList: [], maxContextWindow: 123.5 }), /integer/)
})
it('does not silently bind a renamed model to an ambiguous display name', () => {
  const result = buildEntries({ apiList: [{ id: 'renamed', name: 'Shared' }], catalog: [
    { id: 'first', name: 'Shared', vision: true }, { id: 'second', name: 'Shared', vision: false },
  ] })
  assert.deepEqual(result.routes.openai, [])
  assert.ok(result.diagnostics.some((message) => message.includes('ambiguous')))
})
it('B09/B10/B11 keep percent units, reject 200 error bodies and tolerate invalid dates', async () => {
  const before = fetch
  globalThis.fetch = async (url) => Response.json(String(url).endsWith('/summary') ? { totalCount: 100, completedCount: 1, successRate: 1 }
    : String(url).endsWith('/subscriptions') ? { data: { planId: 'individual-goat', currentPeriodEnd: 1e20 } } : { error: 'fixture error' })
  try {
    const report = await fetchUsageReport('fake', 'http://localhost:1')
    assert.equal(report.usage.successRate, 0.01)
    assert.ok(report.failures.length >= 2)
    assert.equal(report.credits, undefined)
  } finally { globalThis.fetch = before }
})
it('B13 cancels a search on plugin lifetime even when a fetch ignores its signal', async () => {
  const lifetime = new AbortController(), before = fetch
  let start
  const started = new Promise((resolve) => { start = resolve })
  globalThis.fetch = async () => { start(); return new Promise(() => {}) }
  try {
    const provider = makeSearchProvider({ apiBase: () => 'http://localhost:1', keyEnv: () => 'FAKE', resolveKey: async () => 'fake', isEnabled: () => true, signal: lifetime.signal })
    const pending = provider.search({ query: 'fixture' })
    await started
    lifetime.abort()
    await assert.rejects(pending, /aborted/)
  } finally { globalThis.fetch = before }
})
it('B14 distinguishes an upstream error from empty results and excludes unsafe source URLs', async () => {
  const before = fetch
  globalThis.fetch = async () => Response.json({ error: 'fixture error' })
  try {
    const provider = makeSearchProvider({ apiBase: () => 'http://localhost:1', keyEnv: () => 'FAKE', resolveKey: async () => 'fake', isEnabled: () => true })
    await assert.rejects(provider.search({ query: 'fixture' }), /unexpected body/)
    assert.deepEqual(mapSearchPayload({ results: [{ url: 'javascript:alert(1)' }, { url: 'https://example.com' }] }).sources.map((source) => source.url), ['https://example.com'])
  } finally { globalThis.fetch = before }
})
