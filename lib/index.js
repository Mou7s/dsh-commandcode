/**
 * dsh-commandcode-goat — host half.
 *
 * Publishes a Command Code subscription (GOAT / Pro / Max) into DeepSeek
 * Harness as first-class provider routes, and adds the account surface the
 * gateway's own CLI has: usage, credit windows, and web search.
 *
 * ## Why this plugin owns no adapter
 *
 * It writes provider *profiles* into the first-party `llm-pi-ai` settings
 * section instead of implementing `LlmAdapter`. The harness then serves those
 * routes with the adapter it already ships, which is where streaming, tool
 * calling, reasoning dispatch, image handling and replay are implemented and
 * tested. An out-of-tree adapter would have to re-derive all of it from the
 * chunk protocol and stay correct across releases; a profile only has to state
 * facts — which endpoint, which protocol, which models, which capabilities.
 *
 * The trade is that the routes a profile creates are the provider plugin's,
 * not this plugin's, so what a sync writes is a user-visible section the user
 * can read and edit in Settings → Models. Syncing is therefore idempotent and
 * deliberately conservative — it refreshes `models` and never overwrites an
 * `apiKeyEnv`, `baseURL`, `compat` or `displayName` a route already carries —
 * but it is not hidden behind a button. `autoSync` is on by default, because a
 * plugin whose whole job is to make a subscription selectable otherwise looks
 * like it installed nothing at all: no provider row appears in
 * Settings → Models, so there is nowhere to put the key, and the plugin reads
 * as broken rather than as pending.
 *
 * The first tick is delayed rather than immediate: it writes into another
 * plugin's section, and doing that during startup races the provider plugin's
 * own registration. A few seconds of waiting costs nothing and removes the
 * race.
 *
 * ## What the two upstream sources are for
 *
 * `GET /provider/v1/models` is the live list and the routing truth — it states
 * which endpoints each model answers on. The GOAT plan page carries the
 * capability catalog the list omits: thinking, vision, and which subscription
 * tier each model starts at. Joining them is what lets one sync produce routes
 * that are both complete and correctly scoped to the user's tier.
 */

import Schema from '@deepseek-ai/schemastery'
import { readFileSync } from 'node:fs'

import {
  DEFAULT_ALPHA_BASE_URL,
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_CATALOG_URL,
  DEFAULT_SOURCE_URL,
  PLANS,
  buildEntries,
  fetchCatalog,
  fetchModelList,
  providerKey,
  tierAvailability,
} from './catalog.js'
import { SyncError, SYNC_CODES, pruneGeneratedRoutes, readPiAiValue, sectionsReferencing, syncPlan } from './pi-ai.js'
import { probeRoutes } from './probe.js'
import { catalogPageCandidates, parseGeneratedKey } from './plans.js'
import { describeUsage, fetchUsageReport } from './usage.js'
import { makeSearchProvider, makeSelectionController, SEARCH_PROVIDER_ID } from './search.js'
import { makeBridgeRoutes } from './bridge.js'
import { DEFAULT_CONTEXT_GUARD_RATIO, installContextGuard, installOverflowRecovery, routeKeySet } from './recovery.js'

/** Cordis plugin name. */
export const name = 'dsh-commandcode-goat'

/**
 * This build's version, read from the installed manifest.
 *
 * Reported through the settings bridge so the card can print it. Without it,
 * "which build is actually loaded" is unanswerable from the UI — and since a
 * `github:` install pins a commit in the lockfile, an update that was never
 * applied looks exactly like a fix that did not work.
 */
export const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
})()

/**
 * The row id this bundle's patch declares, for a context that cannot name it.
 *
 * This is the pairing key: the host half serves the settings section and the
 * browser half registers its card under it. Since dsh 0.1.7 a settings section
 * *is* a plugin entry, so the key is that entry's **row id** — `commandcode-goat`,
 * exactly as `cordis.patch.yml` declares it — and not this package's name, which
 * is a different string used for a different purpose (the client module id, and
 * the `plugins.bundle.config` address).
 *
 * It is only a fallback because the profile owns the row: the mount reads the
 * real id off the fiber, reports it through the bridge, and the card rebinds to
 * whatever the host says. This constant is what a context with no fiber — a
 * programmatic mount, a test — binds to.
 */
export const SETTINGS_NS = 'commandcode-goat'

/**
 * Nothing is hard-injected. Every seam this plugin uses — settings, web,
 * webServer, tools, credentials — is attached through an optional `ctx.inject`
 * so the row also loads in a headless or SDK profile where most of them are
 * absent, and simply does less there.
 */
export const inject = []

/** Ceiling on one sync's network work: two fetches and one settings write. */
export const SYNC_TIMEOUT_MS = 45_000

/** Default auto-sync cadence. A catalog this size does not move hourly. */
export const DEFAULT_AUTO_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Floor on the auto-sync cadence, so a mis-typed 0 cannot become a hot loop. */
export const MIN_AUTO_SYNC_INTERVAL_MS = 60_000
/** Larger native timer delays overflow to a one-millisecond wait in Node. */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

/**
 * The configuration fields one sync run actually reads.
 *
 * A sync publishes routes from exactly these: the tier, the two sources, the
 * ids and capabilities it merges in, the window cap, and the targeting the
 * route profiles carry (plus the sweep's own switch). Everything else a card
 * can change — the search switch, the usage tool, the guard ratio — has no
 * bearing on what gets written, and a reader who toggles one of them while
 * discovery is in flight must not turn a valid run into `config-changed`.
 */
export const SYNC_CONFIG_KEYS = [
  'plan',
  'sourceURL',
  'catalogURL',
  'extraIds',
  'includeReasoningEfforts',
  'maxContextWindow',
  'targetApiKeyEnv',
  'targetBaseURL',
  'targetCompat',
  'pruneOtherPlans',
]

/**
 * A comparable snapshot of the fields above.
 *
 * @param cfg - normalized plugin config.
 * @returns a stable string that changes only when a sync-relevant field does.
 */
export function syncConfigSignature(cfg) {
  return JSON.stringify(SYNC_CONFIG_KEYS.map((key) => cfg?.[key] ?? null))
}

/**
 * Ceiling on the catalog read a status call may wait for.
 *
 * Short on purpose: a card is being drawn, and a reader would rather see "not
 * known yet" beside a tier than a spinner in front of a page that is not
 * loading quickly. The sync that follows has its own, longer budget.
 */
export const CATALOG_WARMUP_TIMEOUT_MS = 8_000

/**
 * How long the first automatic sync waits after the plugin mounts.
 *
 * It writes into another plugin's settings section, so it has to let the rest
 * of the tree finish composing first — including the provider plugin whose
 * routes are being written. Long enough for that, short enough that a user who
 * restarts and immediately opens Settings → Models finds the provider row
 * already there.
 */
export const FIRST_SYNC_DELAY_MS = 15_000

/**
 * Read the capability catalog, following the selected tier's own page.
 *
 * The catalog is published on the Go, GOAT and Pro pages and is identical on
 * all three; the Max page carries a different payload with no catalog array in
 * it. So the default source is read as "whichever page states this tier's
 * catalog", with the page that always answers as the fallback — a Max user then
 * gets the same enriched sync as everyone else instead of a silent downgrade.
 * A source URL the user typed is used verbatim: following a tier is this
 * plugin's default behaviour, not something to impose on an explicit choice.
 *
 * @returns `{ entries, source, fallbackFrom }`; throws only when every
 *   candidate failed, so the caller can report the catalog as unavailable.
 */
export async function readCatalog({ catalogURL, plan, signal }) {
  const candidates = catalogURL === DEFAULT_CATALOG_URL ? catalogPageCandidates(plan) : [catalogURL]
  const failures = []
  for (const url of candidates) {
    signal?.throwIfAborted()
    try {
      const entries = await fetchCatalog(url, signal)
      const first = candidates[0]
      return { entries, source: url, fallbackFrom: url === first ? undefined : first }
    } catch (error) {
      signal?.throwIfAborted()
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(failures.join('; '))
}

const configSchema = Schema.object({
  sourceURL: Schema.string()
    .default(DEFAULT_SOURCE_URL)
    .description('Live model list. Answers with { data: [...] }.'),
  catalogURL: Schema.string()
    .default(DEFAULT_CATALOG_URL)
    .description('Official plan page carrying the per-model capability catalog; a failure here degrades the sync instead of failing it.'),
  plan: Schema.union(PLANS)
    .default('goat')
    .description('Subscription tier to generate providers for. Tiers are cumulative: pro includes goat, max includes both.'),
  targetApiKeyEnv: Schema.string()
    .default('')
    .description(`Credential reference the generated routes resolve their key through. Empty means ${DEFAULT_API_KEY_ENV}.`),
  targetBaseURL: Schema.string()
    .default('')
    .description(`Chat base URL written onto a route that has none. Empty means ${DEFAULT_BASE_URL}.`),
  targetCompat: Schema.object({
    thinkingFormat: Schema.string(),
    supportsReasoningEffort: Schema.boolean(),
  })
    .description('Override for the OpenAI-shaped route\'s compat block. Empty writes the reasoning-enabling default.'),
  extraIds: Schema.array(Schema.string())
    .default([])
    .description('Private model ids to publish alongside the catalog, on the OpenAI-shaped route.'),
  includeReasoningEfforts: Schema.boolean()
    .default(false)
    .description('Declare an identity effort map on models the catalog marks as reasoning. Off by default: the catalog names no wire values.'),
  maxContextWindow: Schema.number()
    .default(0)
    .description('Escape hatch, not a fix: cap the context window written onto every generated model, in tokens. 0 keeps whatever the vendor states, which is what a route should publish. Lowering it makes DSH summarise earlier — and permanently — instead of letting the session use the window the subscription sells, so reach for it only if the gateway refuses even reduced requests.'),
  recoverUpstreamOverflow: Schema.boolean()
    .default(true)
    .description('When Command Code refuses or drops a request the harness cannot classify as an overflow (the "path expansion / 512 candidates" 400, or a stream that ends or closes early while the session is already past the guard), prune oversized tool results and retry the request; on a second refusal, compact one region first. Keeps the vendor\'s own context window instead of capping it.'),
  contextGuardRatio: Schema.number()
    .default(DEFAULT_CONTEXT_GUARD_RATIO)
    .description(`Share of a route's own context window at which this plugin reduces the session before the next request goes out, through the harness' own tool-result pruner (no upstream call). DSH's own compaction line sits at min(0.8 × window, window − output reservation − 65536) — for a 1,000,000-token model that is 800,000 tokens, exactly where Command Code's gateway stops completing requests, so a session can be refused on the request that would have crossed it. The default ${DEFAULT_CONTEXT_GUARD_RATIO} fires earlier and leaves that margin; on a window small enough that the harness' own line is already earlier, the guard steps aside instead of second-guessing it, and 0 disables it everywhere. Only tool results are rewritten: summarization stays the harness' own decision at the harness' own threshold.`),
  autoSync: Schema.boolean()
    .default(true)
    .description('Create the generated routes on first load and refresh them on the configured interval, so the provider row appears in Settings → Models without anyone having to find a button. On by default; set it false to make every write an explicit action.'),
  pruneOtherPlans: Schema.boolean()
    .default(true)
    .description('After a sync, delete the routes this plugin generated for any other tier, so a switch leaves no provider behind that the account can no longer use. Only keys this plugin generates are touched, and a route carrying modelOverrides is reported instead of deleted.'),
  autoSyncIntervalMs: Schema.number()
    .default(DEFAULT_AUTO_SYNC_INTERVAL_MS)
    .description('Auto-sync cadence in milliseconds; at least one minute.'),
  webSearch: Schema.boolean()
    .default(false)
    .description('Back the model-facing web_search tool with this account, so no separate search credential is needed.'),
  usageBaseURL: Schema.string()
    .default(DEFAULT_ALPHA_BASE_URL)
    .description('API root for the /alpha/* usage and search endpoints, distinct from the chat base.'),
  enableUsageTool: Schema.boolean()
    .default(true)
    .description('Register the commandcode_usage tool so a model can read the account itself.'),
  enableBridge: Schema.boolean()
    .default(true)
    .description('Serve the loopback-only endpoints the settings card calls.'),
})

/**
 * Every field of this plugin is a user preference, so every field is
 * `volatile()`.
 *
 * Since dsh 0.1.7 that marker is what makes a Config field configurable at all:
 * it decides which fields `settings.describe()` projects into a form, which
 * field paths a settings write accepts, and — because a volatile value is
 * handed to the plugin as a live reference rather than a copy — how a running
 * instance learns that the user changed something without being remounted.
 * Marking is per field, and a volatile field may not sit inside another one,
 * which the flat shape here satisfies. `volatile()` returns a marked copy
 * rather than mutating, so each field is replaced by its marked form.
 *
 * The method arrived in schemastery 3.18.4. A deployment resolves this plugin's
 * own dependency range, not the harness's copy, so an older schemastery can
 * reach here — and it must not take the entry down at import time, where
 * "failed to import" names no cause and hides that everything else still works.
 */
export const fieldVolatility = (() => {
  for (const [key, field] of Object.entries(configSchema.dict ?? {})) {
    if (typeof field?.volatile !== 'function') return 'unsupported'
    configSchema.dict[key] = field.volatile()
  }
  return 'configured'
})()

export const Config = configSchema

/**
 * Resolve a config snapshot into the plain shape the rest of the module reads.
 *
 * Schemastery has already applied defaults and rejected wrong types by the time
 * this runs; what is left is the empty-string convention, which cannot be
 * expressed in the schema because each empty field means "use this other
 * default" rather than "unset".
 */
export function normalizeConfig(config) {
  /**
   * Read a config field's current value.
   *
   * A `volatile()` field does not arrive as its value: since dsh 0.1.7 the
   * loader hands the plugin a live reference and updates it in place, so the
   * value must be read through `get()` at the moment it is wanted. Duck-typing
   * the reference keeps a build working on a host that hands the plain value
   * instead.
   */
  const live = (value) => (
    value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
  )
  const raw = Object.fromEntries(Object.entries(config ?? {}).map(([key, value]) => [key, live(value)]))
  const number = (value, fallback, minimum) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback
  }
  const text = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)
  return {
    sourceURL: text(raw.sourceURL, DEFAULT_SOURCE_URL),
    catalogURL: text(raw.catalogURL, DEFAULT_CATALOG_URL),
    plan: PLANS.includes(raw.plan) ? raw.plan : 'goat',
    targetApiKeyEnv: text(raw.targetApiKeyEnv, DEFAULT_API_KEY_ENV),
    targetBaseURL: text(raw.targetBaseURL, DEFAULT_BASE_URL),
    targetCompat: raw.targetCompat,
    extraIds: Array.isArray(raw.extraIds) ? raw.extraIds.filter((id) => typeof id === 'string' && id.trim() !== '') : [],
    includeReasoningEfforts: raw.includeReasoningEfforts === true,
    // 0 (and anything unusable) means "publish the vendor's number".
    maxContextWindow: number(raw.maxContextWindow, 0, 0),
    recoverUpstreamOverflow: raw.recoverUpstreamOverflow !== false,
    // A share of the route's window; an unusable value falls back to the
    // documented default, and 0 (or a share the harness' own compaction line
    // already meets) means there is no guard to apply.
    contextGuardRatio: number(raw.contextGuardRatio, DEFAULT_CONTEXT_GUARD_RATIO, 0),
    autoSync: raw.autoSync !== false,
    pruneOtherPlans: raw.pruneOtherPlans !== false,
    autoSyncIntervalMs: number(raw.autoSyncIntervalMs, DEFAULT_AUTO_SYNC_INTERVAL_MS, MIN_AUTO_SYNC_INTERVAL_MS),
    webSearch: raw.webSearch === true,
    usageBaseURL: text(raw.usageBaseURL, DEFAULT_ALPHA_BASE_URL),
    enableUsageTool: raw.enableUsageTool !== false,
    enableBridge: raw.enableBridge !== false,
  }
}

/**
 * Mount the plugin.
 *
 * @param ctx - the plugin's cordis context.
 * @param config - the resolved composition entry.
 */
export function apply(ctx, config) {
  /**
   * The row id the profile composed this plugin under.
   *
   * Since dsh 0.1.7 a settings section *is* a plugin entry: `describe()` keys
   * its descriptors by that row's id, and a write addresses the entry by it. So
   * this id is also the namespace the browser half binds its form to, and the
   * host reports it rather than letting the card assume one.
   */
  const entryId = ctx.fiber?.entry?.options.id ?? SETTINGS_NS
  /**
   * Without the marker there is no form and no writable field on this entry, so
   * say so once, in the log, with the actual cause — a silently unconfigurable
   * plugin is the worst of the available outcomes.
   */
  if (fieldVolatility !== 'configured') {
    ctx.logger?.warn?.(
      `[${name}] the resolved @deepseek-ai/schemastery has no Schema.volatile() (it arrived in 3.18.4), so this plugin's settings cannot be edited; install a newer schemastery for this profile`,
    )
  }
  // Volatile fields are live references, so this reads whatever is current
  // rather than a snapshot taken when the plugin was mounted.
  const resolved = () => normalizeConfig(config)
  const settingsService = () => ctx.get('settings')
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(), 'dsh-commandcode-goat: pending requests')
  const operationSignal = (timeout, caller) => {
    const deadline = AbortSignal.timeout(timeout)
    // Node 20.0 lacks AbortSignal.any; linking the lifetime to a per-operation
    // controller keeps the declared minimum runtime supported.
    const controller = new AbortController()
    const sources = [lifetime.signal, deadline, ...(caller ? [caller] : [])]
    const release = () => {
      for (const source of sources) source.removeEventListener('abort', abort)
    }
    const abort = () => {
      controller.abort()
      release()
    }
    if (sources.some((source) => source.aborted)) abort()
    else {
      for (const source of sources) source.addEventListener('abort', abort, { once: true })
    }
    return { signal: controller.signal, release }
  }

  // ── credential ─────────────────────────────────────────────────────────────
  /**
   * The account key, resolved once per operation rather than cached, so a key
   * stored through Settings → Models reaches the next call without a restart.
   * The credentials seam already layers the managed store, the environment and
   * `.env` files; the direct `process.env` read is the fallback for a
   * deployment that loads no credential provider at all.
   */
  const resolveKey = async () => {
    const envName = resolved().targetApiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      try {
        const found = await credentials.resolve(envName)
        if (typeof found?.value === 'string' && found.value !== '') return found.value
      } catch { /* fall through to the launch environment */ }
    }
    const ambient = process.env?.[envName]
    return typeof ambient === 'string' && ambient !== '' ? ambient : undefined
  }

  /**
   * Where the account key resolves from, for the card to *state* rather than
   * assert. Reads the same two sources in the same order as {@link resolveKey},
   * so the two can never disagree about whether a key exists — a card that
   * says "not configured" beside a usage panel that just read the account is
   * self-contradicting, and the reader has no way to tell which half is wrong.
   *
   * Reports only the source and the reference name; never the value.
   */
  const keyState = async () => {
    const envName = resolved().targetApiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      try {
        const found = await credentials.resolve(envName)
        if (typeof found?.value === 'string' && found.value !== '') {
          return { configured: true, source: found.source === 'env' ? 'environment' : 'credentials', envName }
        }
      } catch { /* fall through to the launch environment */ }
    }
    const ambient = process.env?.[envName]
    if (typeof ambient === 'string' && ambient !== '') return { configured: true, source: 'environment', envName }
    return { configured: false, source: 'none', envName }
  }

  // ── sync ───────────────────────────────────────────────────────────────────
  let providerWriteActive = false
  const withProviderWrite = async (operation) => {
    if (lifetime.signal.aborted) throw new SyncError('plugin-stopped', 'plugin has been unloaded')
    if (providerWriteActive) throw new SyncError('sync-busy', 'a provider sync or cleanup is already running; retry when it finishes')
    providerWriteActive = true
    try {
      return await operation()
    } finally {
      providerWriteActive = false
    }
  }
  /**
   * What the last read of both sources saw.
   *
   * The card has to answer "how many models does each tier select" for four
   * tiers, and that is a pure function of the model list and the catalog. Both
   * are already fetched on every sync, so the answer is remembered here rather
   * than paid for again on every status read — `describe` is called on a
   * cadence, and a docs page per call would be a strange way to draw a card.
   */
  let lastFacts = { apiList: [], catalog: [], at: 0 }

  /**
   * The most recent account read, so a status read can state the subscription
   * without asking the account again. It is a plan id that changes monthly, not
   * a balance; the usage panel keeps its own copy fresh and overwrites this.
   */
  let lastUsage
  let usageReadGeneration = 0

  /** One in-flight catalog warm-up, so a burst of status reads shares it. */
  let catalogWarmup

  /**
   * Give a status read the capability catalog when no sync has run yet.
   *
   * The per-tier model counts are a pure function of the catalog, and the first
   * sync is deliberately fifteen seconds after the plugin mounts. Without this,
   * anyone who opens the card inside that window sees four tiers whose figures
   * have not been read yet, which reads as a card that failed rather than as one
   * that is waiting. So the first status read that finds the cache cold fetches
   * the single page those counts need — deduped, with its own short ceiling, and
   * never at the cost of the status read: a failure here leaves the counts
   * unknown, which is exactly what the card already knows how to say.
   */
  const ensureCatalog = () => {
    if (lastFacts.catalog.length > 0) return Promise.resolve()
    if (catalogWarmup !== undefined) return catalogWarmup
    const cfg = resolved()
    catalogWarmup = (async () => {
      const operation = operationSignal(CATALOG_WARMUP_TIMEOUT_MS)
      try {
        const read = await readCatalog({
          catalogURL: cfg.catalogURL,
          plan: cfg.plan,
          signal: operation.signal,
        })
        if (!operation.signal.aborted) lastFacts = { ...lastFacts, catalog: read.entries, at: Date.now() }
      } catch {
        /* an optional enrichment must never fail a status read */
      } finally {
        operation.release()
        catalogWarmup = undefined
      }
    })()
    return catalogWarmup
  }

  /** The routes this plugin generated for a tier other than the selected one. */
  const staleRoutes = () => {
    const providers = readPiAiValue(settingsService())?.providers
    if (providers === null || typeof providers !== 'object') return []
    const plan = resolved().plan
    const stale = []
    for (const [key, profile] of Object.entries(providers)) {
      const parsed = parseGeneratedKey(key)
      if (parsed === undefined || parsed.plan === plan) continue
      stale.push({
        key,
        plan: parsed.plan,
        slot: parsed.slot,
        models: Array.isArray(profile?.models) ? profile.models.length : 0,
      })
    }
    return stale
  }

  /**
   * Read both sources, join them, and write the selected tier's route set.
   *
   * The write is followed by the sweep, in that order: a prune that ran first
   * would delete the routes the account can still use and then leave the user
   * with nothing if the write was refused.
   *
   * @param options - `{ dryRun, sweep }`. `dryRun` reports what would be
   *   written without writing; `sweep` decides whether the other tiers' routes
   *   are removed afterwards. The sweep belongs to the button, not to the
   *   timer: a background tick must never delete another tier's configuration
   *   behind a reader who is in the middle of switching, and a profile that
   *   composes two rows to publish two plans would otherwise have each row
   *   delete the other's routes at startup.
   * @returns the sync report the card renders.
   */
  const performSync = async ({ dryRun = false, sweep = true } = {}) => {
    const settings = settingsService()
    const cfg = resolved()
    const diagnostics = []
    const operation = operationSignal(SYNC_TIMEOUT_MS)
    const { signal } = operation
    try {
      signal.throwIfAborted()

      let apiList
      try {
        apiList = await fetchModelList(cfg.sourceURL, signal)
      } catch (error) {
        throw new SyncError(
          SYNC_CODES.fetch,
          `could not read the model list from ${cfg.sourceURL}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (apiList.length === 0) {
        throw new SyncError(SYNC_CODES.fetch, `${cfg.sourceURL} answered with no models`)
      }

      let catalog = []
      let catalogAvailable = true
      try {
        const read = await readCatalog({ catalogURL: cfg.catalogURL, plan: cfg.plan, signal })
        catalog = read.entries
        if (read.fallbackFrom !== undefined) {
          diagnostics.push(`the ${cfg.plan} plan page states no model catalog, so capabilities were read from ${read.source}`)
        }
      } catch (error) {
        catalogAvailable = false
        diagnostics.push(`capability catalog could not be read (${error instanceof Error ? error.message : String(error)})`)
      }

      signal.throwIfAborted()
      if (syncConfigSignature(resolved()) !== syncConfigSignature(cfg)) {
        throw new SyncError('config-changed', 'plugin configuration changed during sync; run Create / Update again')
      }
      // Both payloads are in hand, which is everything the per-tier counts need —
      // including on a dry run, where nothing else is written.
      lastFacts = { apiList, catalog, at: Date.now() }

      const { routes, diagnostics: built, channels } = buildEntries({
        apiList,
        catalog,
        plan: cfg.plan,
        extraIds: cfg.extraIds,
        includeReasoningEfforts: cfg.includeReasoningEfforts,
        maxContextWindow: cfg.maxContextWindow,
      })
      diagnostics.push(...built)

      const counts = Object.fromEntries(
        Object.entries(routes).map(([route, entries]) => [providerKey(cfg.plan, route), entries.length]),
      )
      const report = {
        plan: cfg.plan,
        dryRun,
        catalog: { available: catalogAvailable, entries: catalog.length },
        live: apiList.length,
        counts,
        // Which protocol channels exist is only half the answer; the card also
        // needs to say why one is missing, and that is a fact about the live
        // list rather than about the write.
        channels,
        diagnostics,
        ...lastUsage?.subscription === undefined ? {} : { subscription: lastUsage.subscription },
      }
      if (dryRun) return { ...report, pruned: [] }

      const written = await syncPlan({
        settings,
        plan: cfg.plan,
        routes,
        cfg: {
          targetApiKeyEnv: cfg.targetApiKeyEnv,
          targetBaseURL: cfg.targetBaseURL,
          targetCompat: cfg.targetCompat,
        },
      })
      ctx.logger?.info?.(
        `[${name}] synced ${cfg.plan}: ${written.routes.map((route) => `${route.key}=${route.count}`).join(', ')}`,
      )

      // ── what the routes answer, not just that they were written ────────────
      /**
       * Probe each route this sync just wrote, with the smallest request its
       * protocol accepts.
       *
       * A settings write can only prove the *config* is internally consistent —
       * it cannot prove the URL exists. Every Claude request answered 404 for a
       * month while this card said the sync succeeded, because nothing had ever
       * put a request on the wire down the route it had just described. The
       * request is tiny and the probe reports instead of throwing: a route that
       * fails to answer is a fact about the deployment, not a reason to undo a
       * write that the harness may still serve.
       */
      const probeTargets = written.routes
        .map(({ route, key: routeKey }) => ({
          route,
          key: routeKey,
          // The base the route actually carries, which is the reader's value
          // when they edited one — probing the value this plugin *would* have
          // written would report on a configuration nobody is using.
          baseURL: readPiAiValue(settings)?.providers?.[routeKey]?.baseURL ?? cfg.targetBaseURL,
          model: routes[route]?.[0]?.id,
        }))
        .filter((target) => typeof target.model === 'string' && target.model !== '')
      let routeChecks
      if (probeTargets.length > 0 && !signal.aborted) {
        const probeOperation = operationSignal(30_000, signal)
        try {
          routeChecks = await probeRoutes({
            targets: probeTargets,
            apiKey: await resolveKey(),
            signal: probeOperation.signal,
          })
        } catch (error) {
          // Probing is a report, never a precondition.
          routeChecks = [{ skipped: 'malformed', detail: error instanceof Error ? error.message : String(error) }]
        } finally {
          probeOperation.release()
        }
      }
      const checkedRoutes = written.routes.map((entry) => {
        const probe = routeChecks?.find((check) => check.key === entry.key)
        return probe === undefined ? entry : { ...entry, probe }
      })

      let pruned = []
      if (sweep && cfg.pruneOtherPlans && !signal.aborted && syncConfigSignature(resolved()) === syncConfigSignature(cfg)) {
        try {
          const sweepResult = await pruneGeneratedRoutes({ settings, plan: cfg.plan })
          pruned = sweepResult.removed
          if (sweepResult.protected.length > 0) {
            diagnostics.push(`left in place because it declares modelOverrides: ${sweepResult.protected.join(', ')}`)
          }
          if (pruned.length > 0) {
            ctx.logger?.info?.(`[${name}] removed the routes of the previous tier: ${pruned.join(', ')}`)
            // The profile can point at a route by name; deleting it would then
            // take the reader's default model with it, silently.
            const referenced = sectionsReferencing(settings, pruned)
            if (referenced.length > 0) {
              diagnostics.push(`still refers to a removed provider, and has to be updated: ${referenced.join('; ')}`)
            }
          }
        } catch (error) {
          // A failed sweep must not turn a successful sync into a failure: the
          // routes the user needs are already written.
          diagnostics.push(`the routes of the previous tier could not be removed (${error instanceof Error ? error.message : String(error)})`)
        }
      }

      return { ...report, diagnostics, routes: checkedRoutes, skipped: written.skipped, pruned }
    } finally {
      operation.release()
    }
  }
  const syncOnce = (options) => withProviderWrite(() => performSync(options))

  // ── usage ──────────────────────────────────────────────────────────────────
  /**
   * Read the account surface with the configured key.
   *
   * @param base - optional API root override from the card.
   * @param signal - optional caller cancellation.
   */
  const readUsage = async (base, signal) => {
    const generation = ++usageReadGeneration
    // A new read may belong to another credential or account. Never retain an
    // old subscription when this read fails or omits subscription information.
    lastUsage = undefined
    const cfg = resolved()
    const root = typeof base === 'string' && base.trim() !== '' ? base.trim() : cfg.usageBaseURL
    if (!URL.canParse(root)) {
      throw new SyncError('usage-misconfigured', `usage base ${JSON.stringify(root)} is not a valid URL`)
    }
    const key = await resolveKey()
    if (key === undefined) {
      throw new SyncError(
        SYNC_CODES.noKey,
        `no "${cfg.targetApiKeyEnv}" credential is configured; store it in Settings → Models or export it before launch`,
      )
    }
    const operation = operationSignal(60_000, signal)
    try {
      operation.signal.throwIfAborted()
      const report = await fetchUsageReport(key, root, operation.signal)
      // Remembered for the status read, which states the account's own tier
      // beside the configured one without asking the account a second time.
      if (generation === usageReadGeneration && !operation.signal.aborted) lastUsage = report
      return report
    } finally {
      operation.release()
    }
  }

  // ── web search ─────────────────────────────────────────────────────────────
  let applySearchSelection = () => {}
  /** Re-applied on every volatile update, like the search selection. */
  let applyUsageTool = () => {}
  let searchReport = () => ({ registered: false, enabled: false, selected: SEARCH_PROVIDER_ID })

  ctx.inject(['web'], (webCtx) => {
    const web = webCtx.web
    const provider = makeSearchProvider({
      isEnabled: () => resolved().webSearch,
      apiBase: () => resolved().usageBaseURL,
      keyEnv: () => resolved().targetApiKeyEnv,
      resolveKey,
    })
    const disposeProvider = web.registerSearchProvider(provider)
    const select = makeSelectionController(web)
    const sync = () => {
      try {
        select(resolved().webSearch === true)
      } catch {
        /* a runtime whose selection cannot be written keeps its own choice */
      }
    }
    applySearchSelection = sync
    searchReport = () => ({
      registered: true,
      enabled: resolved().webSearch === true,
      selected: web.searchProviderId,
    })
    sync()
    // The web service registers a provider on its own fiber, so the returned
    // disposer is the only thing that unregisters it when this fiber unloads.
    webCtx.effect(() => () => {
      // A dependency can unload while the plugin and volatile listener remain.
      // Forget this injection's callbacks before touching the disappearing service.
      if (applySearchSelection === sync) {
        applySearchSelection = () => {}
        searchReport = () => ({ registered: false, enabled: false, selected: undefined })
      }
      try {
        select(false)
      } catch { /* the web runtime may already be gone */ }
      disposeProvider()
    }, 'dsh-commandcode-goat: web search')
  })

  // ── live configuration ─────────────────────────────────────────────────────
  /**
   * A volatile edit does not remount the plugin; it re-resolves the config and
   * fires this event. Nothing else re-reads the fields — they are live
   * references — so the two things derived from them that live in *another*
   * service have to be re-applied here: the search provider selection, and the
   * registration of the usage tool.
   */
  ctx.on('loader/volatile-update', () => {
    applySearchSelection()
    applyUsageTool()
  })

  // ── auto-sync ──────────────────────────────────────────────────────────────
  /**
   * The timer runs whether or not the toggle is currently on, and each tick
   * decides for itself.
   *
   * That is not incidental. Both the toggle and the interval are volatile
   * fields: the card flips them without remounting the plugin, so a value
   * captured when this effect ran would keep syncing — or keep refusing to —
   * against the user's decision until the profile restarted. Reading them at
   * the moment they are used is what makes the switch mean something the first
   * time it is touched. An off tick costs one comparison.
   */
  ctx.effect(() => {
    let handle
    let stopped = false
    const tick = async () => {
      if (stopped || resolved().autoSync !== true) return
      try {
        // The timer writes but never sweeps: removing another tier's routes is
        // the Create / Update button's job, and doing it from a background tick
        // would delete a configuration nobody asked it to touch.
        const result = await syncOnce({ sweep: false })
        // Nobody is looking at the card, so this is the only place a degraded
        // background sync can be noticed: without the capability catalog every
        // model counts as inside the selected tier, which publishes models the
        // subscription may not cover. The write still happened; say so loudly
        // rather than letting it pass as an ordinary tick.
        if (result.catalog?.available === false) {
          ctx.logger?.warn?.(
            `[${name}] auto-sync could not read the capability catalog, so every model was published to the ${result.plan} tier; run Create / Update once the catalog is reachable`,
          )
        }
      } catch (error) {
        ctx.logger?.warn?.(`[${name}] auto-sync failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    /**
     * Schedule the next tick from the config as it stands *after* this one, so
     * a changed interval reaches the next wait rather than the one after it.
     */
    const schedule = (delay) => {
      handle = setTimeout(async () => {
        if (stopped) return
        if (delay > MAX_TIMER_DELAY_MS) {
          schedule(delay - MAX_TIMER_DELAY_MS)
          return
        }
        await tick()
        if (stopped) return
        schedule(resolved().autoSyncIntervalMs)
      }, Math.min(delay, MAX_TIMER_DELAY_MS))
      handle?.unref?.()
    }
    // The first tick waits for the rest of the tree: auto-sync writes into
    // another plugin's section, and doing that during startup would race the
    // provider plugin's own registration.
    schedule(FIRST_SYNC_DELAY_MS)
    return () => {
      stopped = true
      clearTimeout(handle)
    }
  }, 'dsh-commandcode-goat: auto-sync')

  // ── usage tool ─────────────────────────────────────────────────────────────
  /**
   * The `commandcode_usage` tool, registered and released as its switch moves.
   *
   * `enableUsageTool` is a volatile field: the card writes it without remounting
   * the plugin, so a registration decided once at mount kept offering the tool
   * after the reader switched it off — the switch said one thing and the model's
   * tool list another, and the account kept paying for calls the user had
   * declined. `tools.register` returns the exact disposer that unregisters, so
   * the same tick that registers can release, and the volatile-update handler
   * runs it.
   */
  ctx.inject(['tools'], (toolsCtx) => {
    const definition = {
      name: 'commandcode_usage',
      description:
        'Read the Command Code account behind the commandcode provider routes: subscription plan, request and cost totals for the current period, credit balances, and the rolling 5-hour and weekly request windows.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(_args, exec) {
        const report = await readUsage(undefined, exec?.signal)
        return `${describeUsage(report)}\n\n${JSON.stringify(report, null, 2)}`
      },
    }
    /** The live registration, or undefined while the tool is switched off. */
    let dispose
    const apply = () => {
      const wanted = resolved().enableUsageTool === true
      if (wanted === (dispose !== undefined)) return
      if (wanted) dispose = toolsCtx.tools.register(definition)
      else {
        dispose?.()
        dispose = undefined
      }
    }
    applyUsageTool = apply
    apply()
    toolsCtx.effect(() => () => {
      if (applyUsageTool === apply) applyUsageTool = () => {}
      dispose?.()
      dispose = undefined
    }, 'dsh-commandcode-goat: usage tool')
  })

  // ── upstream-overflow guard and recovery ───────────────────────────────────
  /**
   * The three provider keys this plugin's routes occupy, resolved from the live
   * config so a tier switch is picked up without a restart. Both the guard, the
   * recovery hook and the settings card need the same answer, and none may
   * cache it: `plan` is a volatile field, and a stale key here would silently
   * stop them from recognising this plugin's own routes.
   */
  const targetKeys = () => {
    const plan = resolved().plan
    return {
      openai: providerKey(plan, 'openai'),
      anthropic: providerKey(plan, 'anthropic'),
      responses: providerKey(plan, 'responses'),
    }
  }

  /**
   * DSH compacts at 0.8 of the declared window; Command Code's gateway stops
   * completing requests right about there, so a session can sit one step short
   * of that line and be refused on the request that would have crossed it. The
   * guard reduces the session earlier — through the harness' own tool-result
   * pruner, and only for this plugin's routes. See `lib/recovery.js`.
   */
  installContextGuard(ctx, {
    isEnabled: () => resolved().recoverUpstreamOverflow === true,
    ratio: () => resolved().contextGuardRatio,
    routeKeys: () => routeKeySet(targetKeys()),
  })

  /**
   * Command Code refuses a request it cannot expand with a 400 the harness
   * reads as an ordinary invalid request, and drops an oversized one as a
   * transport failure its retry policy resends unchanged; either way the
   * harness' own overflow recovery — prune, compact once, retry — never fires
   * and the turn dies. This restores that recovery for this plugin's routes
   * only, which is what lets the models keep publishing the window the
   * subscription actually sells instead of a capped one.
   */
  installOverflowRecovery(ctx, {
    isEnabled: () => resolved().recoverUpstreamOverflow === true,
    ratio: () => resolved().contextGuardRatio,
    routeKeys: () => routeKeySet(targetKeys()),
  })

  // ── settings card bridge ───────────────────────────────────────────────────
  if (resolved().enableBridge) {
    ctx.inject(['webServer'], (webCtx) => {
      const routes = makeBridgeRoutes({
        entryId,
        version: PLUGIN_VERSION,
        config: resolved,
        settings: settingsService,
        targetKeys,
        sync: syncOnce,
        usage: (base) => readUsage(base),
        search: () => searchReport(),
        keyState,
        /**
         * The four tiers as the card draws them: the vendor's title, its page,
         * its price and default quota from `plans.js`, and the two counts that
         * come from the last sync — how many models the catalog gives the tier,
         * and how many of those the live list currently serves.
         */
        tiers: async () => {
          await ensureCatalog()
          const availability = tierAvailability(lastFacts)
          return availability.map((row) => ({ ...row }))
        },
        stale: staleRoutes,
        subscription: () => lastUsage?.subscription,
        prune: (plan) => withProviderWrite(async () => {
          const target = PLANS.includes(plan) ? plan : resolved().plan
          const settings = settingsService()
          const sweep = await pruneGeneratedRoutes({ settings, plan: target })
          return {
            plan: target,
            removed: sweep.removed,
            kept: sweep.kept,
            protected: sweep.protected,
          }
        }),
      })
      webCtx.effect(() => {
        const disposers = routes.map((route) => webCtx.webServer.register(route))
        return () => {
          for (const dispose of disposers) dispose()
        }
      }, 'dsh-commandcode-goat: settings bridge')
    })
  }
}

export default { name, inject, Config, apply }
