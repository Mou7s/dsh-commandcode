// Run only against the disposable fixture profile documented in IMPLEMENTATION.
import assert from 'node:assert/strict'
const port = Number(process.argv[2] ?? 33190)
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535)
const root = `http://127.0.0.1:${port}/api/dsh-commandcode-goat`
const call = async (path, body = {}) => {
  const result = await (await fetch(root + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.value
}
const status = await call('/describe')
assert.equal(status.version, '0.8.0')
assert.equal(status.usageBaseURL, 'http://127.0.0.1:33200', 'Refusing to test a non-fixture profile')
const beforeCount = (await (await fetch('http://127.0.0.1:33200/counts')).json()).generations
await call('/manage', { action: 'preference', id: 'fixture/reasoner', preference: { favorite: true, reasoningPreset: 'deep' } })
await call('/manage', { action: 'options', options: { modelPreferences: { 'fixture/reasoner': { favorite: true, reasoningPreset: 'deep' } }, onlyFavorites: true, alertThresholds: { enabled: true } } })
const preview = await call('/sync', { dryRun: true })
assert.equal(preview.preview.diff.summary.total, 1)
await call('/sync', { previewToken: preview.preview.token })
assert.equal((await (await fetch('http://127.0.0.1:33200/counts')).json()).generations, beforeCount)
const diagnostics = []
for (const mode of ['connection', 'stream', 'tools']) {
  const result = await call('/manage', { action: 'diagnose', id: `fixture-${mode}`, route: 'openai', model: 'fixture/reasoner', mode })
  assert.equal(result.ok, true, JSON.stringify(result))
  diagnostics.push({ mode, ok: result.ok, requests: result.requests })
}
assert.equal((await (await fetch('http://127.0.0.1:33200/counts')).json()).generations, beforeCount + 3)
await call('/usage')
await call('/usage')
const state = await call('/manage', { action: 'state' })
assert.equal(state.models.filter((model) => model.published).length, 1)
assert.equal(state.notifications.filter((event) => event.type === 'quota').length, 2)
const exported = await call('/manage', { action: 'export' })
assert.equal(JSON.stringify(exported).includes('offline-validation-key'), false)
assert.equal(JSON.stringify(exported).includes('33200'), false)
const importedRatio = state.contextOptions.contextGuardRatio === 0.6 ? 0.65 : 0.6
exported.document.configuration.contextGuardRatio = importedRatio
const imported = await call('/manage', { action: 'import-preview', document: exported.document })
assert.ok(imported.changes.some((change) => change.key === 'contextGuardRatio'))
await call('/manage', { action: 'import-apply', document: exported.document, baseSignature: imported.baseSignature })
assert.equal((await call('/manage', { action: 'state' })).contextOptions.contextGuardRatio, importedRatio)
console.log(JSON.stringify({ host: 'dsh 0.2.1-rc.2', package: status.version, source: 'loopback fixtures; fake credential',
  published: 1, backgroundModelRequests: 0, diagnostics, quotaNotifications: 2, importPreviewAndApply: true }, null, 2))
