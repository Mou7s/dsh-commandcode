/**
 * Route probing — one real request per written route.
 *
 * Why this exists. The harness's LLM adapter does not surface an HTTP status:
 * a 404, a 403 and a ten-second TCP connect timeout all arrive as a `PI_AI_ERROR`
 * with a message, and two of the three are indistinguishable by text. So every
 * check this plugin could make *downstream* of the adapter is a guess, and the
 * card could only ever say "the settings write succeeded" — which is what it
 * said while every Claude request was answering `404 Not found. Check the docs
 * for available routes.` for a month.
 *
 * A probe is the one mechanism available to a config-only plugin that can tell
 * those apart: it issues the smallest request each protocol accepts, on the URL
 * that protocol's own SDK builds, and records the status, the latency and the
 * answer's own words. It reports; it never throws, never blocks a sync and
 * never replaces what the harness will really send.
 *
 * Everything here is pure except `probeRoutes`, which takes the fetch
 * implementation as an argument so tests can drive a stub.
 */

import { routeProtocol, routeRequestURL } from './catalog.js'

/** The smallest request each protocol accepts, and how it authenticates. */
const SHAPES = {
  'openai-completions': {
    headers: (key) => ({ authorization: `Bearer ${key}`, accept: 'application/json' }),
    body: (model) => ({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16, stream: false }),
  },
  'anthropic-messages': {
    // The Anthropic client authenticates with `x-api-key`; Command Code's edge
    // also reads `Authorization`, and states that in its 401, so both are sent.
    headers: (key) => ({
      'x-api-key': key,
      authorization: `Bearer ${key}`,
      'anthropic-version': '2023-06-01',
      accept: 'application/json',
    }),
    body: (model) => ({ model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
  },
  'openai-responses': {
    headers: (key) => ({ authorization: `Bearer ${key}`, accept: 'application/json' }),
    body: (model) => ({ model, input: 'ping', max_output_tokens: 16, stream: false }),
  },
}

/** The request one route's protocol expects. */
export function probeRequest({ route, model, key }) {
  const shape = SHAPES[routeProtocol(route)]
  if (shape === undefined) throw new TypeError(`no probe shape for route ${JSON.stringify(route)}`)
  return {
    headers: { ...shape.headers(key), 'content-type': 'application/json' },
    body: JSON.stringify(shape.body(model)),
  }
}

/**
 * Turn one HTTP answer into a verdict the card can render.
 *
 * The body is kept because it is where these gateways say what they mean
 * (`MODEL_NOT_IN_PLAN: …`, `… is not a registered API route`), and truncated
 * because it is a diagnostic rather than a payload.
 */
export function describeAnswer({ route, key, model, url, status, ms, text }) {
  return {
    route,
    key,
    model,
    url,
    ok: status >= 200 && status < 300,
    status,
    ms,
    detail: String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
  }
}

/**
 * Probe every written route, in parallel.
 *
 * One route's failure never affects another's, and a probe that could not even
 * be attempted (no credential, nothing to send) comes back as `skipped` with
 * the reason rather than as a failure — the sync it belongs to already
 * succeeded, and saying otherwise would be a lie about which thing broke.
 *
 * @param request - `{ targets, apiKey, signal, timeoutMs, fetch }`. `targets` is
 *   one `{ route, key, baseURL, model }` per written route.
 * @returns one verdict per target, in the order given.
 */
export async function probeRoutes({ targets, apiKey, signal, timeoutMs = 30_000, fetch: doFetch } = {}) {
  const list = Array.isArray(targets) ? targets : []
  if (apiKey === undefined || apiKey === null || apiKey === '') {
    return list.map((target) => ({ route: target.route, key: target.key, model: target.model, skipped: 'no-credential' }))
  }
  const send = doFetch ?? globalThis.fetch
  return Promise.all(list.map(async (target) => {
    if (signal?.aborted) return { route: target.route, key: target.key, model: target.model, skipped: 'cancelled' }
    let url
    let request
    try {
      url = routeRequestURL(target.route, target.baseURL)
      request = probeRequest({ route: target.route, model: target.model, key: apiKey })
    } catch (error) {
      return {
        route: target.route,
        key: target.key,
        model: target.model,
        skipped: 'malformed',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
    const started = Date.now()
    try {
      const response = await send(url, { method: 'POST', headers: request.headers, body: request.body, signal })
      // A stub, a 204 and a body-less answer are all legitimate: the verdict is
      // about the status, and the text is only there to quote the gateway.
      const text = typeof response.text === 'function' ? await response.text().catch(() => '') : ''
      return describeAnswer({
        route: target.route,
        key: target.key,
        model: target.model,
        url,
        status: Number(response.status),
        ms: Date.now() - started,
        text,
      })
    } catch (error) {
      const ms = Date.now() - started
      // A cancelled probe is not a broken route: the plugin was unloaded or the
      // reader moved on, and drawing that as a failure would be a false alarm.
      if (signal?.aborted) return { route: target.route, key: target.key, model: target.model, skipped: 'cancelled' }
      const failure = error?.cause ?? error
      return {
        route: target.route,
        key: target.key,
        model: target.model,
        url,
        ok: false,
        status: null,
        ms,
        detail: String(failure?.message ?? error?.message ?? error).replace(/\s+/g, ' ').slice(0, 300),
        error: { kind: ms >= timeoutMs ? 'timeout' : 'network', message: String(failure?.message ?? error?.message ?? error) },
      }
    }
  }))
}
