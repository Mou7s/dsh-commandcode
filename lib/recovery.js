/**
 * Keep one Command Code route usable at the size its gateway really serves.
 *
 * Two levers, both driven through the harness' own services — nothing here
 * calls the upstream itself, and nothing here caps the vendor's context window.
 *
 * **The guard (`installContextGuard`).** The harness compacts a session at
 * `min(contextWindow × 0.8, contextWindow − reserved − headroom)` estimated
 * tokens (`dsh-compaction-basic/lib/index.js:132`). For a vendor window of
 * 1,000,000 that line lands on 800,000 — and Command Code's gateway stops
 * completing requests right about there, so a session can sit one step short of
 * the trigger and be refused on the request that would have crossed it. Measured
 * on a real session (`session-8983bdb2`): 798,935 tokens against an 800,000
 * trigger, 1,065 short, request dropped mid-stream, no compaction anywhere.
 *
 * The guard therefore fires *earlier* — at `contextGuardRatio × contextWindow`
 * (0.7 by default), and only where that is genuinely before the harness' own
 * line — and applies the harness' own cheapest lever, the tool-result pruner,
 * before the request goes out. That is byte-for-byte what the harness would have
 * done at its own threshold, just soon enough to matter, and it costs no
 * upstream call. Summarization is still the harness' decision, at the harness'
 * own threshold; the guard only buys the room that threshold is supposed to have.
 * On a window small enough that the harness' headroom term already pulls its
 * line below the guard, the guard steps aside rather than second-guessing it.
 *
 * **The recovery (`installOverflowRecovery`).** When the gateway nevertheless
 * refuses or drops a request, this hook supplies the classification the harness
 * cannot make, then prunes (and, on a second refusal, compacts one region)
 * before asking for the request to be retried. Two upstream shapes reach it:
 *
 *   - the "path expansion / 512 candidates" 400, which the harness reads as an
 *     ordinary invalid request and therefore neither retries nor compacts for;
 *   - a stream that ends without a finish reason, stalls, or closes early, which
 *     the harness reads as a transport fault and retries unchanged — those are
 *     claimed only when the session was already inside the guard budget, so an
 *     ordinary network hiccup in a small session is left to the harness' own
 *     retry policy.
 *
 * Neither half may ever be the reason a turn fails: both are wrapped whole and
 * degrade to the untouched step or to the original error.
 *
 * @module dsh-commandcode-goat/recovery
 */

/**
 * The harness' own overflow code (`CONTEXT_WINDOW_EXCEEDED_CODE` in
 * `@deepseek-ai/dsh-llm`), spelled here rather than imported: a plugin has no
 * dependency on the host's internals, and this string is the contract it is
 * matching. A failure already classified this way is handled by the harness'
 * own recovery, so neither half of this module touches it.
 */
export const CONTEXT_WINDOW_EXCEEDED = 'CONTEXT_WINDOW_EXCEEDED'

/**
 * Wording Command Code's gateway uses when it refuses a request it cannot
 * expand. Matched against the classified failure's code and message.
 *
 * Kept narrow on purpose: a broad `400` match would swallow every other
 * invalid request on these routes and turn it into a paid summarization call.
 */
export const GATEWAY_OVERFLOW_SIGNATURES = [
  /a single path expansion cannot exceed \d+ candidates/i,
  /path expansion cannot exceed \d+ candidates/i,
]

/**
 * Transport-shaped failures that mean "the request was accepted and then died
 * before it finished" — the shape an oversized request takes on this gateway
 * instead of a clean context-length error. `STREAM_CLOSED` is the same death
 * one layer up: the adapter's event stream ended with no terminal event, which
 * the harness neither retries nor reads as an overflow either.
 *
 * `SERVER` (a bare 503) and `RATE_LIMIT` are deliberately absent: those are the
 * upstream being busy or the account being throttled, and reducing the session
 * would not help either of them.
 */
export const SIZE_RELATED_FAILURE_CODES = new Set(['TRANSPORT', 'TIMEOUT', 'EMPTY_RESPONSE', 'STREAM_CLOSED'])

/** How many times one session may be reduced and retried before the error stands. */
export const DEFAULT_RECOVERY_ATTEMPTS = 2

/**
 * Share of a route's own context window at which the guard reduces a session
 * before the next request goes out. 0.7 leaves ~10% of the window between the
 * guard and the harness' own 0.8 compaction line, and 30% before the window the
 * vendor advertises — which is the margin a gateway that stops serving near its
 * declared size needs. Set 0 to disable the guard.
 */
export const DEFAULT_CONTEXT_GUARD_RATIO = 0.7

/**
 * How much a session may grow past the guard before the pruner is asked again
 * after an attempt that found nothing to rewrite.
 *
 * The scan prices every tool result on the surface, and a long conversation that
 * is above the guard without anything prunable would otherwise pay that scan on
 * every single step. Growth — not time — is what can make new results prunable,
 * so a small budget of it is the natural retry interval.
 */
export const PRUNE_RETRY_SLACK_TOKENS = 4096

/**
 * Headroom the harness' own compaction reserves, in tokens
 * (`dsh-compaction-basic` `headroomTokens`, default 65,536).
 */
export const HARNESS_HEADROOM_TOKENS = 65536

/**
 * Ratio at which the harness' own compaction fires, before its headroom term is
 * taken into account (`dsh-compaction-basic` `thresholdRatio`, default 0.8).
 */
export const HARNESS_THRESHOLD_RATIO = 0.8

/**
 * The pressure at which the harness itself would compact this route, as
 * `resolveCompactSpec` computes it: `min(window × ratio, window − reserved −
 * headroom)`.
 *
 * @param contextWindow - the route's declared window, in tokens.
 * @param reservedTokens - output tokens one request reserves, which the provider
 *   charges to the same window.
 * @returns the harness' own pressure line, or `undefined` when the route leaves
 *   no pressure budget at all (the harness cannot compact it either).
 */
export function harnessPressureTokens(contextWindow, reservedTokens = 0) {
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) return undefined
  const reserved = Number.isInteger(reservedTokens) && reservedTokens > 0 ? reservedTokens : 0
  const pressureBudget = contextWindow - reserved - HARNESS_HEADROOM_TOKENS
  if (pressureBudget <= 0) return undefined
  return Math.floor(Math.min(contextWindow * HARNESS_THRESHOLD_RATIO, pressureBudget))
}

/**
 * The token count at which the guard reduces a session.
 *
 * The guard exists to fire *before* the harness' own line, because the line is
 * where this gateway stops completing requests. On a large window the ratio term
 * of that line leaves room for it; on a small one the headroom term pulls the
 * harness' line down to meet it — `0.7 × window` reaches `window − reserved −
 * headroom` at `window ≈ (reserved + 65,536) / 0.3`, about 218k tokens with no
 * reservation and 328k with the adapter's usual 32,768-token one — and there the
 * harness' own line is both earlier and better, since it summarizes rather than
 * merely pruning. So the guard steps aside wherever it could not fire first, and
 * it is the same budget the recovery ladder uses to decide whether a failure
 * looks size-related.
 *
 * @param contextWindow - the route's declared window, in tokens.
 * @param ratio - configured share of that window; 0 disables the guard.
 * @param reservedTokens - output tokens one request reserves.
 * @returns the guard budget, or `undefined` when there is no guard to apply.
 */
export function guardTokens(contextWindow, ratio, reservedTokens = 0) {
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) return undefined
  const share = Number(ratio)
  if (!Number.isFinite(share) || share <= 0) return undefined
  const clamped = share > 1 ? 1 : share
  const budget = Math.max(1, Math.floor(contextWindow * clamped))
  const line = harnessPressureTokens(contextWindow, reservedTokens)
  if (line === undefined || budget >= line) return undefined
  return budget
}

/**
 * Whether a failure is the gateway refusing a request it could not expand.
 *
 * @param failure - the `LlmError`-shaped failure the agent loop classified.
 * @returns true only for the gateway's own wording.
 */
export function isGatewayOverflow(failure) {
  if (failure === null || typeof failure !== 'object') return false
  if (failure.code === CONTEXT_WINDOW_EXCEEDED) return false
  const message = typeof failure.message === 'string' ? failure.message : ''
  if (message === '') return false
  return GATEWAY_OVERFLOW_SIGNATURES.some((pattern) => pattern.test(message))
}

/**
 * Whether a failure is a transport-shaped death that a large session explains.
 *
 * @param failure - the `LlmError`-shaped failure the agent loop classified.
 * @returns true for the codes that mean "accepted, then dropped".
 */
export function isSizeRelatedFailure(failure) {
  if (failure === null || typeof failure !== 'object') return false
  if (failure.code === CONTEXT_WINDOW_EXCEEDED) return false
  return SIZE_RELATED_FAILURE_CODES.has(failure.code)
}

/**
 * The `llm-pi-ai` provider keys one tier's routes were written to.
 *
 * @param keys - `{ openai, anthropic, responses }` as the bridge reports them.
 * @returns the set of provider keys this plugin owns.
 */
export function routeKeySet(keys) {
  const out = new Set()
  for (const key of Object.values(keys ?? {})) {
    if (typeof key === 'string' && key !== '') out.add(key)
  }
  return out
}

/**
 * Read the provider and model the session's effective request envelope routes to.
 *
 * @param session - session whose latest request header is inspected.
 * @returns `{ provider, model }`, or `undefined` before any request.
 */
export function routedTarget(session) {
  const config = session?.requestHeader?.()?.config
  if (config === null || typeof config !== 'object') return undefined
  if (typeof config.provider !== 'string' || config.provider === '') return undefined
  if (typeof config.model !== 'string' || config.model === '') return undefined
  return { provider: config.provider, model: config.model }
}

/**
 * Measure one session against the window its route actually declares.
 *
 * Every host call is optional and shape-probed: `tokenMeter` is the service the
 * harness' own compaction prices against, and `llm.resolveModelInfo` is the
 * same call that resolves the window for `dsh-compaction-basic`, so the guard
 * compares the identical pair of numbers.
 *
 * @param ctx - cordis context carrying `get`.
 * @param session - session to measure.
 * @param target - `{ provider, model }` already resolved from the session.
 * @param signal - live turn cancellation.
 * @returns `{ provider, model, pressureTokens, contextWindow, reservedTokens }`,
 *   or `undefined` when the measurement or the window cannot be resolved.
 */
async function inspectRoute(ctx, session, target, signal) {
  const meter = ctx.get?.('tokenMeter')
  if (typeof meter?.measure !== 'function') return undefined
  let measurement
  try {
    measurement = meter.measure(session)
  } catch {
    return undefined
  }
  const pressureTokens = Number(measurement?.totalTokens)
  if (!Number.isFinite(pressureTokens)) return undefined
  const llm = ctx.get?.('llm')
  if (typeof llm?.resolveModelInfo !== 'function') return undefined
  let info
  try {
    info = await llm.resolveModelInfo(target.provider, target.model, signal)
  } catch {
    // An unresolvable route has no window to guard against; the caller falls
    // back to the wording-only trigger.
    return undefined
  }
  const value = info?.context?.contextWindow
  if (!Number.isInteger(value) || value <= 0) return undefined
  // The same reservation `reservedCompletionTokens` reads: the effective
  // envelope's own cap wins, otherwise the adapter's per-request default.
  const configured = session?.requestHeader?.()?.config?.maxTokens
  const reservedTokens = Number.isInteger(configured) && configured > 0
    ? configured
    : Number.isInteger(info?.defaultMaxTokens) && info.defaultMaxTokens > 0
      ? info.defaultMaxTokens
      : 0
  return { ...target, pressureTokens, contextWindow: value, reservedTokens }
}

/** Log through the host logger, tolerating a context without one. */
function makeLog(ctx) {
  return (level, message) => {
    const logger = ctx.logger
    if (typeof logger?.[level] === 'function') logger[level](message)
  }
}

/**
 * Prune oversized tool results through the harness' own pruner.
 *
 * `pruneSession` reports what it rewrote as a list of replacements, but an
 * older or wrapped implementation may report a count instead; both shapes are
 * read here, because a miscounted prune would silently disable the cheap rung
 * of the recovery ladder.
 *
 * @param ctx - cordis context carrying `get`.
 * @param session - session whose surface is rewritten.
 * @param log - logger for a pruner that cannot rewrite the session.
 * @returns `{ count, charsRemoved }`; both zero when nothing was pruned.
 */
export function pruneToolResults(ctx, session, log = () => {}) {
  const pruner = ctx.get?.('toolResultPruner')
  if (typeof pruner?.pruneSession !== 'function') return { count: 0, charsRemoved: 0 }
  let landed
  try {
    landed = pruner.pruneSession(session)
  } catch (error) {
    log('warn', `[dsh-commandcode-goat] tool-result prune failed: ${error instanceof Error ? error.message : String(error)}`)
    return { count: 0, charsRemoved: 0 }
  }
  const replaced = landed?.pruned
  const count = Array.isArray(replaced)
    ? replaced.length
    : Number.isInteger(replaced) && replaced > 0
      ? replaced
      : 0
  const charsRemoved = Number.isFinite(landed?.charsRemoved) ? landed.charsRemoved : 0
  return { count, charsRemoved: count === 0 ? 0 : charsRemoved }
}

/**
 * Install the pre-request pressure guard.
 *
 * Every step, before its request is built, a session already inside the guard
 * budget is reduced through the harness' own tool-result pruner. The handler is
 * wrapped whole: a guard that cannot measure, prune or log must never be the
 * reason a turn fails, so it degrades to the untouched step.
 *
 * @param ctx - cordis context carrying `on`, `get` and `logger`.
 * @param options - `{ isEnabled, ratio, routeKeys }`.
 *   `isEnabled` and `ratio` are read at event time, so a live config edit
 *   applies without remounting the plugin.
 * @returns nothing; the listener lives as long as the plugin's fiber.
 */
export function installContextGuard(ctx, options) {
  const isEnabled = options?.isEnabled ?? (() => true)
  const ratio = options?.ratio ?? (() => DEFAULT_CONTEXT_GUARD_RATIO)
  const routeKeys = options?.routeKeys ?? (() => new Set())
  const log = makeLog(ctx)
  /** Sessions already reported as "above the guard with nothing left to prune". */
  const exhaustive = new WeakSet()
  /** Pressure of the last attempt that pruned nothing, per session. */
  const lastNoopPressure = new WeakMap()

  ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload?.agent
    const signal = payload?.signal
    try {
      if (agent !== undefined && signal?.aborted !== true && isEnabled()) {
        // The route is resolved first and cheaply: a session on somebody else's
        // provider must not even be measured.
        const target = routedTarget(agent.session)
        if (target !== undefined && routeKeys().has(target.provider)) {
          const found = await inspectRoute(ctx, agent.session, target, signal)
          const budget = guardTokens(found?.contextWindow, ratio(), found?.reservedTokens)
          if (found !== undefined && budget !== undefined && found.pressureTokens >= budget && signal?.aborted !== true) {
            const noopAt = lastNoopPressure.get(agent.session)
            if (noopAt === undefined || found.pressureTokens - noopAt >= PRUNE_RETRY_SLACK_TOKENS) {
              const { count, charsRemoved } = pruneToolResults(ctx, agent.session, log)
              if (count > 0) {
                lastNoopPressure.delete(agent.session)
                exhaustive.delete(agent.session)
                log('info', `[dsh-commandcode-goat] ${found.provider} is at ${found.pressureTokens} of ${found.contextWindow} tokens (guard ${budget}); pruned ${count} tool result(s) (${charsRemoved} chars) before this request`)
              } else {
                lastNoopPressure.set(agent.session, found.pressureTokens)
                if (exhaustive.has(agent.session) === false) {
                  exhaustive.add(agent.session)
                  log('info', `[dsh-commandcode-goat] ${found.provider} is at ${found.pressureTokens} of ${found.contextWindow} tokens (guard ${budget}) with nothing left to prune; leaving the rest to the harness' own compaction`)
                }
              }
            }
          } else {
            lastNoopPressure.delete(agent.session)
          }
        }
      }
    } catch (error) {
      log('warn', `[dsh-commandcode-goat] context guard failed: ${error instanceof Error ? error.message : String(error)}; continuing the turn`)
    }
    return next()
  })
}

/**
 * Install the gateway-overflow recovery hook.
 *
 * Two attempts per session, cheapest first: a deterministic tool-result prune
 * on the first refusal (no upstream call at all), and the same prune plus one
 * compaction region on the second. After that the original failure stands.
 *
 * @param ctx - cordis context carrying `on`, `get` and `logger`.
 * @param options - `{ isEnabled, ratio, routeKeys, maxAttempts }`.
 *   `isEnabled`, `ratio` and `routeKeys` are read at event time so a live config
 *   edit (the switch, the guard, or a tier switch) applies without remounting.
 * @returns nothing; the listener lives as long as the plugin's fiber.
 */
export function installOverflowRecovery(ctx, options) {
  const isEnabled = options?.isEnabled ?? (() => true)
  const ratio = options?.ratio ?? (() => DEFAULT_CONTEXT_GUARD_RATIO)
  const routeKeys = options?.routeKeys ?? (() => new Set())
  const maxAttempts = Number.isInteger(options?.maxAttempts) && options.maxAttempts > 0
    ? options.maxAttempts
    : DEFAULT_RECOVERY_ATTEMPTS
  const log = makeLog(ctx)

  /**
   * One reduction ladder per session. Keyed by the session rather than the
   * agent so a reused agent does not inherit another conversation's budget.
   */
  const attempts = new WeakMap()

  /**
   * Force one compaction region through whichever compaction backend this
   * profile composed.
   *
   * `compactIfNeeded(agent, 'context-overflow', …)` is the backend's own
   * overflow recovery and is the exact path the harness would have taken had it
   * classified this failure correctly, so it is preferred; it is not part of the
   * published `CompactionEngine` surface, hence the shape probe.
   *
   * The manual `compactNow` is *not* a fallback here: it runs through
   * `agent.runMaintenance`, which refuses while the agent has active work, and a
   * request error only ever happens inside a running turn — probing for it would
   * buy one guaranteed `busy` failure per attempt and a misleading log line.
   *
   * @param agent - agent whose session is reduced.
   * @param signal - live turn cancellation.
   * @returns whether a compaction region was committed.
   */
  const compact = async (agent, signal) => {
    const compaction = ctx.get?.('compaction')
    if (compaction === null || compaction === undefined) return false
    if (typeof compaction.compactIfNeeded !== 'function') {
      log('warn', '[dsh-commandcode-goat] this profile\'s compaction backend offers no mid-turn overflow entry point; prune only')
      return false
    }
    try {
      const result = await compaction.compactIfNeeded(agent, 'context-overflow', signal)
      return result !== null && result !== undefined
    } catch (error) {
      log('warn', `[dsh-commandcode-goat] overflow compaction failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * Whether this failure is one a too-large session explains.
   *
   * The gateway's own wording is always enough. A dropped or stalled stream is
   * only claimed when the session was already inside the guard budget, which is
   * what keeps an ordinary network hiccup in a small session out of the ladder.
   *
   * @param failure - the classified failure.
   * @param session - session that produced the request.
   * @param signal - live turn cancellation.
   * @returns true when the ladder should run.
   */
  const isOversizedSessionFailure = async (failure, session, signal) => {
    if (isGatewayOverflow(failure)) return true
    if (isSizeRelatedFailure(failure) === false) return false
    const target = routedTarget(session)
    if (target === undefined || routeKeys().has(target.provider) === false) return false
    const found = await inspectRoute(ctx, session, target, signal)
    const budget = guardTokens(found?.contextWindow, ratio(), found?.reservedTokens)
    if (found === undefined || budget === undefined) return false
    return found.pressureTokens >= budget
  }

  ctx.on('agent/request-error', async (payload, next) => {
    const agent = payload?.agent
    const failure = payload?.failure
    const provider = payload?.provider
    const signal = payload?.signal
    if (agent === undefined || failure === undefined) return next()
    if (failure.code === CONTEXT_WINDOW_EXCEEDED) return next()
    if (signal?.aborted === true) return next()
    // Everything below runs against a live failure: a throw here would replace
    // the provider's own error with a plugin bug, so the whole body degrades to
    // "leave the error as it is".
    try {
      if (!isEnabled() || routeKeys().has(provider) === false) return next()

      const session = agent.session
      if (await isOversizedSessionFailure(failure, session, signal) === false) return next()
      if (signal?.aborted === true) return next()

      const used = attempts.get(session) ?? 0
      if (used >= maxAttempts) {
        log('warn', `[dsh-commandcode-goat] ${provider} refused an oversized request again after ${used} recovery attempt(s); leaving the error as-is`)
        return next()
      }

      const generation = session?.surface?.replaceGeneration
      const { count: pruned } = pruneToolResults(ctx, session, log)
      if (signal?.aborted === true) return next()
      // Cheapest lever first, but never waste the attempt: a profile with no
      // tool-result pruner composed (or one that found nothing to rewrite) goes
      // straight to a compaction region instead of retrying an unchanged request.
      const compacted = used >= 1 || pruned === 0 ? await compact(agent, signal) : false
      const after = session?.surface?.replaceGeneration
      const progressed = generation === undefined || after === undefined
        ? pruned > 0 || compacted
        : after > generation
      if (progressed === false) {
        log('warn', `[dsh-commandcode-goat] nothing to reduce for ${provider}; leaving the error as-is`)
        return next()
      }
      if (signal?.aborted === true) return next()

      attempts.set(session, used + 1)
      log('info', `[dsh-commandcode-goat] ${provider} refused an oversized request; pruned ${pruned} tool result(s)${compacted ? ' and compacted one region' : ''}, retrying (attempt ${used + 1}/${maxAttempts})`)
      return { kind: 'retry' }
    } catch (error) {
      log('warn', `[dsh-commandcode-goat] oversized-request recovery failed: ${error instanceof Error ? error.message : String(error)}; leaving the error as-is`)
      return next()
    }
  })

  // A completed assistant message is the proof the session fits again, so the
  // next refusal starts a fresh ladder instead of inheriting this one's budget.
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'assistant/message') attempts.delete(session)
  })
}
