import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { piAiSection } from './pi-ai.js'
import { parseGeneratedKey } from './plans.js'
import { outsideReload, waitForProfileWriter } from './host-scheduling.js'

// Multiple rows can publish different tiers into the same settings service.
// Keep their routes until the final row stops, and serialize stop/start work.
// HMR can load a second module instance before the first cleanup finishes.
// Share coordination by profile path across those module instances/services.
const registryKey = Symbol.for('dsh-commandcode-goat/provider-lifecycle/v1')
const hosts = globalThis[registryKey] ??= { files: new Map(), memory: new WeakMap() }

export function providerLifecycle(settings, options = {}) {
  const document = typeof settings.documentPath === 'string' ? settings.documentPath : undefined
  const registry = document ? hosts.files : hosts.memory
  const identity = document ?? settings
  let host = registry.get(identity)
  if (host === undefined) {
    host = { owners: new Set(), pending: Promise.resolve(), saved: {} }
    registry.set(identity, host)
  }
  const owner = { keys: options.keys ? new Set(options.keys) : null }
  host.owners.add(owner)
  const owned = (key) => owner.keys === null || owner.keys.has(key)
  const protectedByOthers = (key) => [...host.owners].some((other) => other !== owner && (other.keys === null || other.keys.has(key)))
  const enqueue = (task) => {
    const result = outsideReload(options.hmr, () => host.pending.then(task))
    host.pending = result.catch(() => {})
    return result
  }
  // The native patch path identifies the profile. Keep a private sidecar so
  // disable/re-enable and normal restarts preserve hand-edited route options.
  const file = document ? `${document}.commandcode-goat-backup.json` : undefined
  const section = () => {
    const selected = piAiSection(settings)
    return settings.describe({ redactSecrets: false }).find((entry) => entry.ns === selected?.ns)
  }
  const save = async () => {
    if (file === undefined) return
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, JSON.stringify(host.saved), { mode: 0o600, flag: 'wx' })
      await rename(temp, file)
    } finally { await unlink(temp).catch(() => {}) }
  }
  const restore = () => enqueue(async () => {
    if (file !== undefined) {
      try { host.saved = JSON.parse(await readFile(file, 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    if (host.saved === null || typeof host.saved !== 'object' || Array.isArray(host.saved)) {
      throw new Error('invalid generated-provider backup')
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!host.owners.has(owner)) return
      const current = section()
      if (current === undefined || settings.writable === false) return
      const ops = Object.entries(host.saved)
        .filter(([key]) => owned(key) && parseGeneratedKey(key) !== undefined && current.value?.providers?.[key] === undefined)
        .map(([key, value]) => ({ op: 'set', path: ['providers', key], value }))
      const consume = async () => {
        for (const key of Object.keys(host.saved)) if (owned(key)) delete host.saved[key]
        await save()
      }
      if (ops.length === 0) { if (Object.keys(host.saved).some(owned)) await consume(); return }
      try { await waitForProfileWriter(document); await settings.mutate(String(current.ns), ops, current.revision); await consume(); return }
      catch (error) { if (error.code !== 'SETTINGS_CONFLICT' || attempt === 1) throw error }
    }
  })
  const ready = restore()
  let stopped
  return {
    ready,
    restore,
    claim(keys) { if (owner.keys) for (const key of keys) owner.keys.add(key) },
    protectedKeys() {
      const current = section()
      return Object.keys(current?.value?.providers ?? {}).filter(protectedByOthers)
    },
    failureMessage(error) {
      let message = String(error?.message ?? error)
      for (const profile of Object.values(host.saved)) for (const value of Object.values(profile?.headers ?? {})) {
        if (typeof value === 'string' && value) message = message.split(value).join('[redacted]')
      }
      return message.slice(0, 300)
    },
    stop() {
      if (stopped !== undefined) return stopped
      host.owners.delete(owner)
      stopped = enqueue(async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const current = section()
          if (current === undefined || settings.writable === false) return
          // Take an unredacted snapshot before removal; headers may carry secrets.
          // Never delete routes unless the recoverable backup was saved first.
          const profiles = Object.fromEntries(Object.entries(current.value?.providers ?? {})
            .filter(([key]) => owned(key) && !protectedByOthers(key) && parseGeneratedKey(key) !== undefined))
          if (Object.keys(profiles).length === 0) return
          if (!file && options.allowMemoryBackup !== true) throw new Error('No persistent profile path; generated providers were preserved to avoid losing custom configuration')
          host.saved = { ...host.saved, ...profiles }
          await save()
          const ops = Object.keys(profiles).filter((key) => !protectedByOthers(key)).map((key) => ({ op: 'unset', path: ['providers', key] }))
          if (!ops.length) return
          try { await waitForProfileWriter(document); await settings.mutate(String(current.ns), ops, current.revision); return }
          catch (error) { if (error.code !== 'SETTINGS_CONFLICT' || attempt === 1) throw error }
        }
      })
      return stopped
    },
  }
}
