import { probeRequest, probeRoutes } from './probe.js'
import { routeRequestURL } from './catalog.js'
import { deadline, abortable } from './cancellation.js'

export const DIAGNOSTIC_MODES = ['connection', 'stream', 'tools']
export const routeForProtocol = (api) => ({ 'openai-completions': 'openai', 'openai-responses': 'responses', 'anthropic-messages': 'anthropic' })[api]
const MAX_BYTES = 1024 * 1024
const TOOL = 'diagnostic_ping'

function terminalStream(text) {
  return text.split(/\r?\n\r?\n/).slice(0, -1).some((frame) => {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n').trim()
    if (data === '[DONE]') return true
    try {
      const payload = JSON.parse(data)
      return ['message_stop', 'response.completed', 'response.failed', 'response.incomplete', 'error'].includes(payload.type)
        || payload.choices?.some((choice) => typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0)
    } catch { return false }
  })
}

async function limitedText(response, signal, stream = false) {
  if (!response.body?.getReader) {
    const text = await abortable(response.text(), signal)
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('diagnostic response exceeded 1 MiB')
    return text
  }
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let text = '', bytes = 0
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal)
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_BYTES) throw new Error('diagnostic response exceeded 1 MiB')
      text += decoder.decode(value, { stream: true })
      if (stream && terminalStream(text)) break
    }
    return text + decoder.decode()
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

function toolRequest(route, body) {
  const schema = { type: 'object', properties: {}, additionalProperties: false }
  const description = 'A diagnostic-only ping. Call this tool once with empty arguments. It will not be executed.'
  if (route === 'anthropic') {
    body.tools = [{ name: TOOL, description, input_schema: schema }]
    body.tool_choice = { type: 'tool', name: TOOL }
  } else if (route === 'responses') {
    body.tools = [{ type: 'function', name: TOOL, description, parameters: schema }]
    body.tool_choice = { type: 'function', name: TOOL }
  } else {
    body.tools = [{ type: 'function', function: { name: TOOL, description, parameters: schema } }]
    body.tool_choice = { type: 'function', function: { name: TOOL } }
  }
}

function receivedTool(route, payload) {
  if (route === 'anthropic') return payload?.content?.some((part) => part.type === 'tool_use' && part.name === TOOL && part.input && typeof part.input === 'object' && !Array.isArray(part.input) && Object.keys(part.input).length === 0) === true
  const calls = route === 'responses' ? payload?.output : payload?.choices?.[0]?.message?.tool_calls
  return Array.isArray(calls) && calls.some((call) => {
    const name = route === 'responses' ? call.name : call.function?.name
    const args = route === 'responses' ? call.arguments : call.function?.arguments
    if (name !== TOOL) return false
    try { const value = JSON.parse(args); return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0 }
    catch { return false }
  })
}

/** Exactly one explicit diagnostic request; tools are inspected, never executed. */
export async function diagnoseModel(target) {
  const { route, mode = 'connection', signal, apiKey, timeoutMs = 30000 } = target
  if (!DIAGNOSTIC_MODES.includes(mode)) throw new TypeError('unknown diagnostic mode')
  if (!apiKey) throw new Error('no credential configured for this model route')
  const clean = (value) => {
    let text = String(value ?? '')
    for (const secret of [apiKey, ...Object.entries(target.headers ?? {}).filter(([name]) => /auth|key|token|secret/i.test(name)).map(([, value]) => value)]) {
      if (typeof secret === 'string' && secret) text = text.split(secret).join('[redacted]')
    }
    return text.slice(0, 300)
  }
  if (mode === 'connection') {
    const [result] = await probeRoutes({ targets: [target], signal, timeoutMs, fetch: target.fetch })
    return { ...result, detail: clean(result.detail), mode, requests: 1, scope: 'HTTP connectivity only' }
  }
  const operation = deadline(timeoutMs, signal)
  const started = Date.now()
  try {
    const request = probeRequest({ route, model: target.model, key: apiKey })
    const body = JSON.parse(request.body)
    if (route === 'responses') body.max_output_tokens = 256
    else body.max_tokens = 256
    body.stream = mode === 'stream'
    if (mode === 'tools') toolRequest(route, body)
    const response = await abortable((target.fetch ?? fetch)(routeRequestURL(route, target.baseURL), {
      method: 'POST', redirect: 'manual', headers: { ...target.headers, ...request.headers,
        accept: mode === 'stream' ? 'text/event-stream' : 'application/json' },
      body: JSON.stringify(body), signal: operation.signal,
    }), operation.signal)
    const text = await limitedText(response, operation.signal, mode === 'stream')
    const status = Number(response.status)
    if (!(status >= 200 && status < 300)) return { mode, model: target.model, ok: false, status, detail: clean(text), ms: Date.now() - started, requests: 1 }
    if (mode === 'tools') {
      const payload = JSON.parse(text)
      const ok = receivedTool(route, payload)
      return { mode, model: target.model, ok, status, ms: Date.now() - started, requests: 1,
        detail: ok ? 'Received a valid diagnostic tool call; no tool was executed.' : 'No valid diagnostic tool call was returned.' }
    }
    let events = 0, terminal = false, content = false, failed = false
    for (const frame of text.split(/\r?\n\r?\n/)) {
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n').trim()
      if (data === '[DONE]') { terminal = true; continue }
      if (!data) continue
      let payload
      try { payload = JSON.parse(data) } catch { throw new Error('invalid JSON in diagnostic event stream') }
      events++
      const type = payload.type
      if (type === 'message_stop' || type === 'response.completed') terminal = true
      if (payload.choices?.some((choice) => typeof choice.finish_reason === 'string' && choice.finish_reason)) terminal = true
      if (type === 'error' || type === 'response.failed' || type === 'response.incomplete' || payload.error) failed = true
      if (payload.choices?.some((choice) => choice.delta?.content || choice.delta?.reasoning_content || choice.delta?.tool_calls)
        || type === 'content_block_delta' || type === 'response.output_text.delta' || type === 'response.reasoning_text.delta') content = true
    }
    return { mode, model: target.model, ok: terminal && content && !failed, status, ms: Date.now() - started, requests: 1,
      events, terminal, detail: terminal && content && !failed ? 'Received content and a terminal stream event.' : 'The stream was empty, incomplete, or ended with an error.' }
  } catch (error) {
    return { mode, model: target.model, ok: false, ms: Date.now() - started, requests: 1,
      code: signal?.aborted ? 'cancelled' : operation.signal.reason?.name === 'TimeoutError' ? 'timeout' : 'diagnostic-failed', detail: clean(error.message) }
  } finally { operation.release() }
}
