import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * dsh 0.2.1-rc.2 keeps its HMR AsyncLocalStorage marker in descendant promises,
 * even after disposal has finished. A microtask/timer alone still counts as a
 * nested transaction. Exit that marker before queuing a separate settings edit.
 * `executing` is a feature-detected compatibility seam, not a public dsh API;
 * hosts without it use their normal settings scheduler.
 */
export function outsideReload(hmr, task) {
  hmr = typeof hmr === 'function' ? hmr() : hmr
  const scope = hmr?.executing
  return typeof scope?.exit === 'function' ? scope.exit(task) : task()
}

/**
 * The 0.2.1 plugin manager holds package.json.lock while it reconciles the
 * Loader. Queuing an HMR settings edit before that writer finishes can block
 * the writer's final HMR work behind an edit waiting for its own file lock.
 * Wait before entering HMR, rather than occupying its queue while locked.
 */
export async function waitForProfileWriter(document, timeoutMs = 15000) {
  if (typeof document !== 'string') return
  const lock = join(dirname(document), 'package.json.lock')
  const until = Date.now() + timeoutMs
  while (true) {
    try { await access(lock) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    if (Date.now() >= until) throw new Error('profile writer remained locked; generated-provider backup was retained')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
