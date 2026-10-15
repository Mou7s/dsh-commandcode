import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { describeAnswer, probeRequest, probeRoutes } from '../lib/probe.js'

/** A fetch stand-in that answers from a table keyed by URL. */
function stubFetch(answers) {
  const seen = []
  const fetch = async (url, init) => {
    seen.push({ url, init })
    const answer = answers[url] ?? answers.default
    if (answer === undefined) throw new Error(`no stub for ${url}`)
    if (typeof answer === 'function') return answer(url, init)
    return {
      status: answer.status ?? 200,
      text: async () => answer.text ?? '{"ok":true}',
    }
  }
  return { fetch, seen }
}

const TARGETS = [
  { route: 'openai', key: 'commandcode-goat-autosync', baseURL: 'https://api.commandcode.ai/provider/v1', model: 'vendor/model-one' },
  { route: 'anthropic', key: 'commandcode-goat-anthropic', baseURL: 'https://api.commandcode.ai/provider', model: 'claude-sonnet-5-5' },
]

describe('probeRequest', () => {
  it('shapes a request per protocol', () => {
    const openai = probeRequest({ route: 'openai', model: 'm', key: 'K' })
    assert.equal(openai.headers.authorization, 'Bearer K')
    assert.deepEqual(JSON.parse(openai.body), { model: 'm', messages: [{ role: 'user', content: 'ping' }], max_tokens: 16, stream: false })

    const anthropic = probeRequest({ route: 'anthropic', model: 'm', key: 'K' })
    assert.equal(anthropic.headers['x-api-key'], 'K')
    assert.equal(anthropic.headers['anthropic-version'], '2023-06-01')
    assert.deepEqual(JSON.parse(anthropic.body), { model: 'm', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] })

    const responses = probeRequest({ route: 'responses', model: 'm', key: 'K' })
    assert.deepEqual(JSON.parse(responses.body), { model: 'm', input: 'ping', max_output_tokens: 16, stream: false })
  })
})

describe('probeRoutes', () => {
  it('asks each route on the URL its own protocol builds', async () => {
    // The Claude route is the whole point: its base is the API root, and the
    // path `/v1/messages` is what the Anthropic client appends. Probing the
    // versioned base here is exactly the mistake that broke every Claude model.
    const { fetch, seen } = stubFetch({ default: { status: 200, text: '{"ok":true}' } })
    const verdicts = await probeRoutes({ targets: TARGETS, apiKey: 'K', fetch })
    assert.deepEqual(seen.map((call) => call.url), [
      'https://api.commandcode.ai/provider/v1/chat/completions',
      'https://api.commandcode.ai/provider/v1/messages',
    ])
    assert.deepEqual(verdicts.map((verdict) => verdict.ok), [true, true])
    assert.deepEqual(verdicts.map((verdict) => verdict.status), [200, 200])
  })

  it('reports a 404 as a missing path, with the gateway\u2019s own words', async () => {
    const { fetch } = stubFetch({
      'https://api.commandcode.ai/provider/v1/messages': {
        status: 404,
        text: '{"success":false,"message":"404 Not found. Check the docs for available routes."}',
      },
      default: { status: 200 },
    })
    const [openai, anthropic] = await probeRoutes({ targets: TARGETS, apiKey: 'K', fetch })
    assert.equal(openai.ok, true)
    assert.equal(anthropic.ok, false)
    assert.equal(anthropic.status, 404)
    assert.match(anthropic.detail, /not a registered API route|Not found/)
  })

  it('never lets one route\u2019s failure hide another\u2019s answer', async () => {
    const { fetch } = stubFetch({
      'https://api.commandcode.ai/provider/v1/chat/completions': () => { throw new Error('fetch failed') },
      default: { status: 200 },
    })
    const [openai, anthropic] = await probeRoutes({ targets: TARGETS, apiKey: 'K', fetch })
    assert.equal(openai.status, null)
    assert.equal(openai.ok, false)
    assert.equal(openai.error.kind, 'network')
    assert.match(openai.detail, /fetch failed/)
    assert.equal(anthropic.ok, true, 'the other route still answered')
  })

  it('names a credential it does not have instead of probing unauthenticated', async () => {
    const { fetch, seen } = stubFetch({})
    const verdicts = await probeRoutes({ targets: TARGETS, apiKey: undefined, fetch })
    assert.equal(seen.length, 0)
    assert.deepEqual(verdicts.map((verdict) => verdict.skipped), ['no-credential', 'no-credential'])
  })

  it('says nothing about a probe the reader cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const { fetch, seen } = stubFetch({})
    const verdicts = await probeRoutes({ targets: TARGETS, apiKey: 'K', signal: controller.signal, fetch })
    assert.equal(seen.length, 0)
    assert.deepEqual(verdicts.map((verdict) => verdict.skipped), ['cancelled', 'cancelled'])
  })

  it('reports an abort mid-flight as cancelled, not as a broken route', async () => {
    const controller = new AbortController()
    const { fetch } = stubFetch({
      default: () => {
        controller.abort()
        throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
      },
    })
    const verdicts = await probeRoutes({ targets: TARGETS, apiKey: 'K', signal: controller.signal, fetch })
    assert.deepEqual(verdicts.map((verdict) => verdict.skipped), ['cancelled', 'cancelled'])
  })

  it('survives a route it cannot even build a request for', async () => {
    const { fetch, seen } = stubFetch({})
    const verdicts = await probeRoutes({
      targets: [{ route: 'nope', key: 'k', baseURL: 'https://x.test', model: 'm' }],
      apiKey: 'K',
      fetch,
    })
    assert.equal(seen.length, 0)
    assert.equal(verdicts[0].skipped, 'malformed')
  })
})

describe('describeAnswer', () => {
  it('treats 2xx as the route answering and everything else as a verdict about it', () => {
    assert.equal(describeAnswer({ status: 200, ms: 12, text: '{}' }).ok, true)
    assert.equal(describeAnswer({ status: 204, ms: 12, text: '' }).ok, true)
    assert.equal(describeAnswer({ status: 403, ms: 12, text: '{"error":"MODEL_NOT_IN_PLAN"}' }).ok, false)
    assert.equal(describeAnswer({ status: 500, ms: 12, text: 'x'.repeat(500) }).detail.length, 300)
  })
})
