import assert from 'node:assert/strict'
import { it } from 'node:test'
import { diagnoseModel } from '../lib/diagnostics.js'

const target = { route: 'openai', model: 'fixture', key: 'provider-id', apiKey: 'fake-secret', baseURL: 'http://localhost:1/v1', timeoutMs: 100 }

it('finishes at a complete SSE terminal frame even if the server keeps the socket open', async () => {
  let cancelled = false
  const result = await diagnoseModel({ ...target, mode: 'stream', fetch: async (url, request) => {
    assert.equal(request.headers.authorization, 'Bearer fake-secret')
    assert.equal(JSON.parse(request.body).stream, true)
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n'))
    }, cancel() { cancelled = true } }), { status: 200 })
  } })
  assert.equal(result.ok, true)
  assert.equal(result.requests, 1)
  assert.equal(cancelled, true)
})

it('rejects truncated and invalid event streams', async () => {
  for (const text of ['data: {"choices":[{"delta":{"content":"pong"}}]}\n\n', 'data: invalid\n\ndata: [DONE]\n\n']) {
    const result = await diagnoseModel({ ...target, mode: 'stream', fetch: async () => new Response(text) })
    assert.equal(result.ok, false)
  }
})

it('finishes on an OpenAI finish_reason even when no DONE frame or connection close follows', async () => {
  let cancelled = false
  const result = await diagnoseModel({ ...target, mode: 'stream', fetch: async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'))
    },
    cancel() { cancelled = true },
  })) })
  assert.equal(result.ok, true)
  assert.equal(cancelled, true)
})

it('validates tool calls for all three protocols without executing any tool', async () => {
  const payloads = {
    openai: { choices: [{ message: { tool_calls: [{ function: { name: 'diagnostic_ping', arguments: '{}' } }] } }] },
    responses: { output: [{ type: 'function_call', name: 'diagnostic_ping', arguments: '{}' }] },
    anthropic: { content: [{ type: 'tool_use', name: 'diagnostic_ping', input: {} }] },
  }
  for (const [route, payload] of Object.entries(payloads)) {
    let requests = 0
    const result = await diagnoseModel({ ...target, route, mode: 'tools', fetch: async (url, request) => {
      requests++
      assert.equal(JSON.parse(request.body).tools.length, 1)
      return Response.json(payload)
    } })
    assert.equal(result.ok, true, route)
    assert.equal(requests, 1)
  }
})

it('redacts credentials in connection and generation errors', async () => {
  for (const mode of ['connection', 'stream', 'tools']) {
    const result = await diagnoseModel({ ...target, mode, headers: { 'x-private-token': 'private-value' },
      fetch: async () => new Response('fake-secret private-value', { status: 401 }) })
    assert.equal(result.ok, false)
    assert.equal(result.detail.includes('fake-secret'), false)
    assert.equal(result.detail.includes('private-value'), false)
  }
})

it('cancels a pending stream and distinguishes deadline expiry', async () => {
  const pending = async () => new Response(new ReadableStream({ start() {} }))
  const controller = new AbortController()
  const operation = diagnoseModel({ ...target, mode: 'stream', signal: controller.signal, fetch: pending })
  controller.abort()
  assert.equal((await operation).code, 'cancelled')
  assert.equal((await diagnoseModel({ ...target, mode: 'stream', timeoutMs: 5, fetch: pending })).code, 'timeout')
})
