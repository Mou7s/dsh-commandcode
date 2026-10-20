/** Node 20-compatible deadline that also covers credential resolution and body reads. */
export function deadline(timeoutMs, ...signals) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2 ** 31 - 1) throw new TypeError('invalid request timeout')
  const controller = new AbortController()
  const sources = signals.filter(Boolean)
  const callbacks = []
  const timer = setTimeout(() => controller.abort(new DOMException('Request deadline exceeded', 'TimeoutError')), timeoutMs)
  for (const signal of sources) {
    const abort = () => controller.abort(signal.reason)
    if (signal.aborted) abort()
    else { signal.addEventListener('abort', abort, { once: true }); callbacks.push([signal, abort]) }
  }
  return { signal: controller.signal, release() {
    clearTimeout(timer)
    for (const [signal, abort] of callbacks) signal.removeEventListener('abort', abort)
  } }
}

export function abortable(promise, signal) {
  if (signal?.aborted) {
    // The work may already have rejected synchronously while aborting its
    // signal. Observe it even though cancellation wins the returned promise.
    Promise.resolve(promise).catch(() => {})
    return Promise.reject(signal.reason)
  }
  if (!signal) return Promise.resolve(promise)
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then((value) => {
      signal.removeEventListener('abort', abort); resolve(value)
    }, (error) => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
