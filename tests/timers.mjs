// Early Node 20 has no mock.timers. Keep the cadence tests executable there.
export function enableTimeouts(t) {
  if (t.mock.timers) {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    return t.mock.timers
  }
  let now = 0
  let id = 0
  const pending = new Map()
  t.mock.method(globalThis, 'setTimeout', (callback, delay = 0, ...args) => {
    const key = ++id
    pending.set(key, { at: now + delay, callback: () => callback(...args) })
    return key
  })
  t.mock.method(globalThis, 'clearTimeout', (key) => pending.delete(key))
  return {
    tick(amount) {
      const end = now + amount
      while (true) {
        const next = [...pending.entries()].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (!next) break
        now = next[1].at
        pending.delete(next[0])
        next[1].callback()
      }
      now = end
    },
  }
}
