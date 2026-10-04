import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CONTEXT_WINDOW_EXCEEDED,
  DEFAULT_CONTEXT_GUARD_RATIO,
  DEFAULT_RECOVERY_ATTEMPTS,
  GATEWAY_OVERFLOW_SIGNATURES,
  HARNESS_HEADROOM_TOKENS,
  SIZE_RELATED_FAILURE_CODES,
  guardTokens,
  harnessPressureTokens,
  installContextGuard,
  installOverflowRecovery,
  isGatewayOverflow,
  isSizeRelatedFailure,
  pruneToolResults,
  routeKeySet,
} from '../lib/recovery.js'

/** The 400 Command Code returns, as the harness records it (nested envelope and all). */
const GATEWAY_REFUSAL = {
  code: 'INVALID_REQUEST',
  message: '400: {"message":"{\\"message\\":\\"a single path expansion cannot exceed 512 candidates trace_id: 49d472f289d9707a8e4bc4814eca2360\\",\\"type\\":\\"invalid_request_error\\"}\\n","type":"invalid_request_error"}',
}

/** An ordinary invalid request on the same route: must never be treated as an overflow. */
const UNRELATED_400 = { code: 'INVALID_REQUEST', message: '400: {"message":"model not found","type":"invalid_request_error"}' }

const ROUTES = routeKeySet({
  openai: 'commandcode-goat-autosync',
  anthropic: 'commandcode-goat-anthropic',
  responses: 'commandcode-goat-responses',
})

/**
 * A cordis stand-in faithful about what the recovery hook uses: `on`, `get`
 * and `logger`. `waterfall()` replays the harness' middleware contract —
 * a handler that returns a value ends the chain, `next()` continues it — which
 * is exactly how `agent/request-error` decides whether to retry a request.
 */
function mockContext(services = {}) {
  const listeners = new Map()
  const logs = []
  const record = (level) => (message) => logs.push({ level, message })
  const ctx = {
    logger: { info: record('info'), warn: record('warn'), debug: record('debug') },
    get(name) {
      return this[name]
    },
    on(event, handler) {
      listeners.set(event, [...listeners.get(event) ?? [], handler])
    },
    waterfall(event, payload, final) {
      const chain = listeners.get(event) ?? []
      let index = -1
      const next = async () => {
        index += 1
        if (index >= chain.length) return final
        return await chain[index](payload, next)
      }
      return next()
    },
    /** Fire a plain (non-middleware) event with its own argument list. */
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    },
  }
  return { ctx: { ...ctx, ...services }, logs, listeners }
}

/** A session whose `surface.replaceGeneration` moves when a replacement lands. */
function mockSession({ provider = 'commandcode-goat-autosync', model = 'deepseek/deepseek-v4.1-flash' } = {}) {
  const session = {
    surface: { replaceGeneration: 0 },
    requestHeader: () => ({ config: { provider, model } }),
  }
  return session
}

/** An agent wrapper carrying one session. */
function mockAgent(session) {
  return { session }
}

/**
 * A pruner that rewrites the surface, like the harness' own tool-result pruner.
 *
 * The real service answers `{ pruned: [replacements], charsRemoved }` — a list,
 * not a count — so that is the default here; `shape: 'count'` covers a host or
 * wrapper that answers with a number instead.
 */
function mockPruner(session, { pruned = 1, throws = false, shape = 'list' } = {}) {
  return {
    calls: 0,
    pruneSession(target) {
      this.calls += 1
      if (throws) throw new Error('session rejected the replacement')
      if (target !== session) throw new Error('pruned the wrong session')
      const landed = shape === 'count'
        ? { pruned, charsRemoved: pruned * 1000 }
        : { pruned: Array.from({ length: pruned }, (_, index) => ({ originalSeq: index })), charsRemoved: pruned * 1000 }
      if (pruned > 0) target.surface.replaceGeneration += 1
      return landed
    },
  }
}

/** The harness' token meter, reduced to the one number the guard compares. */
function mockMeter(totalTokens, { throws = false } = {}) {
  return {
    calls: 0,
    measure() {
      this.calls += 1
      if (throws) throw new Error('token surface does not match the session surface')
      return { totalTokens }
    },
  }
}

/** The harness' llm service, reduced to the window one route resolves to. */
function mockLlm(contextWindow, { throws = false } = {}) {
  return {
    calls: 0,
    async resolveModelInfo() {
      this.calls += 1
      if (throws) throw new Error('no such model')
      return { context: { contextWindow } }
    },
  }
}

/** A failure shaped like the gateway dropping a stream that had started. */
const DROPPED_STREAM = { code: 'TRANSPORT', message: 'Stream ended without finish_reason' }

describe('isGatewayOverflow', () => {
  it('recognises the gateway wording inside the harness-wrapped 400 envelope', () => {
    assert.equal(isGatewayOverflow(GATEWAY_REFUSAL), true)
    assert.equal(isGatewayOverflow({
      code: 'INVALID_REQUEST',
      message: '400: a single path expansion cannot exceed 512 candidates trace_id: f825cf1d3f9d287d93c0e6e850f8f97d',
    }), true)
  })

  it('leaves every other invalid request alone', () => {
    assert.equal(isGatewayOverflow(UNRELATED_400), false)
    assert.equal(isGatewayOverflow({ code: 'INVALID_REQUEST', message: '400: {"message":"a single path expansion"}' }), false)
    assert.equal(isGatewayOverflow(null), false)
    assert.equal(isGatewayOverflow(undefined), false)
    assert.equal(isGatewayOverflow({}), false)
    assert.equal(isGatewayOverflow({ message: 42 }), false)
  })

  it('never claims a failure the harness already classified as an overflow', () => {
    assert.equal(isGatewayOverflow({ code: CONTEXT_WINDOW_EXCEEDED, message: GATEWAY_REFUSAL.message }), false)
    assert.equal(CONTEXT_WINDOW_EXCEEDED, 'CONTEXT_WINDOW_EXCEEDED')
  })

  it('publishes its signature list for the README to quote', () => {
    assert.ok(GATEWAY_OVERFLOW_SIGNATURES.length >= 1)
    assert.ok(GATEWAY_OVERFLOW_SIGNATURES.every((pattern) => pattern instanceof RegExp))
  })
})

describe('routeKeySet', () => {
  it('collects the named routes and drops blanks', () => {
    assert.deepEqual([...routeKeySet({ openai: 'a', anthropic: '', responses: undefined })], ['a'])
    assert.deepEqual([...routeKeySet(undefined)], [])
  })
})

describe('harnessPressureTokens', () => {
  it('reproduces dsh-compaction-basic\'s own line', () => {
    // threshold = min(window x 0.8, window - reserved - headroom)
    assert.equal(harnessPressureTokens(1_000_000), 800_000)
    assert.equal(harnessPressureTokens(262_144), 196_608)
    assert.equal(harnessPressureTokens(262_144, 32_768), 163_840)
    assert.equal(harnessPressureTokens(200_000, 256_000), undefined)
    assert.equal(harnessPressureTokens(0), undefined)
    assert.equal(HARNESS_HEADROOM_TOKENS, 65536)
  })
})

describe('guardTokens', () => {
  it('prices a share of the route\'s own window, below the harness\' own line', () => {
    assert.equal(guardTokens(1_000_000, 0.7), 700_000)
    assert.equal(guardTokens(1_048_576, 0.7), 734_003)
    assert.equal(guardTokens(500_000, 0.7), 350_000)
  })

  it('steps aside where the harness\' own line meets it first', () => {
    // 0.7 x window reaches the harness' line (window - reserved - headroom) at
    // window ~= (reserved + 65536) / 0.3, so a small window has no room for a
    // guard that fires first — and there DSH's own line is the better trigger,
    // because it summarizes rather than merely pruning.
    assert.equal(guardTokens(200_000, 0.7), undefined)
    assert.equal(guardTokens(150_000, 0.7), undefined)
    assert.equal(guardTokens(262_144, 0.7, 32_768), undefined)
    assert.equal(guardTokens(320_000, 0.7, 32_768), undefined)
    // A small window with nothing reserved still has a little room, so the
    // guard keeps working there.
    assert.equal(guardTokens(262_144, 0.7), 183_500)
    // ...and it returns in full once the ratio term has room again.
    assert.equal(guardTokens(400_000, 0.7), 280_000)
    assert.equal(guardTokens(500_000, 0.7), 350_000)
  })

  it('treats a switch-off ratio, or an unusable window, as "no guard"', () => {
    assert.equal(guardTokens(1_000_000, 0), undefined)
    assert.equal(guardTokens(1_000_000, -1), undefined)
    assert.equal(guardTokens(1_000_000, 'half'), undefined)
    assert.equal(guardTokens(0, 0.7), undefined)
    assert.equal(guardTokens(undefined, 0.7), undefined)
    assert.equal(guardTokens(1_000_000.5, 0.7), undefined)
  })

  it('never lets a ratio at or above the harness line become a budget', () => {
    assert.equal(guardTokens(1_000_000, 2), undefined)
    assert.equal(guardTokens(1_000_000, 0.8), undefined)
    assert.equal(guardTokens(1_000_000, 0.79), 790_000)
  })
})

describe('isSizeRelatedFailure', () => {
  it('claims the codes that mean "accepted, then dropped"', () => {
    assert.equal(isSizeRelatedFailure(DROPPED_STREAM), true)
    assert.equal(isSizeRelatedFailure({ code: 'TIMEOUT', message: 'Request timed out.' }), true)
    assert.equal(isSizeRelatedFailure({ code: 'EMPTY_RESPONSE', message: '' }), true)
    // The adapter's event stream closing with no terminal event is the same
    // death one layer up, and the harness neither retries it nor reads it as an
    // overflow either.
    assert.equal(isSizeRelatedFailure({ code: 'STREAM_CLOSED', message: 'stream closed before any terminal event' }), true)
    assert.deepEqual([...SIZE_RELATED_FAILURE_CODES].sort(), ['EMPTY_RESPONSE', 'STREAM_CLOSED', 'TIMEOUT', 'TRANSPORT'])
  })

  it('leaves load, quota and classification problems to the harness', () => {
    assert.equal(isSizeRelatedFailure({ code: 'SERVER', message: '503 status code (no body)' }), false)
    assert.equal(isSizeRelatedFailure({ code: 'RATE_LIMIT', message: '429' }), false)
    assert.equal(isSizeRelatedFailure({ code: 'INVALID_REQUEST', message: '400: model not found' }), false)
    assert.equal(isSizeRelatedFailure({ code: CONTEXT_WINDOW_EXCEEDED, message: 'too long' }), false)
    assert.equal(isSizeRelatedFailure(null), false)
    assert.equal(isSizeRelatedFailure(undefined), false)
  })
})

describe('pruneToolResults', () => {
  it('counts the replacements the harness\' own pruner reports', async () => {
    const session = mockSession()
    // The real service answers with a list of replacements; counting that list
    // as "not a number" would silently disable the cheap rung of the ladder.
    const { ctx } = mockContext({ toolResultPruner: mockPruner(session, { pruned: 3 }) })
    assert.deepEqual(pruneToolResults(ctx, session), { count: 3, charsRemoved: 3000 })
  })

  it('also reads a count-shaped answer from an older or wrapped pruner', () => {
    const session = mockSession()
    const { ctx } = mockContext({ toolResultPruner: mockPruner(session, { pruned: 2, shape: 'count' }) })
    assert.deepEqual(pruneToolResults(ctx, session), { count: 2, charsRemoved: 2000 })
  })

  it('reports nothing for a profile with no pruner, or one that refuses', () => {
    const session = mockSession()
    assert.deepEqual(pruneToolResults(mockContext().ctx, session), { count: 0, charsRemoved: 0 })
    const { ctx } = mockContext({ toolResultPruner: mockPruner(session, { throws: true }) })
    const logs = []
    assert.deepEqual(pruneToolResults(ctx, session, (level, message) => logs.push({ level, message })), { count: 0, charsRemoved: 0 })
    assert.match(logs[0].message, /tool-result prune failed/)
  })
})

describe('installOverflowRecovery', () => {
  /** Build the hook with a session that is already failing. */
  const setup = (options = {}) => {
    const session = mockSession()
    const agent = mockAgent(session)
    const pruner = options.pruner ?? mockPruner(session, { pruned: options.pruned ?? 1 })
    const compaction = options.compaction
    const { ctx, logs } = mockContext({
      ...(options.services ?? {}),
      toolResultPruner: pruner,
      ...(compaction === undefined ? {} : { compaction }),
    })
    installOverflowRecovery(ctx, {
      isEnabled: options.isEnabled,
      ratio: options.ratio,
      routeKeys: options.routeKeys ?? (() => ROUTES),
      maxAttempts: options.maxAttempts,
    })
    const refuse = (overrides = {}) => ctx.waterfall('agent/request-error', {
      agent,
      provider: 'commandcode-goat-autosync',
      failure: GATEWAY_REFUSAL,
      signal: options.signal,
      ...overrides,
    })
    return { ctx, logs, pruner, session, agent, refuse }
  }

  it('prunes and asks for a retry when the gateway refuses this plugin\'s route', async () => {
    const { pruner, session, refuse, logs } = setup()
    const action = await refuse()
    assert.deepEqual(action, { kind: 'retry' })
    assert.equal(pruner.calls, 1)
    assert.equal(session.surface.replaceGeneration, 1)
    assert.match(logs.find((entry) => entry.level === 'info').message, /pruned 1 tool result/)
  })

  it('restores the budget after a failed turn becomes idle', async () => {
    const { ctx, agent, refuse } = setup({ maxAttempts: 1 })
    assert.deepEqual(await refuse(), { kind: 'retry' })
    assert.equal(await refuse(), undefined)
    ctx.emit('agent/status', { agent, status: 'running' })
    assert.equal(await refuse(), undefined)
    ctx.emit('agent/status', { agent, status: 'idle' })
    assert.deepEqual(await refuse(), { kind: 'retry' })
  })

  it('does not touch another provider, another failure, or a disabled hook', async () => {
    const foreign = setup()
    assert.equal(await foreign.refuse({ provider: 'deepseek-account' }), undefined)
    assert.equal(foreign.pruner.calls, 0)

    const unrelated = setup()
    assert.equal(await unrelated.refuse({ failure: UNRELATED_400 }), undefined)
    assert.equal(unrelated.pruner.calls, 0)

    const classified = setup()
    assert.equal(await classified.refuse({ failure: { code: CONTEXT_WINDOW_EXCEEDED, message: GATEWAY_REFUSAL.message } }), undefined)
    assert.equal(classified.pruner.calls, 0)

    const off = setup({ isEnabled: () => false })
    assert.equal(await off.refuse(), undefined)
    assert.equal(off.pruner.calls, 0)

    const otherTier = setup({ routeKeys: () => routeKeySet({ openai: 'commandcode-max-autosync' }) })
    assert.equal(await otherTier.refuse(), undefined)
    assert.equal(otherTier.pruner.calls, 0)
  })

  it('waits for an aborted turn instead of retrying into it', async () => {
    const { refuse, pruner } = setup({ signal: { aborted: true } })
    assert.equal(await refuse(), undefined)
    assert.equal(pruner.calls, 0)
  })

  it('escalates to one compaction region only on the second refusal', async () => {
    const calls = []
    const compaction = {
      compactIfNeeded: async (agent, trigger, signal) => { calls.push([trigger, signal]); return { shadowedSeqs: [1] } },
      compactNow: async () => { throw new Error('must not be reached while compactIfNeeded exists') },
    }
    const { refuse, logs } = setup({ compaction })
    assert.deepEqual(await refuse(), { kind: 'retry' })
    assert.deepEqual(calls, [])
    assert.deepEqual(await refuse(), { kind: 'retry' })
    assert.deepEqual(calls, [['context-overflow', undefined]])
    assert.match(logs.at(-1).message, /compacted one region/)
  })

  it('says so instead of probing a manual compaction a running turn cannot use', async () => {
    // `compactNow` goes through agent.runMaintenance, which refuses while the
    // agent has active work — and a request error only ever happens inside a
    // running turn, so probing for it would buy one guaranteed "busy" failure
    // per attempt and a log line that blames the wrong thing.
    const seen = []
    const compaction = { compactNow: async (agent, signal, commandId) => { seen.push(commandId); return { shadowedSeqs: [2] } } }
    const { refuse, logs } = setup({ compaction })
    await refuse()
    assert.deepEqual(await refuse(), { kind: 'retry' })
    assert.deepEqual(seen, [])
    assert.match(logs.map((entry) => entry.message).join('\n'), /no mid-turn overflow entry point/)
  })

  it('keeps the prune-only ladder when no compaction backend offers an entry point', async () => {
    const { refuse, logs } = setup({ compaction: {} })
    await refuse()
    assert.deepEqual(await refuse(), { kind: 'retry' })
    assert.match(logs.map((entry) => entry.message).join('\n'), /no mid-turn overflow entry point/)
  })

  it('goes straight to compaction when no tool-result pruner is composed', async () => {
    const session = mockSession()
    const calls = []
    const { ctx } = mockContext({
      compaction: {
        compactIfNeeded: async () => {
          calls.push('compact')
          session.surface.replaceGeneration += 1
          return { shadowedSeqs: [4] }
        },
      },
    })
    installOverflowRecovery(ctx, { routeKeys: () => ROUTES })
    const action = await ctx.waterfall('agent/request-error', {
      agent: mockAgent(session), provider: 'commandcode-goat-autosync', failure: GATEWAY_REFUSAL,
    })
    assert.deepEqual(action, { kind: 'retry' })
    assert.deepEqual(calls, ['compact'])
  })

  it('reports a pruner that cannot rewrite the session, and leaves the error standing', async () => {
    const session = mockSession()
    const throwingPruner = {
      calls: 0,
      pruneSession() {
        this.calls += 1
        throw new Error('session rejected the replacement')
      },
    }
    const { ctx, logs } = mockContext({ toolResultPruner: throwingPruner })
    installOverflowRecovery(ctx, { routeKeys: () => ROUTES })
    const refuse = () => ctx.waterfall('agent/request-error', {
      agent: mockAgent(session), provider: 'commandcode-goat-autosync', failure: GATEWAY_REFUSAL,
    })
    assert.equal(await refuse(), undefined)
    assert.equal(throwingPruner.calls, 1)
    const text = logs.map((entry) => entry.message).join('\n')
    assert.match(text, /tool-result prune failed/)
    assert.match(text, /nothing to reduce/)
  })

  it('still retries when the compaction backend fails but the prune moved the surface', async () => {
    const session = mockSession()
    const { ctx, logs } = mockContext({
      toolResultPruner: mockPruner(session),
      compaction: { compactIfNeeded: async () => { throw new Error('backend busy') } },
    })
    installOverflowRecovery(ctx, { routeKeys: () => ROUTES })
    const refuse = () => ctx.waterfall('agent/request-error', {
      agent: mockAgent(session), provider: 'commandcode-goat-autosync', failure: GATEWAY_REFUSAL,
    })
    assert.deepEqual(await refuse(), { kind: 'retry' })
    assert.deepEqual(await refuse(), { kind: 'retry' })
    assert.match(logs.map((entry) => entry.message).join('\n'), /overflow compaction failed: backend busy/)
  })

  it('leaves the error standing when nothing could be reduced', async () => {
    const { refuse, logs } = setup({ pruned: 0 })
    assert.equal(await refuse(), undefined)
    assert.match(logs.at(-1).message, /nothing to reduce/)
  })

  it('gives up after the attempt budget and says so', async () => {
    const { refuse, logs } = setup()
    assert.deepEqual(await refuse(), { kind: 'retry' })
    assert.deepEqual(await refuse(), { kind: 'retry' })
    assert.equal(await refuse(), undefined)
    assert.match(logs.at(-1).message, new RegExp(`after ${DEFAULT_RECOVERY_ATTEMPTS} recovery attempt`))
  })

  it('honours an explicit attempt budget', async () => {
    const { refuse } = setup({ maxAttempts: 1 })
    assert.deepEqual(await refuse(), { kind: 'retry' })
    assert.equal(await refuse(), undefined)
  })

  it('starts a fresh ladder once an assistant message proves the session fits again', async () => {
    const { ctx, refuse, session } = setup()
    assert.deepEqual(await refuse(), { kind: 'retry' })
    assert.deepEqual(await refuse(), { kind: 'retry' })
    assert.equal(await refuse(), undefined)
    ctx.emit('session/event', session, { type: 'assistant/message' })
    assert.deepEqual(await refuse(), { kind: 'retry' })
  })

  it('keeps each session\'s budget separate', async () => {
    const session = mockSession()
    const other = mockSession()
    const { ctx } = mockContext({
      // One pruner that accepts either session, so the two budgets are what is
      // being measured rather than which session the pruner was built for.
      toolResultPruner: {
        pruneSession(target) {
          target.surface.replaceGeneration += 1
          return { pruned: 1, charsRemoved: 1000 }
        },
      },
    })
    installOverflowRecovery(ctx, { routeKeys: () => ROUTES })
    const refuse = (target) => ctx.waterfall('agent/request-error', {
      agent: mockAgent(target), provider: 'commandcode-goat-autosync', failure: GATEWAY_REFUSAL,
    })
    assert.deepEqual(await refuse(session), { kind: 'retry' })
    assert.deepEqual(await refuse(session), { kind: 'retry' })
    assert.equal(await refuse(session), undefined)
    assert.deepEqual(await refuse(other), { kind: 'retry' })
  })

  it('recovers a stream the gateway dropped while the session was inside the guard', async () => {
    // The shape this route actually fails in: the request is accepted, a few
    // chunks arrive, and the stream ends with no finish reason. Nothing about
    // the failure says "too long", so only the session's size can say it.
    const { refuse, pruner, logs } = setup({
      services: { tokenMeter: mockMeter(798_935), llm: mockLlm(1_000_000) },
    })
    assert.deepEqual(await refuse({ failure: DROPPED_STREAM }), { kind: 'retry' })
    assert.equal(pruner.calls, 1)
    assert.match(logs.find((entry) => entry.level === 'info').message, /refused an oversized request/)
  })

  it('leaves a dropped stream in a small session to the harness\' own retry policy', async () => {
    const { refuse, pruner } = setup({
      services: { tokenMeter: mockMeter(185_075), llm: mockLlm(1_000_000) },
    })
    assert.equal(await refuse({ failure: DROPPED_STREAM }), undefined)
    assert.equal(pruner.calls, 0)
  })

  it('leaves a transport fault alone when the route cannot be measured', async () => {
    // A profile without the meter, or a route whose window does not resolve,
    // must not turn every dropped stream into a paid summarization.
    const noMeter = setup()
    assert.equal(await noMeter.refuse({ failure: DROPPED_STREAM }), undefined)
    assert.equal(noMeter.pruner.calls, 0)

    const noWindow = setup({ services: { tokenMeter: mockMeter(798_935), llm: mockLlm(0, { throws: true }) } })
    assert.equal(await noWindow.refuse({ failure: DROPPED_STREAM }), undefined)
    assert.equal(noWindow.pruner.calls, 0)
  })

  it('still claims the gateway\'s own wording below the guard', async () => {
    // The 400 names itself, so size never has to be inferred — and a small cold
    // session can produce it too.
    const { refuse, pruner } = setup({
      services: { tokenMeter: mockMeter(10_000), llm: mockLlm(1_000_000) },
    })
    assert.deepEqual(await refuse(), { kind: 'retry' })
    assert.equal(pruner.calls, 1)
  })

  it('closes the ladder with the guard switched off', async () => {
    const { refuse, pruner } = setup({
      ratio: () => 0,
      services: { tokenMeter: mockMeter(798_935), llm: mockLlm(1_000_000) },
    })
    assert.equal(await refuse({ failure: DROPPED_STREAM }), undefined)
    assert.equal(pruner.calls, 0)
    // The gateway's own wording is a classification problem, not a size guess,
    // so switching the guard off does not switch that recovery off.
    assert.deepEqual(await refuse(), { kind: 'retry' })
    assert.equal(pruner.calls, 1)
  })
})

describe('installContextGuard', () => {
  it('preserves the step result when the host logger throws', async () => {
    const session = mockSession()
    const { ctx } = mockContext({ tokenMeter: mockMeter(798_935), llm: mockLlm(1_000_000),
      toolResultPruner: mockPruner(session) })
    ctx.logger = { info() { throw new Error('logger closed') }, warn() { throw new Error('logger closed') } }
    installContextGuard(ctx, { routeKeys: () => ROUTES })
    const final = { kind: 'enter', messages: [] }
    assert.equal(await ctx.waterfall('agent/pre-step', { agent: mockAgent(session) }, final), final)
  })
  /**
   * The decision the harness' own `agent/pre-step` fallback returns, and what
   * the agent loop dereferences straight after the waterfall (`decision.kind`,
   * `decision.messages`). A guard that returned anything else — or nothing at
   * all — would break every step it ran on, so the middleware is driven with
   * this value and every step asserts it comes back unchanged.
   */
  const HARNESS_CONTINUE = { kind: 'enter', messages: [] }

  /**
   * Build the guard around one measured session.
   *
   * The defaults are the failing session's own numbers: a 1,000,000-token route
   * whose session reached 798,935 tokens — 1,065 short of the harness' 800,000
   * compaction line, and past this guard's 700,000.
   */
  const setup = (options = {}) => {
    const session = options.session ?? mockSession(options.sessionOptions)
    const pruner = options.pruner ?? mockPruner(session, { pruned: options.pruned ?? 2 })
    // `meter: null` / `llm: null` mean "this profile composed no such service",
    // which `??` would silently replace with the default.
    const meter = 'meter' in options ? options.meter : mockMeter(options.pressure ?? 798_935, { throws: options.meterThrows === true })
    const { ctx, logs } = mockContext({
      toolResultPruner: pruner,
      tokenMeter: meter,
      llm: 'llm' in options ? options.llm : mockLlm(options.window ?? 1_000_000, { throws: options.llmThrows === true }),
    })
    installContextGuard(ctx, {
      isEnabled: options.isEnabled,
      ratio: options.ratio ?? (() => options.guardRatio ?? DEFAULT_CONTEXT_GUARD_RATIO),
      routeKeys: options.routeKeys ?? (() => ROUTES),
    })
    /** Run one pre-step and prove the guard handed the harness' decision back. */
    const step = async (payload = {}) => {
      const decision = await ctx.waterfall('agent/pre-step', {
        agent: mockAgent(session),
        turn: 1,
        step: 1,
        signal: options.signal,
        ...payload,
      }, HARNESS_CONTINUE)
      assert.deepEqual(decision, HARNESS_CONTINUE, 'the guard must pass the step decision through untouched')
      return undefined
    }
    return { ctx, logs, pruner, session, meter, step }
  }

  it('reduces the session before the request once it passes the guard', async () => {
    const { step, pruner, session, logs } = setup()
    // The step must still run: the guard is a middleware that only ever
    // continues the chain, never a decision about the turn.
    assert.equal(await step(), undefined)
    assert.equal(pruner.calls, 1)
    assert.equal(session.surface.replaceGeneration, 1)
    assert.match(logs.at(-1).message, /is at 798935 of 1000000 tokens \(guard 700000\); pruned 2 tool result\(s\)/)
  })

  it('stays out of the way below the guard', async () => {
    const below = setup({ pressure: 699_999 })
    assert.equal(await below.step(), undefined)
    assert.equal(below.pruner.calls, 0)

    const atTheLine = setup({ pressure: 700_000 })
    assert.equal(await atTheLine.step(), undefined)
    assert.equal(atTheLine.pruner.calls, 1)
  })

  it('follows the route\'s own window rather than a fixed number', async () => {
    // A 262,144-token model guards at 183,500 — the same rule, a smaller route.
    const small = setup({ window: 262_144, pressure: 183_500 })
    assert.equal(await small.step(), undefined)
    assert.equal(small.pruner.calls, 1)

    const under = setup({ window: 262_144, pressure: 183_499 })
    assert.equal(await under.step(), undefined)
    assert.equal(under.pruner.calls, 0)
  })

  it('only touches this plugin\'s own routes', async () => {
    const foreign = setup({ sessionOptions: { provider: 'deepseek-account' } })
    assert.equal(await foreign.step(), undefined)
    assert.equal(foreign.pruner.calls, 0)

    const otherTier = setup({ routeKeys: () => routeKeySet({ openai: 'commandcode-max-autosync' }) })
    assert.equal(await otherTier.step(), undefined)
    assert.equal(otherTier.pruner.calls, 0)
  })

  it('is switched off by the ratio, the shared switch, or an aborted turn', async () => {
    const off = setup({ guardRatio: 0 })
    assert.equal(await off.step(), undefined)
    assert.equal(off.pruner.calls, 0)

    const disabled = setup({ isEnabled: () => false })
    assert.equal(await disabled.step(), undefined)
    assert.equal(disabled.pruner.calls, 0)

    const aborted = setup({ signal: { aborted: true } })
    assert.equal(await aborted.step(), undefined)
    assert.equal(aborted.pruner.calls, 0)
  })

  it('continues the turn when the measurement itself fails', async () => {
    const meterThrows = setup({ meterThrows: true })
    assert.equal(await meterThrows.step(), undefined)
    assert.equal(meterThrows.pruner.calls, 0)

    const llmThrows = setup({ llmThrows: true })
    assert.equal(await llmThrows.step(), undefined)
    assert.equal(llmThrows.pruner.calls, 0)

    const noMeter = setup({ meter: null })
    assert.equal(await noMeter.step(), undefined)
    assert.equal(noMeter.pruner.calls, 0)
  })

  it('says once that it has nothing left to prune, then stops repeating itself', async () => {
    const { step, logs } = setup({ pruned: 0 })
    assert.equal(await step(), undefined)
    assert.equal(await step(), undefined)
    const notes = logs.filter((entry) => /nothing left to prune/.test(entry.message))
    assert.equal(notes.length, 1)
  })

  it('asks the pruner again only once the session has grown past a no-op attempt', async () => {
    // The scan prices every tool result on the surface, so a long conversation
    // that is above the guard with nothing prunable must not pay it every step.
    let pressure = 700_000
    const session = mockSession()
    const pruner = mockPruner(session, { pruned: 0 })
    const { ctx } = mockContext({
      toolResultPruner: pruner,
      tokenMeter: { measure: () => ({ totalTokens: pressure }) },
      llm: mockLlm(1_000_000),
    })
    installContextGuard(ctx, { routeKeys: () => ROUTES })
    const step = () => ctx.waterfall('agent/pre-step', { agent: mockAgent(session), turn: 1, step: 1 }, HARNESS_CONTINUE)

    assert.deepEqual(await step(), HARNESS_CONTINUE)
    assert.equal(pruner.calls, 1)
    assert.deepEqual(await step(), HARNESS_CONTINUE)
    assert.equal(pruner.calls, 1)

    pressure += 4096
    assert.deepEqual(await step(), HARNESS_CONTINUE)
    assert.equal(pruner.calls, 2)

    // Dropping back below the guard forgets the no-op, so the next crossing is
    // acted on immediately rather than being measured against a stale pressure.
    pressure = 200_000
    assert.deepEqual(await step(), HARNESS_CONTINUE)
    assert.equal(pruner.calls, 2)
    pressure = 700_000
    assert.deepEqual(await step(), HARNESS_CONTINUE)
    assert.equal(pruner.calls, 3)
  })

  it('leaves a session with no request header alone', async () => {
    const { step } = setup({ session: { surface: { replaceGeneration: 0 } } })
    assert.equal(await step(), undefined)
  })

  it('continues the chain instead of vetoing the step', async () => {
    // The harness dereferences the waterfall's result immediately, and another
    // plugin's pre-step listener sits behind this one: both facts are only
    // visible when the chain has something to return and somewhere to go.
    const session = mockSession()
    const pruner = mockPruner(session, { pruned: 1 })
    const { ctx } = mockContext({
      toolResultPruner: pruner,
      tokenMeter: mockMeter(798_935),
      llm: mockLlm(1_000_000),
    })
    installContextGuard(ctx, { routeKeys: () => ROUTES })
    let downstream = 0
    ctx.on('agent/pre-step', async (_payload, next) => {
      downstream += 1
      return next()
    })
    const decision = await ctx.waterfall('agent/pre-step', {
      agent: mockAgent(session),
      turn: 1,
      step: 1,
    }, HARNESS_CONTINUE)
    assert.deepEqual(decision, HARNESS_CONTINUE)
    assert.equal(downstream, 1, 'the listener behind the guard must still run')
    assert.equal(pruner.calls, 1)
  })

  it('swallows its own failure rather than failing the step', async () => {
    // Whatever the guard cannot read, it must not turn into the reason a turn
    // dies: a header getter that throws is the one failure the shape probes
    // inside the guard do not already contain.
    const session = { surface: { replaceGeneration: 0 }, requestHeader() { throw new Error('no header yet') } }
    const { ctx, logs } = mockContext({
      toolResultPruner: mockPruner(session),
      tokenMeter: mockMeter(798_935),
      llm: mockLlm(1_000_000),
    })
    installContextGuard(ctx, { routeKeys: () => ROUTES })
    const decision = await ctx.waterfall('agent/pre-step', { agent: mockAgent(session), turn: 1, step: 1 }, HARNESS_CONTINUE)
    assert.deepEqual(decision, HARNESS_CONTINUE)
    assert.match(logs.map((entry) => entry.message).join('\n'), /context guard failed: no header yet/)
  })

  it('survives a pruner that refuses the rewrite', async () => {
    const session = mockSession()
    const { ctx, logs } = mockContext({
      toolResultPruner: { pruneSession() { throw new Error('session rejected the replacement') } },
      tokenMeter: mockMeter(798_935),
      llm: mockLlm(1_000_000),
    })
    installContextGuard(ctx, { routeKeys: () => ROUTES })
    const decision = await ctx.waterfall('agent/pre-step', { agent: mockAgent(session), turn: 1, step: 1 }, HARNESS_CONTINUE)
    assert.deepEqual(decision, HARNESS_CONTINUE)
    assert.match(logs.map((entry) => entry.message).join('\n'), /tool-result prune failed/)
  })
})
