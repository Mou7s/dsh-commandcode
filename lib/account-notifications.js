import { createHash } from 'node:crypto'

export const DEFAULT_ALERT_THRESHOLDS = { enabled: false, fiveHourPercent: 80, weeklyPercent: 80, balanceBelow: 5 }
export function validateAlertThresholds(input = {}) {
  const value = { ...DEFAULT_ALERT_THRESHOLDS, ...input }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('alertThresholds must be an object')
  for (const key of Object.keys(input)) if (!(key in DEFAULT_ALERT_THRESHOLDS)) throw new TypeError(`unknown alert setting: ${key}`)
  if (typeof value.enabled !== 'boolean') throw new TypeError('alert enabled must be boolean')
  for (const key of ['fiveHourPercent', 'weeklyPercent']) {
    if (!Number.isFinite(value[key]) || value[key] <= 0 || value[key] > 100) throw new TypeError(`${key} must be >0 and <=100`)
  }
  if (!Number.isFinite(value.balanceBelow) || value.balanceBelow < 0) throw new TypeError('balanceBelow must be non-negative')
  return value
}
const fingerprint = (parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24)

/** State is per credential/config identity; unchanged pressure produces no new event. */
export function evaluateAlerts(report, thresholds, previous = {}, now = Date.now()) {
  const cfg = validateAlertThresholds(thresholds)
  if (!cfg.enabled) return { state: {}, events: [] }
  const state = { ...previous }, events = []
  const measure = (key, value, limit, low = false, resetAt) => {
    if (!Number.isFinite(value)) return
    const active = low ? value <= limit : value >= limit
    const old = previous[key]
    state[key] = { active, resetAt: resetAt ?? null }
    if (!active || old?.active && old.resetAt === state[key].resetAt) return
    events.push({ id: fingerprint(['quota', key, state[key].resetAt, now]), type: 'quota', key, value, threshold: limit, at: now, read: false })
  }
  for (const [key, field] of [['fiveHour', 'fiveHourPercent'], ['weekly', 'weeklyPercent']]) {
    const window = report?.credits?.[key]
    if (window?.cap > 0 && Number.isFinite(window.used)) measure(key, window.used / window.cap * 100, cfg[field], false, window.resetAt)
  }
  const credits = report?.credits
  if (credits && credits.balanceKnown !== false && ['monthlyCredits', 'purchasedCredits', 'freeCredits'].every((key) => Number.isFinite(credits[key]))) {
    measure('balance', credits.monthlyCredits + credits.purchasedCredits + credits.freeCredits, cfg.balanceBelow, true)
  }
  return { state, events }
}

export function modelChangeEvents(diff, now = Date.now()) {
  const events = []
  for (const type of ['added', 'removed', 'updated']) for (const model of diff[type] ?? []) {
    events.push({ id: fingerprint(['model', type, model.route, model.id, model.after ?? model, now]), type: 'model', change: type,
      model: model.id, route: model.route, fields: model.fields ?? [], name: model.name ?? model.after?.name ?? model.id, at: now, read: false })
  }
  return events
}

export function appendNotifications(existing = [], incoming = [], max = 100) {
  const seen = new Set()
  return [...incoming, ...existing].filter((event) => {
    if (!event || typeof event.id !== 'string' || seen.has(event.id)) return false
    seen.add(event.id)
    return true
  }).slice(0, max)
}
