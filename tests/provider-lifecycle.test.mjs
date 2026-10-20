import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtemp, readFile, rm, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { providerLifecycle as createProviderLifecycle } from '../lib/provider-lifecycle.js'
import { AsyncLocalStorage } from 'node:async_hooks'

const key = 'commandcode-goat-autosync'
// Pure ownership tests use an explicitly ephemeral store. Production requires disk.
const providerLifecycle = (service, options = {}) => createProviderLifecycle(service, { allowMemoryBackup: true, ...options })
const profile = { api: 'openai-completions', apiKeyEnv: 'MY_KEY', baseURL: 'https://custom.example/v1',
  modelOverrides: { test: { contextWindow: 100000 } }, headers: { 'x-private': 'private-value' } }

function settings(providers, documentPath) {
  const service = {
    documentPath,
    value: { providers: structuredClone(providers) },
    revision: 0,
    writes: [],
    describe({ redactSecrets } = {}) {
      const value = structuredClone(this.value)
      if (redactSecrets && value.providers[key]?.headers) value.providers[key].headers['x-private'] = '[redacted]'
      return [{ ns: 'renamed-provider-row', schema: { dict: { providers: {} } }, value, revision: this.revision }]
    },
    async mutate(ns, ops, revision) {
      assert.equal(ns, 'renamed-provider-row')
      assert.equal(revision, this.revision)
      this.writes.push(ops)
      this.beforeWrite?.(ops)
      for (const op of ops) {
        if (op.op === 'unset') delete this.value.providers[op.path[1]]
        else this.value.providers[op.path[1]] = structuredClone(op.value)
      }
      this.revision += 1
    },
  }
  return service
}

describe('generated provider lifecycle', () => {
  it('lets a plugin-manager writer finish before entering a settings transaction', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'goat-writer-'))
    try {
      const service = settings({ [key]: profile }, join(folder, 'cordis.patch.yml'))
      const lifecycle = providerLifecycle(service)
      await lifecycle.ready
      await writeFile(join(folder, 'package.json.lock'), 'fixture writer')
      const stopped = lifecycle.stop()
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(service.writes.length, 0)
      await unlink(join(folder, 'package.json.lock'))
      await stopped
      assert.equal(service.value.providers[key], undefined)
    } finally { await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }) }
  })
  it('looks up HMR at disposal because the service may mount after the plugin', async () => {
    let hmr
    const executing = new AsyncLocalStorage()
    const service = settings({ [key]: profile })
    service.beforeWrite = () => assert.notEqual(executing.getStore(), true)
    const lifecycle = providerLifecycle(service, { hmr: () => hmr })
    await lifecycle.ready
    hmr = { executing }
    await executing.run(true, () => lifecycle.stop())
    assert.equal(service.value.providers[key], undefined)
  })
  it('preserves customized providers when no persistent backup path exists', async () => {
    const service = settings({ [key]: profile })
    const lifecycle = createProviderLifecycle(service)
    await lifecycle.ready
    await assert.rejects(lifecycle.stop(), /No persistent profile path/)
    assert.deepEqual(service.value.providers[key], profile)
  })
  it('queues cleanup outside the inherited HMR transaction scope', async () => {
    const executing = new AsyncLocalStorage()
    const service = settings({ [key]: profile })
    const mutate = service.mutate.bind(service)
    service.mutate = (...args) => {
      assert.notEqual(executing.getStore(), true, 'nested HMR transaction')
      return mutate(...args)
    }
    await executing.run(true, async () => {
      const lifecycle = providerLifecycle(service, { hmr: { executing } })
      await lifecycle.ready
      await lifecycle.stop()
    })
    assert.deepEqual(service.value.providers, {})
  })

  it('consumes a restored backup so a later deliberate deletion stays deleted', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'goat-consume-'))
    try {
      const path = join(folder, 'profile.yaml')
      const first = providerLifecycle(settings({ [key]: profile }, path))
      await first.ready
      await first.stop()
      const service = settings({}, path)
      const next = providerLifecycle(service)
      await next.ready
      delete service.value.providers[key]
      await next.restore()
      assert.equal(service.value.providers[key], undefined)
      const restarted = providerLifecycle(settings({}, path))
      await restarted.ready
      assert.deepEqual(JSON.parse(await readFile(`${path}.commandcode-goat-backup.json`, 'utf8')), {})
      await next.stop()
      await restarted.stop()
    } finally { await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }) }
  })

  it('cleans only this owner while keeping another active tier', async () => {
    const other = 'commandcode-pro-autosync'
    const service = settings({ [key]: profile, [other]: profile })
    const first = providerLifecycle(service, { keys: [key] })
    const second = providerLifecycle(service, { keys: [other] })
    await Promise.all([first.ready, second.ready])
    await first.stop()
    assert.equal(service.value.providers[key], undefined)
    assert.deepEqual(service.value.providers[other], profile)
    await second.stop()
    assert.deepEqual(service.value.providers, {})
  })

  it('restores after the provider section becomes available later', async () => {
    const service = settings({ [key]: profile })
    const first = providerLifecycle(service)
    await first.ready
    await first.stop()
    const describe = service.describe.bind(service)
    service.describe = () => []
    const next = providerLifecycle(service)
    await next.ready
    service.describe = describe
    await next.restore()
    assert.deepEqual(service.value.providers[key], profile)
    await next.stop()
  })
  it('removes legacy generated tiers and edited routes, preserving unrelated providers', async () => {
    const service = settings({ [key]: profile, 'commandcode-pro-anthropic': profile, custom: profile,
      'commandcode-goat-autosync-copy': profile })
    const lifecycle = providerLifecycle(service)
    await lifecycle.ready
    await lifecycle.stop()
    assert.deepEqual(Object.keys(service.value.providers).sort(), ['commandcode-goat-autosync-copy', 'custom'])
    const restored = providerLifecycle(service)
    await restored.ready
    assert.deepEqual(service.value.providers[key], profile)
    await restored.stop()
  })

  it('persists an unredacted backup and restores with a fresh service, without network or auto-sync', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'goat-lifecycle-'))
    try {
      const path = join(folder, 'profile.yaml')
      const first = providerLifecycle(settings({ [key]: profile }, path))
      await first.ready
      await first.stop()
      assert.deepEqual(JSON.parse(await readFile(`${path}.commandcode-goat-backup.json`, 'utf8')), { [key]: profile })
      const service = settings({}, path)
      const next = providerLifecycle(service)
      await next.ready
      assert.deepEqual(service.value.providers[key], profile)
      await next.stop()
    } finally { await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }) }
  })

  it('waits for the final instance and tolerates repeated disposal', async () => {
    const service = settings({ [key]: profile })
    const first = providerLifecycle(service)
    const second = providerLifecycle(service)
    await Promise.all([first.ready, second.ready])
    await first.stop()
    assert.ok(service.value.providers[key])
    await second.stop()
    await second.stop()
    assert.equal(service.writes.length, 1)
    assert.equal(service.value.providers[key], undefined)
  })

  it('does not overwrite a provider edited while the plugin was off', async () => {
    const service = settings({ [key]: profile })
    const first = providerLifecycle(service)
    await first.ready
    await first.stop()
    service.value.providers[key] = { ...profile, displayName: 'My provider' }
    const next = providerLifecycle(service)
    await next.ready
    assert.equal(service.value.providers[key].displayName, 'My provider')
    await next.stop()
  })

  it('does not remove routes if the backup cannot be written', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'goat-lifecycle-'))
    try {
      const service = settings({ [key]: profile }, join(folder, 'missing', 'profile.yaml'))
      const lifecycle = providerLifecycle(service)
      await lifecycle.ready
      await assert.rejects(lifecycle.stop(), { code: 'ENOENT' })
      assert.deepEqual(service.value.providers[key], profile)
    } finally { await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }) }
  })

  it('re-reads and backs up concurrent edits on a revision conflict', async () => {
    const service = settings({ [key]: profile })
    const lifecycle = providerLifecycle(service)
    await lifecycle.ready
    service.beforeWrite = () => {
      service.beforeWrite = undefined
      service.value.providers[key].displayName = 'Concurrent edit'
      service.revision += 1
      throw Object.assign(new Error('conflict'), { code: 'SETTINGS_CONFLICT' })
    }
    await lifecycle.stop()
    const next = providerLifecycle(service)
    await next.ready
    assert.equal(service.value.providers[key].displayName, 'Concurrent edit')
    await next.stop()
  })

  it('leaves providers intact in read-only settings', async () => {
    const service = settings({ [key]: profile })
    service.writable = false
    const lifecycle = providerLifecycle(service)
    await lifecycle.ready
    await lifecycle.stop()
    assert.deepEqual(service.value.providers[key], profile)
    assert.equal(service.writes.length, 0)
  })

  it('restores a route when re-enabled while its removal is in flight', async () => {
    const service = settings({ [key]: profile })
    const first = providerLifecycle(service)
    await first.ready
    let next
    service.beforeWrite = () => {
      service.beforeWrite = undefined
      next = providerLifecycle(service)
    }
    await first.stop()
    await next.ready
    assert.deepEqual(service.value.providers[key], profile)
    await next.stop()
  })
})
