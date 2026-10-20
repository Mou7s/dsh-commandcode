import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'

const registryKey = Symbol.for('dsh-commandcode-goat/profile-state/v1')
const registry = globalThis[registryKey] ??= { cache: new Map(), memory: new WeakMap() }
const { cache, memory } = registry
const empty = () => ({ version: 1, plans: {}, notifications: [], alertState: {}, lastAccountIdentity: '' })

/** Private per-entry state. It contains generated metadata, never API keys. */
export function profileState(settings, entryId) {
  const document = settings?.documentPath
  const suffix = createHash('sha256').update(String(entryId)).digest('hex').slice(0, 16)
  const path = typeof document === 'string' ? `${document}.commandcode-goat-${suffix}.json` : undefined
  let memories
  if (!path && settings && typeof settings === 'object') {
    memories = memory.get(settings)
    if (!memories) memory.set(settings, memories = new Map())
  }
  const existing = path ? cache.get(path) : memories?.get(entryId)
  if (existing) return existing
  const state = { value: empty(), persistent: Boolean(path), error: null }
  state.ready = (async () => {
    if (!path) return
    try {
      const value = JSON.parse(await readFile(path, 'utf8'))
      if (value?.version !== 1 || !value.plans || typeof value.plans !== 'object' || Array.isArray(value.plans)
        || !Array.isArray(value.notifications) || value.alertState && (typeof value.alertState !== 'object' || Array.isArray(value.alertState))) throw new Error('unsupported saved plugin state')
      state.value = { ...empty(), ...value }
    } catch (error) { if (error.code !== 'ENOENT') state.error = error.message }
  })()
  let pending = state.ready
  state.update = (transform) => {
    const job = pending.then(async () => {
      const next = transform(structuredClone(state.value))
      if (!next || next.version !== 1) throw new Error('invalid plugin state update')
      state.value = next
      if (!path) return next
      const temp = `${path}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' })
        await rename(temp, path)
        state.error = null
      } catch (error) {
        state.error = error.message
        await unlink(temp).catch(() => {})
        throw error
      }
      return next
    })
    pending = job.catch(() => {})
    return job
  }
  if (path) cache.set(path, state)
  else memories?.set(entryId, state)
  return state
}
