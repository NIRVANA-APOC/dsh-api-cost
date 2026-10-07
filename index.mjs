/**
 * dsh-api-cost — Host half.
 *
 * Real-time cost accounting for DeepSeek API usage, with peak / off-peak rates.
 *
 * The Host is the authoritative meter. For every model call it sees which model
 * was asked and how many tokens the provider reported, and it prices that call
 * at the rate tier that was in force at the moment the call settled. The Client
 * half only renders what this half reports — it never re-derives a price, so
 * there is exactly one place where billing can be wrong.
 *
 * Wiring:
 *   `llm/stream`            waterfall — the frozen call config (provider/model)
 *                           and its `sessionId`, captured per request.
 *   `agent/assistant-stream` emit     — `usage` chunks joined to the pending call.
 *
 * Serving:
 *   GET /dsh-api-cost/api          → full snapshot (pricing status + rate card + session)
 *   GET /dsh-api-cost/api/session  → one session's ledger (cheaper poll for the widget)
 *   GET /dsh-api-cost/api/status   → pricing window only
 *
 * The prefix is deliberately NOT under `/api`: that bridge belongs to the
 * connection layer and enforces its own request trust policy (a bare GET from
 * the page is answered 401). A package-owned path is served by the webserver
 * directly, which is also how the other pricing widgets in this ecosystem
 * expose their host half.
 *
 * Also registers a `session_cost` tool and a `/cost` command so the number is
 * reachable without the GUI.
 *
 * Pricing semantics, verified against real DSH usage records on this machine:
 * DSH normalizes DeepSeek's usage into four DISJOINT buckets —
 *   inputTokens        cache MISS input
 *   cacheReadTokens    cache HIT input
 *   cacheWriteTokens   cache WRITE input (0 for DeepSeek; billed as a miss)
 *   outputTokens       completion (reasoning tokens are a subset of this)
 * and `totalTokens` is the sum of those, which is how the disjointness was
 * confirmed (459 + 10496 + 294 = 11249). Never compute `inputTokens -
 * cacheReadTokens`: it goes negative in real data.
 *
 * `lib/pricing.mjs` owns the published rate card and the peak/off-peak
 * calendar; this file only decides *when* to sample the tier and *how* to
 * accumulate.
 */

import {
  PEAK_POLICY_FROM,
  RATE_CARD,
  RATE_CARD_EFFECTIVE_FROM,
  classifyInstant,
  formatCny,
  formatTokens,
  formatUsd,
  nextBoundary,
  priceUsage,
  resolveModel,
} from './lib/pricing.mjs'

/** Plugin name; also the diagnostic prefix in every log line. */
export const name = 'dsh-api-cost'

/**
 * Services this plugin reads. `webServer` is the only hard dependency; the
 * tool and command registries are optional so a composition without them still
 * gets the HTTP snapshot.
 */
export const inject = ['webServer']

/** How many requests one session's ledger keeps before the oldest is dropped. */
const MAX_REQUESTS_PER_SESSION = 500
/** How many sessions keep a ledger at once (LRU eviction beyond this). */
const MAX_SESSIONS = 64
/** Window in which an in-flight call still counts as "live" for the UI. */
const IN_FLIGHT_TTL_MS = 10 * 60 * 1000
/** How long a resolved delegation tree is reused before asking the service again. */
const TREE_TTL_MS = 2500
/** Ceiling on sessions one refresh may replay, so a corpus sweep stays bounded. */
const MAX_RECONCILE_SESSIONS = 400

/** @typedef {import('./lib/pricing.mjs').TokenUsage} TokenUsage */

/* ------------------------------------------------------------------ *
 * Ledger
 * ------------------------------------------------------------------ */

/**
 * One settled model call.
 * @typedef {object} LedgerEntry
 * @property {string} model resolved model key
 * @property {string} modelId raw model id as reported by the provider
 * @property {boolean} peak whether peak rates applied
 * @property {string} reason why that tier applied
 * @property {number} at settlement instant (epoch ms)
 * @property {{cacheHit: number, cacheMiss: number, output: number, reasoning: number, total: number}} tokens
 * @property {number} costCny
 * @property {number} costUsd
 */

/**
 * A session's running ledger.
 * @typedef {object} SessionLedger
 * @property {string} id
 * @property {LedgerEntry[]} requests
 * @property {number} costCny
 * @property {number} costUsd
 * @property {{cacheHit: number, cacheMiss: number, output: number, reasoning: number, total: number}} tokens
 * @property {number} calls
 * @property {Record<string, {calls: number, costCny: number}>} byModel
 * @property {number} peakCostCny
 * @property {number} offPeakCostCny
 * @property {number} firstAt
 * @property {number} lastAt
 * @property {number} touchedAt
 * @property {Map<string, {costCny: number, costUsd: number, peak: boolean, tokens: object, model: string}>} seenCalls
 */

/**
 * Create an empty ledger for one session.
 * @param {string} id - session id.
 * @returns {SessionLedger} the ledger.
 */
function emptyLedger(id) {
  return {
    id,
    requests: [],
    costCny: 0,
    costUsd: 0,
    tokens: { cacheHit: 0, cacheMiss: 0, output: 0, reasoning: 0, total: 0 },
    calls: 0,
    byModel: {},
    peakCostCny: 0,
    offPeakCostCny: 0,
    firstAt: 0,
    lastAt: 0,
    touchedAt: 0,
    /** `${turn}:${step}` → the contribution already counted, for rescan idempotency. */
    seenCalls: new Map(),
    /**
     * Billing provenance from a log replay: `turn:step` → the price of the call
     * at that position, as the log proves it. `seenCalls` holds the same shape
     * for the live meter, and both paths replace rather than stack.
     * @type {Map<string, {entry: object, usage: object}>|null}
     */
    provenance: null,
  }
}

/**
 * Fold one entry's contribution into a ledger's counters.
 * @param {SessionLedger} ledger - ledger to move.
 * @param {LedgerEntry} entry - the entry being added.
 * @param {number} sign - `1` to add, `-1` to take back.
 * @returns {void}
 */
function applyEntry(ledger, entry, sign) {
  ledger.calls += sign
  ledger.costCny += sign * entry.costCny
  ledger.costUsd += sign * entry.costUsd
  ledger.peakCostCny += sign * (entry.peak ? entry.costCny : 0)
  ledger.offPeakCostCny += sign * (entry.peak ? 0 : entry.costCny)
  for (const bucket of Object.keys(entry.tokens)) ledger.tokens[bucket] += sign * entry.tokens[bucket]
  const model = ledger.byModel[entry.model] ?? { calls: 0, costCny: 0 }
  model.calls += sign
  model.costCny += sign * entry.costCny
  ledger.byModel[entry.model] = model
}

/**
 * A call seen on `llm/stream` and not yet matched with a usage report.
 * @typedef {object} PendingCall
 * @property {string} modelId
 * @property {string} provider
 * @property {string} purpose
 * @property {number} startedAt
 */

/**
 * Move one call's contribution onto a ledger. Repeated reports for the same
 * `turn:step` position — a retry, an attempt followed by the committed message,
 * or a log replay of a call the live meter already folded — replace the previous
 * contribution instead of stacking on it, so no path can double-count.
 *
 * @param {SessionLedger} ledger - ledger to fold into.
 * @param {PendingCall} pending - the call being reported (`modelId`, `at`, `origin`).
 * @param {TokenUsage} usage - provider-reported usage.
 * @param {object} options - plugin options (`holidays` override).
 * @returns {LedgerEntry|null} the recorded entry, or null when the call is unchanged.
 */
function foldCall(ledger, pending, usage, options) {
  const now = typeof pending.at === 'number' ? pending.at : Date.now()
  const priced = priceUsage(usage, pending.modelId ?? '', now, options)
  /** @type {LedgerEntry} */
  const entry = {
    model: priced.model.key ?? '(unknown)',
    modelId: pending.modelId === undefined || pending.modelId === '' ? '(unknown)' : pending.modelId,
    peak: priced.peak,
    reason: priced.classification.reason,
    at: now,
    tokens: priced.tokens,
    costCny: priced.costCny,
    costUsd: priced.costUsd,
    origin: pending.origin,
    // A call settled before today's card existed must not be presented as if it
    // had been billed at today's numbers; the flag travels with the entry.
    beforeCurrentCard: priced.beforeCurrentCard === true,
    // deepseek-v4-pro's routing after 2026-09-14 12:00 is disputed upstream;
    // the row is a warning, not a re-price.
    routingDisputed: priced.modelRoutingDisputed === true,
  }

  const origin = pending.origin
  if (origin === undefined) {
    applyEntry(ledger, entry, 1)
  } else {
    const key = `${String(origin.turn ?? -1)}:${String(origin.step ?? -1)}`
    const previous = ledger.seenCalls.get(key)
    if (previous !== undefined) {
      const reported = previous.usage
      const replaced = previous.entry
      const same = replaced.tokens.total === entry.tokens.total
        && replaced.tokens.cacheHit === entry.tokens.cacheHit
        && replaced.tokens.cacheMiss === entry.tokens.cacheMiss
        && replaced.tokens.output === entry.tokens.output
        && replaced.modelId === entry.modelId
        && replaced.peak === entry.peak
        && Math.abs(replaced.costCny - entry.costCny) < 1e-12
      if (same) return null
      applyEntry(ledger, replaced, -1)
      entry.replaces = replaced.at
      if (reported !== undefined) entry.rawUsage = reported
    }
    ledger.seenCalls.set(key, { entry, usage })
    applyEntry(ledger, entry, 1)
  }

  ledger.requests.push(entry)
  if (ledger.requests.length > MAX_REQUESTS_PER_SESSION) ledger.requests.shift()
  if (ledger.firstAt === 0 || now < ledger.firstAt) ledger.firstAt = now
  if (now > ledger.lastAt) ledger.lastAt = now
  ledger.touchedAt = now
  return entry
}

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

/**
 * Host half entry point.
 *
 * @param {object} ctx - Cordis context.
 * @param {object} [config] - row config from `cordis.patch.yml`.
 * @param {object} [config.holidays] - Chinese holiday override, `{ '2027': { holidays: [...], makeupWorkdays: [...] } }`.
 * @param {string} [config.routePrefix] - HTTP prefix (default `/dsh-api-cost/api`).
 * @param {boolean} [config.tool] - register the `session_cost` tool (default true).
 * @param {boolean} [config.command] - register the `/cost` command (default true).
 * @param {boolean} [config.tree] - roll subagent sessions into their parent's figure (default true).
 * @param {boolean} [config.team] - report the whole Agent Team when the session is a member (default true).
 */
export function apply(ctx, config = {}) {
  /** Options threaded into every pricing call (holiday override only). */
  const options = config.holidays === undefined ? {} : { holidays: config.holidays }
  /** Whether a session's figure includes the sessions it delegated to. */
  const includeTree = config.tree !== false
  /** Whether a Team member's figure covers the whole Team by default. */
  const includeTeam = config.team !== false
  const routePrefix = typeof config.routePrefix === 'string' && config.routePrefix !== ''
    ? config.routePrefix.replace(/\/+$/, '')
    : '/dsh-api-cost/api'

  /** @type {Map<string, SessionLedger>} */
  const ledgers = new Map()
  /** @type {Map<string, PendingCall[]>} */
  const pending = new Map()
  /**
   * Session delegation edges, `childId -> parentId`. A session announces its
   * own parent in `SessionHeader.parentSession`, so a subagent's spend can be
   * rolled into the conversation that delegated it. Kept separately from the
   * ledgers because a finished child's ledger is evicted long before its parent
   * stops caring about the total.
   * @type {Map<string, string>}
   */
  const parents = new Map()
  /** Short-lived resolver cache: `rootId -> { at, ids }`, from the subagent service. */
  const treeCache = new Map()
  /** Roots whose service read is in flight, so a poll cannot stack reads. */
  const treePending = new Set()

  /** Diagnostic counter so a silent wiring failure is visible in the log. */
  const seen = { requests: 0, usage: 0, routes: 0, reconciles: 0 }
  let lastError = null
  let lastUsageSample = null
  /** The most recent reconcile report, so a client can show what a refresh did. */
  let lastReconcile = null

  /**
   * Read (or create) one session's ledger, refreshing its LRU position.
   * @param {string} id - session id.
   * @returns {SessionLedger} the ledger.
   */
  function ledgerFor(id) {
    let ledger = ledgers.get(id)
    if (ledger === undefined) {
      ledger = emptyLedger(id)
      ledgers.set(id, ledger)
    }
    ledger.touchedAt = Date.now()
    if (ledgers.size > MAX_SESSIONS) {
      let oldestKey = null
      let oldestAt = Infinity
      for (const [key, value] of ledgers) {
        if (key === id) continue
        if (value.touchedAt < oldestAt) {
          oldestAt = value.touchedAt
          oldestKey = key
        }
      }
      if (oldestKey !== null) ledgers.delete(oldestKey)
    }
    return ledger
  }

  /**
   * Record one delegation edge from a session announcement.
   * @param {unknown} session - the announced `Session` (or a `{ header }` shape).
   * @returns {void}
   */
  function noteSession(session) {
    const header = session === null || session === undefined ? undefined : session.header
    const id = header === null || header === undefined ? undefined : header.id
    const parentId = header === null || header === undefined ? undefined : header.parentSession
    if (typeof id !== 'string' || typeof parentId !== 'string') return
    if (id === parentId) return
    parents.set(id, parentId)
  }

  /**
   * Resolve the live delegation tree from the subagent service and fold it into
   * the edge map.
   *
   * This is the authoritative source: `listDescendants` walks the live subagent
   * tree, so it does not depend on an event reaching a plugin-level listener
   * (the delegation events are dispatched inside the delegating agent's scope).
   * The result is cached briefly because the Client polls every few seconds and
   * the tree changes at human speed.
   *
   * @param {string} rootId - the conversation being reported.
   * @param {number} now - reference instant.
   * @returns {Promise<void>} resolves once the cache is fresh.
   */
  async function ensureTree(rootId, now, force) {
    if (!includeTree || rootId === '') return
    const cached = treeCache.get(rootId)
    if (!force && cached !== undefined && now - cached.at < TREE_TTL_MS) return
    if (treePending.has(rootId)) return
    const subagents = ctx.get('subagents')
    if (subagents === undefined || typeof subagents.listDescendants !== 'function') {
      treeCache.set(rootId, { at: now, ids: [] })
      return
    }
    const pending = Promise.resolve()
      .then(() => subagents.listDescendants(rootId))
      .then((entries) => {
        const ids = []
        for (const entry of Array.isArray(entries) ? entries : []) {
          const childId = entry === null || entry === undefined ? undefined : entry.id
          if (typeof childId !== 'string' || childId === '') continue
          ids.push(childId)
          const parentId = typeof entry.parentId === 'string' ? entry.parentId : undefined
          if (parentId !== undefined && parentId !== childId) parents.set(childId, parentId)
        }
        treeCache.set(rootId, { at: now, ids })
        treePending.delete(rootId)
      })
      .catch((error) => {
        // A composition without the subagent service, or a read that raced a
        // disposal: fall back to whatever the event listeners learned.
        treeCache.set(rootId, { at: now, ids: [] })
        treePending.delete(rootId)
        lastError = String(error && error.message ? error.message : error)
      })
    treePending.add(rootId)
    await pending
  }

  /**
   * Every session below one root. Prefers the live service result; falls back to
   * the recorded delegation edges so a session is still attributed when the
   * service is absent (or the read raced a disposal).
   * @param {string} rootId - the conversation the user is looking at.
   * @returns {string[]} descendant session ids, nearest first.
   */
  function treeIdsFor(rootId) {
    const cached = treeCache.get(rootId)
    if (cached !== undefined && cached.ids.length > 0) return cached.ids
    return descendantsOf(rootId)
  }

  /**
   * Every session below one root, breadth-first, walked from the recorded
   * delegation edges. Used when the subagent service is unavailable, and when
   * its read has not landed yet.
   * @param {string} rootId - the conversation the user is looking at.
   * @returns {string[]} descendant session ids, nearest first.
   */
  function descendantsOf(rootId) {
    const found = []
    const seen = new Set([rootId])
    let frontier = [rootId]
    // Depth is bounded in practice; the guard only stops a malformed cycle.
    for (let depth = 0; depth < 16 && frontier.length > 0; depth += 1) {
      const next = []
      for (const [childId, parentId] of parents) {
        if (seen.has(childId)) continue
        if (!frontier.includes(parentId)) continue
        seen.add(childId)
        found.push(childId)
        next.push(childId)
      }
      frontier = next
    }
    return found
  }

  /**
   * Read a session id out of whatever the Host handed us: a `Session`, an
   * `Agent`, a header, or a bare id string.
   * @param {unknown} value - the candidate.
   * @returns {string|undefined} the session id, when one is present.
   */
  function sessionIdOf(value) {
    if (typeof value === 'string') return value === '' ? undefined : value
    if (value === null || value === undefined || typeof value !== 'object') return undefined
    if (typeof value.id === 'string') return value.id
    // DSH's `Agent` is `{ readonly id: SessionId }`; other carriers (and older
    // builds) spell the same field `sessionId`, either bare or under `session`.
    if (typeof value.sessionId === 'string' && value.sessionId !== '') return value.sessionId
    const header = value.header
    if (header !== null && header !== undefined && typeof header.id === 'string') return header.id
    const session = value.session
    if (session !== undefined) return sessionIdOf(session)
    return undefined
  }

  /**
   * Cordis listener for `session/created`: a delegated session announces its own
   * parent here (`SessionHeader.parentSession`). Registered `global` because the
   * announcement is dispatched in the created session's own scope, which a
   * plugin-level listener is not part of.
   *
   * @param {unknown} session - the published session.
   */
  ctx.on('session/created', (session) => {
    try {
      noteSession(session)
    } catch (error) {
      lastError = String(error && error.message ? error.message : error)
    }
  }, { global: true })

  /**
   * Cordis listener for `subagent/start`: the delegating side names the child it
   * just published, and the dispatch carries the delegating parent as the
   * event's `this`. Two independent ways to learn the same edge, so a child that
   * never announces a header is still attributed.
   *
   * @param {object} info - `{ runId, provider, id, local }`.
   * @param {unknown} parent - the delegating session, when the runtime passes one.
   */
  ctx.on('subagent/start', function onSubagentStart(info, parent) {
    try {
      const childId = info === null || info === undefined ? undefined : info.id
      if (typeof childId !== 'string' || childId === '') return
      noteSession(parent)
      // The dispatch binds the delegating scope as `this`; `agents` there knows
      // which agent currently drives the process-local call chain.
      const initiator = this === null || this === undefined || this.agents === undefined
        ? undefined
        : this.agents.currentInitiator();
      const parentId = sessionIdOf(parent) ?? sessionIdOf(initiator)
      if (typeof parentId === 'string' && parentId !== childId) parents.set(childId, parentId)
    } catch (error) {
      lastError = String(error && error.message ? error.message : error)
    }
  }, { global: true })

  /**
   * Cordis listener for the `llm/stream` waterfall: record what is being called
   * and how, then hand the stream straight through. Registering the listener is
   * enough to observe every call — the returned iterable is consumed by the
   * caller, so this must never buffer it.
   *
   * @param {object} callOptions - the frozen `GenerateOptions`.
   * @param {() => AsyncIterable<object>} next - the rest of the waterfall.
   * @returns {AsyncIterable<object>} the same stream the caller would have got.
   */
  ctx.on('llm/stream', (callOptions, next) => {
    try {
      const sessionId = typeof callOptions?.sessionId === 'string' ? callOptions.sessionId : ''
      if (sessionId !== '') {
        const queue = pending.get(sessionId) ?? []
        queue.push({
          modelId: typeof callOptions.model === 'string' ? callOptions.model : '',
          provider: typeof callOptions.provider === 'string' ? callOptions.provider : '',
          purpose: typeof callOptions.purpose === 'string' ? callOptions.purpose : 'chat',
          startedAt: Date.now(),
        })
        if (queue.length > 16) queue.shift()
        pending.set(sessionId, queue)
        seen.requests += 1
      }
    } catch (error) {
      lastError = String(error && error.message ? error.message : error)
    }
    return next()
  })

  /**
   * Cordis listener for `agent/assistant-stream`: a `usage` chunk is the
   * provider's own token report for one call, so it is the only thing that is
   * ever billed. Chunks are cumulative within a call, so the newest report for
   * a call replaces the previous one rather than adding to it.
   *
   * @param {object} payload - `{ agent, frame }`.
   */
  ctx.on('agent/assistant-stream', (payload) => {
    try {
      const frame = payload?.frame
      if (frame === undefined || frame === null || frame.type !== 'chunk') return
      const chunk = frame.chunk
      if (chunk === undefined || chunk === null || chunk.type !== 'usage') return
      const usage = chunk.usage
      if (usage === undefined || usage === null || typeof usage !== 'object') return

      const sessionId = typeof payload.agent?.id === 'string' ? payload.agent.id : ''
      if (sessionId === '') return

      seen.usage += 1
      lastUsageSample = {
        inputTokens: usage.inputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
      }

      const queue = pending.get(sessionId)
      const call = queue !== undefined && queue.length > 0 ? queue.shift() : undefined
      const ledger = ledgerFor(sessionId)
      // The frame's position is the same key a log replay uses, so a call that
      // later shows up in the durable log replaces this fold instead of adding
      // to it.
      foldCall(ledger, {
        modelId: call === undefined ? '' : call.modelId,
        at: Date.now(),
        origin: { turn: frame.turn, step: frame.step },
      }, usage, options)
    } catch (error) {
      lastError = String(error && error.message ? error.message : error)
    }
  })

  /* ---------------------------------------------------------------- *
   * Reconcile (the panel's refresh button)
   * ---------------------------------------------------------------- */

  /**
   * Replay one session's durable log into its ledger.
   *
   * This is what makes the refresh button worth pressing: a call that settled
   * while the plugin was not listening — or while the Host was down — is still
   * in the log, with the model and the tier timestamp the provider reported. The
   * replay is idempotent (a call is keyed by its `turn:step` position), so
   * pressing refresh twice never doubles a figure.
   *
   * @param {string} sessionId - session to replay.
   * @param {object} query - the `sessionQuery` service.
   * @returns {Promise<{ok: boolean, reason?: string, usage: number, recovered: number, model: string}>} outcome.
   */
  async function reconcileSession(sessionId, query) {
    let snapshot
    try {
      snapshot = await query.readSession(sessionId)
    } catch (error) {
      return { ok: false, reason: String(error && error.message ? error.message : error), usage: 0, recovered: 0, model: '' }
    }
    const events = snapshot !== null && snapshot !== undefined && Array.isArray(snapshot.events) ? snapshot.events : []
    const ledger = ledgerFor(sessionId)
    let model = ''
    let usageEvents = 0
    /**
     * Per-call usage this log proves, keyed by the same `turn:step` position the
     * live listener records. Repeated reports for one position (an attempt
     * followed by the committed message) keep the newest.
     * @type {Map<string, {value: object, usage: object, model: string}>}
     */
    const scannedCalls = new Map()
    for (const event of events) {
      if (event === null || event === undefined) continue
      const data = event.data
      if (data === null || data === undefined) continue
      if (event.type === 'request/header' || event.type === 'request/context') {
        const config = event.type === 'request/header' ? data.header?.config : data
        if (typeof config?.model === 'string' && config.model !== '') model = config.model
        continue
      }
      let usage
      if (event.type === 'assistant/message' && data.usage !== undefined) usage = data.usage
      else if (event.type === 'assistant/chunk' && data.chunk?.type === 'usage') usage = data.chunk.usage
      if (usage === undefined || usage === null || typeof usage !== 'object') continue
      usageEvents += 1
      const turn = data.turn
      const step = data.step
      const when = typeof event.time === 'number' ? event.time : Date.now()
      const priced = priceUsage(usage, model, when, options)
      const key = `${String(turn ?? -1)}:${String(step ?? -1)}`
      /** @type {LedgerEntry} */
      const value = {
        model: priced.model.key ?? '(unknown)',
        modelId: model === '' ? '(unknown)' : model,
        peak: priced.peak,
        reason: priced.classification.reason,
        at: when,
        tokens: priced.tokens,
        costCny: priced.costCny,
        costUsd: priced.costUsd,
        origin: { turn: turn ?? -1, step: step ?? -1 },
        beforeCurrentCard: priced.beforeCurrentCard === true,
        routingDisputed: priced.modelRoutingDisputed === true,
      }
      const previous = ledger.seenCalls.get(key)
      if (previous !== undefined) {
        const replaced = previous.entry
        const same = replaced.tokens.total === value.tokens.total
          && replaced.tokens.cacheHit === value.tokens.cacheHit
          && replaced.tokens.cacheMiss === value.tokens.cacheMiss
          && replaced.tokens.output === value.tokens.output
          && replaced.modelId === value.modelId
          && replaced.peak === value.peak
        if (same) continue
        // A replay that could not resolve the model (the log kept the usage but
        // not the request header) must not overwrite a priced live entry with a
        // zero: the live meter knew more than this pass does.
        if (value.modelId === '(unknown)' && replaced.modelId !== '(unknown)') continue
        applyEntry(ledger, replaced, -1)
        value.rawUsage = previous.usage
        value.replaces = replaced.at
      }
      ledger.seenCalls.set(key, { entry: value, usage })
      applyEntry(ledger, value, 1)
      scannedCalls.set(key, value)
    }
    // The delegation edge comes from the header the corpus preserved.
    if (snapshot !== null && snapshot !== undefined && snapshot.session !== undefined) noteSession(snapshot)
    return { ok: true, usage: usageEvents, recovered: scannedCalls.size, model }
  }

  /**
   * Replay a set of sessions, recording the delegation edges their headers
   * declare on the way through.
   * @param {string[]} sessionIds - sessions to replay, in order.
   * @param {object} query - the `sessionQuery` service.
   * @returns {Promise<object>} the reconcile report.
   */
  async function reconcileSessions(sessionIds, query) {
    const report = {
      at: Date.now(),
      sessions: 0,
      scanned: 0,
      skipped: 0,
      usageEvents: 0,
      recovered: 0,
      failed: 0,
      truncated: false,
      lastError: null,
    }
    let budget = MAX_RECONCILE_SESSIONS
    for (const sessionId of sessionIds) {
      report.sessions += 1
      if (budget <= 0) {
        report.truncated = true
        report.skipped += 1
        continue
      }
      budget -= 1
      const outcome = await reconcileSession(sessionId, query)
      if (!outcome.ok) {
        report.failed += 1
        report.lastError = outcome.reason ?? null
        continue
      }
      report.scanned += 1
      report.usageEvents += outcome.usage
      report.recovered += outcome.recovered
    }
    lastReconcile = report
    seen.reconciles += 1
    return report
  }

  /**
   * Refresh the ledger from the durable logs. The scope decides how much of the
   * corpus is replayed: the conversation itself, its delegation tree, its Team,
   * or every session the Host can see.
   * @param {string} sessionId - the requesting session ('' for none).
   * @param {'auto'|'tree'|'team'|'self'|'corpus'} scope - what to replay.
   * @returns {Promise<object>} the reconcile report, plus the ledger totals after it.
   */
  async function reconcile(sessionId, scope) {
    const query = ctx.get('sessionQuery')
    if (query === undefined || typeof query.readSession !== 'function') {
      return {
        ok: false,
        reason: 'session logs are not queryable in this composition (no sessionQuery service)',
        at: Date.now(),
        sessions: 0,
        scanned: 0,
        recovered: 0,
      }
    }
    let corpus = []
    try {
      const listed = await query.listSessions()
      for (const record of Array.isArray(listed) ? listed : []) {
        const header = record === null || record === undefined ? undefined : record.header
        const id = header === null || header === undefined ? undefined : header.id
        if (typeof id !== 'string' || id === '') continue
        corpus.push({ id, parentSession: typeof header.parentSession === 'string' ? header.parentSession : null })
      }
    } catch (error) {
      lastError = String(error && error.message ? error.message : error)
    }
    // Every header the corpus exposes is an authoritative delegation edge, so a
    // refresh also repairs attribution for sessions this process never saw.
    for (const row of corpus) {
      if (row.parentSession !== null && row.parentSession !== row.id) parents.set(row.id, row.parentSession)
    }

    let targets
    if (scope === 'corpus') {
      targets = corpus.map((row) => row.id)
      if (sessionId !== '' && !targets.includes(sessionId)) targets.unshift(sessionId)
    } else if (corpus.length === 0) {
      // No listing (or it failed): fall back to whatever this process knows.
      targets = sessionId === '' ? [...ledgers.keys()] : [sessionId, ...descendantsOf(sessionId)]
    } else if (sessionId === '') {
      targets = corpus.map((row) => row.id)
    } else if (scope === 'self') {
      targets = [sessionId]
    } else if (scope === 'tree') {
      targets = [sessionId, ...descendantsOf(sessionId)]
    } else {
      // Team and auto both refresh the requesting conversation's whole subtree.
      const team = scope === 'team' ? teamScope(sessionId, Date.now()) : { inTeam: false, rootId: sessionId }
      const rootId = team.inTeam ? team.rootId : sessionId
      targets = [rootId, ...descendantsOf(rootId)]
      if (!targets.includes(sessionId)) targets.push(sessionId)
    }
    const report = await reconcileSessions(targets, query)
    const view = sessionId === '' ? null : sessionView(sessionId, Date.now(), scope === 'corpus' ? 'auto' : scope)
    return { ok: true, ...report, scope: view === null ? scope : view.scope, totalCny: view?.session?.costCny ?? 0 }
  }

  /* ---------------------------------------------------------------- *
   * Read models
   * ---------------------------------------------------------------- */

  /**
   * Current pricing window plus the rate card a UI needs to explain a number.
   * @param {number} now - reference instant.
   * @param {string} [modelId] - model whose rates to include in detail.
   * @returns {object} pricing snapshot.
   */
  function pricingSnapshot(now, modelId) {
    const classification = classifyInstant(now, options)
    const boundary = nextBoundary(now, options)
    const resolved = resolveModel(modelId ?? 'deepseek-flash')
    const row = resolved.key === null ? RATE_CARD.models['deepseek-flash'] : RATE_CARD.models[resolved.key]
    return {
      now,
      peak: classification.peak,
      reason: classification.reason,
      local: classification.local,
      holidayDataMissing: classification.holidayDataMissing,
      beforePeakPolicy: classification.beforePeakPolicy,
      beforeCurrentCard: classification.beforeCurrentCard === true,
      next: boundary,
      effectiveFrom: RATE_CARD_EFFECTIVE_FROM,
      peakPolicyFrom: PEAK_POLICY_FROM,
      source: RATE_CARD.source,
      retrievedAt: RATE_CARD.retrievedAt,
      currencyRelation: RATE_CARD.currencyRelation,
      model: { key: resolved.key, label: resolved.label, guessed: resolved.guessed, known: resolved.known },
      routingDisputed: row.disputedAfter !== undefined && Date.now() >= Date.parse(row.disputedAfter),
      routingDisputeNote: row.dispute ?? null,
      rates: { peak: row.peak, offPeak: row.offPeak },
    }
  }

  /**
   * Summarize one session's ledger. Token buckets are disjoint, so they sum.
   * @param {string} sessionId - session id.
   * @param {number} now - reference instant.
   * @returns {object} session snapshot (also the shape the Client renders).
   */
  function sessionSnapshot(sessionId, now) {
    const ledger = ledgers.get(sessionId) ?? emptyLedger(sessionId)
    const queue = pending.get(sessionId) ?? []
    const live = queue.filter((call) => now - call.startedAt < IN_FLIGHT_TTL_MS)
    return {
      sessionId,
      calls: ledger.calls,
      tokens: ledger.tokens,
      costCny: ledger.costCny,
      costUsd: ledger.costUsd,
      peakCostCny: ledger.peakCostCny,
      offPeakCostCny: ledger.offPeakCostCny,
      byModel: ledger.byModel,
      firstAt: ledger.firstAt,
      lastAt: ledger.lastAt,
      inFlightRaw: live,
      inFlight: live.map((call) => ({ model: call.modelId, provider: call.provider, purpose: call.purpose, startedAt: call.startedAt })),
      recent: ledger.requests.slice(-20),
      known: ledgers.has(sessionId),
    }
  }

  /**
   * Roll a session and every session it delegated to into one figure. Without
   * this, an agent team or subagent conversation reports only what the parent
   * itself spent, which is the smaller half of the bill.
   *
   * The aggregate keeps the single-session shape (totals, token buckets, the
   * most recent calls) and adds the session records plus the split between the
   * parent's own spend and its subsessions'.
   *
   * @param {string} rootId - the conversation being reported.
   * @param {number} now - reference instant.
   * @param {boolean} withTree - when false, report the session alone.
   * @returns {object} aggregate cost view.
   */
  function aggregateView(rootId, now, withTree) {
    const childIds = withTree ? treeIdsFor(rootId) : []
    const records = [sessionSnapshot(rootId, now)]
    for (const childId of childIds) records.push(sessionSnapshot(childId, now))
    // Nothing on this tree has ever settled: report the single-session shape
    // anyway, so callers never have to special-case "unknown session".
    if (!records.some((record) => record.known)) return sessionSnapshot(rootId, now)

    const tokens = { cacheHit: 0, cacheMiss: 0, output: 0, reasoning: 0, total: 0 }
    const byModel = {}
    let costCny = 0
    let costUsd = 0
    let peakCostCny = 0
    let offPeakCostCny = 0
    let calls = 0
    let firstAt = 0
    let lastAt = 0
    const inFlight = []
    let subagentCostCny = 0
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]
      costCny += record.costCny
      costUsd += record.costUsd
      peakCostCny += record.peakCostCny
      offPeakCostCny += record.offPeakCostCny
      calls += record.calls
      for (const key of Object.keys(tokens)) tokens[key] += record.tokens[key]
      for (const [model, bucket] of Object.entries(record.byModel)) {
        const target = byModel[model] ?? { calls: 0, costCny: 0 }
        target.calls += bucket.calls
        target.costCny += bucket.costCny
        byModel[model] = target
      }
      if (record.firstAt > 0 && (firstAt === 0 || record.firstAt < firstAt)) firstAt = record.firstAt
      if (record.lastAt > lastAt) lastAt = record.lastAt
      for (const call of record.inFlightRaw) inFlight.push({ ...call, sessionId: record.sessionId });
      // Everything past the root record is a subsession.
      if (index > 0) subagentCostCny += record.costCny
    }

    // Records are flattened nearest-first, so a session whose parent is not in
    // this set is a direct child of the root.
    const inTree = new Set(records.map((record) => record.sessionId))
    const children = records.filter((record) => record.sessionId !== rootId).map((record) => {
      const parentId = parents.get(record.sessionId) ?? null
      return {
        sessionId: record.sessionId,
        parentId,
        direct: parentId === rootId || !inTree.has(parentId),
        calls: record.calls,
        costCny: record.costCny,
        costUsd: record.costUsd,
        tokens: record.tokens,
        lastAt: record.lastAt,
        inFlight: record.inFlight.length,
      }
    })

    return {
      sessionId: rootId,
      calls,
      tokens,
      costCny,
      costUsd,
      peakCostCny,
      offPeakCostCny,
      byModel,
      firstAt,
      lastAt,
      inFlight,
      recent: records[0].recent,
      known: true,
      // The split that makes the total honest: what this conversation spent
      // itself, and what the sessions under it spent.
      ownCostCny: records[0].costCny,
      subagentCostCny,
      subagentSessions: childIds.length,
      subagents: childIds.length,
      sessions: records.length,
      children,
    }
  }

  /**
   * Fold a row of live Team members into one figure. Members are flat: every
   * teammate is a direct child of the Lead, so the team view is the Lead's
   * subtree walked from the membership root.
   * @param {string} rootId - the Team Lead's session id.
   * @param {object[]} entries - `{ id, name, role, status }` rows.
   * @param {number} now - reference instant.
   * @returns {object|null} the team view, or null when nothing is being metered.
   */
  function teamView(rootId, entries, now) {
    const ids = []
    const byId = new Map()
    for (const entry of Array.isArray(entries) ? entries : []) {
      const id = entry === null || entry === undefined ? undefined : entry.id
      if (typeof id !== 'string' || id === '') continue
      ids.push(id)
      byId.set(id, entry)
    }
    if (!ids.includes(rootId)) ids.unshift(rootId)
    const records = ids.map((id) => sessionSnapshot(id, now))
    if (!records.some((record) => record.known)) return null

    const members = records.map((record) => {
      const entry = byId.get(record.sessionId)
      return {
        sessionId: record.sessionId,
        name: typeof entry?.name === 'string' && entry.name !== '' ? entry.name : 'lead',
        role: entry?.role === 'teammate' ? 'teammate' : 'lead',
        status: typeof entry?.status === 'string' ? entry.status : 'unknown',
        calls: record.calls,
        costCny: record.costCny,
        costUsd: record.costUsd,
      }
    }).sort((left, right) => right.costCny - left.costCny);

    const aggregate = {
      sessionId: rootId,
      calls: 0,
      tokens: { cacheHit: 0, cacheMiss: 0, output: 0, reasoning: 0, total: 0 },
      costCny: 0,
      costUsd: 0,
      peakCostCny: 0,
      offPeakCostCny: 0,
      byModel: {},
      sessions: records.length,
      ownCostCny: records[0].costCny,
      subagentCostCny: 0,
      subagents: records.length - 1,
      startedAt: 0,
      lastAt: 0,
      rank: 0,
      // The requesting session's own recent calls, so callers that derive a
      // display model from the tail keep working at Team scope.
      recent: records[0].recent,
      inFlight: records.flatMap((record) => record.inFlight),
      members,
      membersWithSpend: members.filter((member) => member.calls > 0),
    }
    for (const member of members) {
      const record = records.find((candidate) => candidate.sessionId === member.sessionId)
      if (record === undefined) continue
      aggregate.calls += record.calls
      aggregate.costCny += record.costCny
      aggregate.costUsd += record.costUsd
      aggregate.peakCostCny += record.peakCostCny
      aggregate.offPeakCostCny += record.offPeakCostCny
      if (aggregate.startedAt === 0 || record.firstAt < aggregate.startedAt) aggregate.startedAt = record.firstAt
      if (record.lastAt > aggregate.lastAt) aggregate.lastAt = record.lastAt
      for (const key of Object.keys(aggregate.tokens)) aggregate.tokens[key] += record.tokens[key]
      for (const [model, bucket] of Object.entries(record.byModel)) {
        const target = aggregate.byModel[model] ?? { calls: 0, costCny: 0 }
        target.calls += bucket.calls
        target.costCny += bucket.costCny
        aggregate.byModel[model] = target
      }
    }
    // Everyone other than the viewer's own session reads as "teammate" spend.
    aggregate.subagentCostCny = aggregate.costCny - aggregate.ownCostCny
    return aggregate
  }

  /**
   * The `scope=team` view, and whether the caller is in a Team at all.
   * @param {string} sessionId - the requesting session.
   * @param {number} now - reference instant.
   * @param {object} [exactAgent] - the caller's own Agent, when it already has one.
   * @returns {{inTeam: boolean, rootId: string, view: object|null}} the team scope.
   */
  function teamScope(sessionId, now, exactAgent) {
    const empty = { inTeam: false, rootId: sessionId, view: null }
    if (!includeTeam || sessionId === '') return empty
    const agentTeams = ctx.get('agentTeams')
    if (agentTeams === undefined || typeof agentTeams.tryMembership !== 'function') return empty
    const agents = ctx.get('agents')
    // A live Agent carries both `id` and `session`; either one identifies it.
    const lookupId = exactAgent === undefined ? sessionId : (sessionIdOf(exactAgent) ?? sessionId)
    const agent = exactAgent !== undefined
      ? exactAgent
      : (agents === undefined || typeof agents.get !== 'function' ? undefined : agents.get(lookupId))
    if (agent === undefined) return empty
    let membership
    try {
      membership = agentTeams.tryMembership(agent)
    } catch (error) {
      lastError = String(error && error.message ? error.message : error)
      return empty
    }
    if (membership === undefined || membership === null) return empty
    const rootId = sessionIdOf(membership.root)
    const entries = []
    try {
      for (const member of agentTeams.listMembers(agent)) entries.push(member)
    } catch (error) {
      lastError = String(error && error.message ? error.message : error)
    }
    if (rootId === undefined) return empty
    return {
      inTeam: true,
      rootId,
      view: teamView(rootId, entries, now),
    }
  }

  /**
   * Read the whole figure for one session, at the requested scope.
   *
   * Scope is resolved by what the runtime actually knows: a session in a Team
   * can report the Team, a session with delegated children can report its
   * subtree, and anything else reports itself. An unknown session id (a closed
   * or foreign session) always answers itself.
   *
   * @param {string} sessionId - session to report ('' for none).
   * @param {number} now - reference instant.
   * @param {'auto'|'tree'|'team'|'self'} scope - requested scope.
   * @param {object} [exactAgent] - the caller's own Agent, when it has one.
   * @returns {object} `{ session, scope, teamRootId }`.
   */
  function sessionView(sessionId, now, scope, exactAgent) {
    if (sessionId === '') return { session: null, scope, teamRootId: null }
    if (scope === 'team') {
      const team = teamScope(sessionId, now, exactAgent)
      if (team.view !== null) return { session: team.view, scope: 'team', teamRootId: team.rootId }
      if (team.inTeam) return { session: aggregateView(sessionId, now, true), scope: 'tree', teamRootId: team.rootId }
    }
    const withTree = scope !== 'self'
    const session = aggregateView(sessionId, now, withTree)
    if (scope === 'auto') {
      // Any session in a live Team reports the Team by default: a teammate sees
      // the shared bill, and the Lead sees every member. The figure the
      // session's own widget has always shown rides along, so the panel can
      // still say what this conversation spent inside the Team total.
      const team = teamScope(sessionId, now, exactAgent)
      if (team.view !== null) {
        return {
          session: {
            ...team.view,
            teamSpendCny: session.costCny,
            teamSpendSubagentCny: session.subagentCostCny,
            teamSpendSubagents: session.subagents,
          },
          scope: 'team',
          teamRootId: team.rootId,
        }
      }
    }
    return { session, scope: withTree ? 'tree' : 'self', teamRootId: null }
  }
  /**
   * Build the snapshot the Client polls: the pricing window for the session's
   * most recent model, plus its spend at the resolved scope.
   * @param {string} sessionId - session id ('' for none).
   * @param {number} now - reference instant.
   * @param {'auto'|'tree'|'team'|'self'} scope - requested scope.
   * @returns {object} snapshot payload.
   */
  function snapshot(sessionId, now, scope) {
    const ledger = ledgers.get(sessionId)
    const lastRequest = ledger === undefined ? undefined : ledger.requests[ledger.requests.length - 1]
    const lastModel = lastRequest === undefined ? undefined : lastRequest.modelId
    const view = sessionId === '' ? { session: null, scope, teamRootId: null } : sessionView(sessionId, now, scope)
    return {
      ok: true,
      pricing: pricingSnapshot(now, lastModel),
      session: view.session,
      scope: view.scope,
      teamRootId: view.teamRootId,
      metering: {
        requests: seen.requests,
        usageReports: seen.usage,
        sessions: ledgers.size,
        reconciles: seen.reconciles,
        lastReconcile,
        lastError,
      },
      rateCard: RATE_CARD.models,
    }
  }

  /**
   * The HTTP snapshot, after refreshing the delegation tree. A resolved tree
   * means the first paint after a delegation already includes the subsessions;
   * a failed read still answers, from the recorded edges.
   * @param {string} sessionId - session to report ('' for none).
   * @param {number} now - reference instant.
   * @param {'auto'|'tree'|'team'|'self'} scope - requested scope.
   * @returns {Promise<object>} the snapshot payload.
   */
  async function snapshotResolved(sessionId, now, scope, force) {
    await ensureTree(sessionId, now, force)
    return snapshot(sessionId, now, scope)
  }

  /**
   * The session-only view, after refreshing the delegation tree.
   * @param {string} sessionId - session to report ('' for none).
   * @param {number} now - reference instant.
   * @param {'auto'|'tree'|'team'|'self'} scope - requested scope.
   * @returns {Promise<object>} `{ ok, session, scope }`.
   */
  async function sessionResolved(sessionId, now, scope, force) {
    if (sessionId === '') return { ok: true, session: null, scope }
    await ensureTree(sessionId, now, force)
    const view = sessionView(sessionId, now, scope)
    return { ok: true, session: view.session, scope: view.scope, teamRootId: view.teamRootId }
  }

  /**
   * The pricing-only view. Carries the same provenance fields as the full
   * snapshot — including the card itself, so a caller that polls only this
   * route still has everything it needs to explain a rate.
   * @param {string} sessionId - session whose model to price ('' for the default).
   * @param {number} now - reference instant.
   * @returns {object} pricing payload.
   */
  function pricingPayload(sessionId, now) {
    const ledger = ledgers.get(sessionId)
    const lastRequest = ledger === undefined ? undefined : ledger.requests[ledger.requests.length - 1]
    const lastModel = lastRequest === undefined ? undefined : lastRequest.modelId
    return {
      ok: true,
      pricing: pricingSnapshot(now, lastModel),
      rateCard: RATE_CARD.models,
    }
  }

  /* ---------------------------------------------------------------- *
   * HTTP
   * ---------------------------------------------------------------- */

  /**
   * Write one JSON response.
   * @param {import('node:http').ServerResponse} res - response.
   * @param {number} status - HTTP status.
   * @param {unknown} body - JSON-serializable body.
   * @returns {void}
   */
  function sendJson(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  /**
   * Wrap one route handler so a throw becomes a 400 with a diagnostic body
   * instead of a bare connection error.
   * @param {(url: URL, req: object, res: object) => void} handler - inner handler.
   * @returns {(req: object, res: object) => void} guarded handler.
   */
  function guard(handler) {
    return (req, res) => {
      const url = new URL(typeof req.url === 'string' ? req.url : '/', 'http://127.0.0.1')
      // The promise is RETURNED: the webserver awaits a handler's result, so a
      // handler that drops it would answer asynchronously behind the caller's
      // back and turn a slow read into an empty response.
      return Promise.resolve()
        .then(() => handler(url, req, res))
        .catch((error) => {
          lastError = String(error && error.message ? error.message : error)
          try {
            sendJson(res, 400, { ok: false, error: lastError })
          } catch {
            /* response already gone */
          }
        })
    }
  }

  /**
   * The requested reporting scope. `self` and `team` are explicit; anything
   * else is `auto`, which upgrades to the Team when the runtime reports one.
   * @param {URL} url - the request URL.
   * @returns {'auto'|'tree'|'team'|'self'} the scope.
   */
  const wantedScope = (url) => {
    const raw = url.searchParams.get('scope')
    if (raw === 'self') return 'self'
    if (raw === 'team') return 'team'
    if (raw === 'tree') return includeTree ? 'tree' : 'self'
    if (url.searchParams.get('tree') === '0') return 'self'
    return includeTree ? 'auto' : 'self'
  }

  /** `force=1` refreshes the delegation tree instead of reusing the short cache. */
  const wantsForce = (url) => url.searchParams.get('force') === '1'

  ctx.effect(() => {
    const disposers = []
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: routePrefix,
      handler: guard((url, req, res) => {
        const sessionId = url.searchParams.get('session') ?? ''
        return snapshotResolved(sessionId, Date.now(), wantedScope(url), wantsForce(url)).then((body) => sendJson(res, 200, body))
      }),
    }))
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${routePrefix}/session`,
      handler: guard((url, req, res) => {
        const sessionId = url.searchParams.get('session') ?? ''
        return sessionResolved(sessionId, Date.now(), wantedScope(url), wantsForce(url)).then((body) => sendJson(res, 200, body))
      }),
    }))
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${routePrefix}/status`,
      handler: guard((url, req, res) => {
        sendJson(res, 200, pricingPayload(url.searchParams.get('session') ?? '', Date.now()))
      }),
    }))
    // The refresh button. Answers GET and POST: the desktop shell's transport
    // rejects unknown methods on an unregistered path with 405, so a GET keeps
    // the button working even against a Host that has not reloaded this build
    // yet. The action is idempotent, so the method carries no semantics here.
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${routePrefix}/reconcile`,
      handler: guard((url, req, res) => {
        const sessionId = url.searchParams.get('session') ?? ''
        const raw = url.searchParams.get('scope')
        const scope = raw === 'self' || raw === 'tree' || raw === 'team' || raw === 'corpus'
          ? raw
          : wantedScope(url)
        return reconcile(sessionId, scope).then((body) => sendJson(res, body.ok === true ? 200 : 503, body))
      }),
    }))
    seen.routes = disposers.length
    console.log(`[${name}] serving ${routePrefix}?session=<id> (${disposers.length} routes)`)
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, `${name}: http routes`)

  /* ---------------------------------------------------------------- *
   * Tool + command (optional surfaces)
   * ---------------------------------------------------------------- */

  /**
   * Human-readable one-line cost summary for a session. Reports at the same
   * scope the widget uses (Team, then subtree, then self) and names the
   * subsession or teammate share when there is one.
   * @param {string} sessionId - session to summarize.
   * @param {object} [exactAgent] - the caller's own Agent, when it has one.
   * @returns {string} the summary line.
   */
  function describe(sessionId, exactAgent) {
    const view = sessionId === '' ? null : sessionView(sessionId, Date.now(), 'auto', exactAgent)
    const session = view === null ? null : view.session
    if (session === null || session.calls === 0) {
      return sessionId === ''
        ? 'Not metering any session yet — no model call has settled since the plugin loaded.'
        : `Session ${sessionId} has no metered calls yet.`
    }
    const models = Object.keys(session.byModel).join(', ')
    const kind = view.scope === 'team' ? 'Team' : view.scope === 'tree' ? 'Tree' : 'Session'
    const others = session.subagents === 0
      ? ''
      : ` · ${session.subagents} ${view.scope === 'team' ? 'teammate' : 'subsession'}${session.subagents === 1 ? '' : 's'} ${formatCny(session.subagentCostCny)}`
    return `${kind} ${sessionId}: ${formatCny(session.costCny)} (${formatUsd(session.costUsd)}) · `
      + `${session.calls} calls · cache-hit ${formatTokens(session.tokens.cacheHit)} · `
      + `cache-miss ${formatTokens(session.tokens.cacheMiss)} · output ${formatTokens(session.tokens.output)}`
      + `${others} · model ${models}`
  }

  if (config.tool !== false) {
    const tools = ctx.get('tools')
    if (tools !== undefined) {
      ctx.effect(() => tools.register({
        name: 'session_cost',
        description: 'Report the API cost of the current (or a named) session using DeepSeek published '
          + 'peak / off-peak rates. The figure covers the session AND every subsession it delegated to '
          + '(subagents / agent team), with the subsession share reported separately. Returns token '
          + 'buckets and the cost in CNY and USD.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sessionId: { type: 'string', description: 'Session to report; defaults to the current conversation.' },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessionId: { type: 'string' },
              calls: { type: 'integer' },
              costCny: { type: 'number' },
              costUsd: { type: 'number' },
              cacheHitTokens: { type: 'integer' },
              cacheMissTokens: { type: 'integer' },
              outputTokens: { type: 'integer' },
              peakCostCny: { type: 'number' },
              offPeakCostCny: { type: 'number' },
              subagentCostCny: { type: 'number' },
              subagents: { type: 'integer' },
              scope: { type: 'string' },
              text: { type: 'string' },
            },
            required: ['sessionId', 'calls', 'costCny', 'costUsd', 'text'],
          },
          render: (args, value) => [{ type: 'text', text: value.text }],
        },
        execute: async (args, exec) => {
          const explicit = typeof args?.sessionId === 'string' && args.sessionId !== '' ? args.sessionId : ''
          const current = sessionIdOf(exec?.agent)
          const sessionId = explicit !== '' ? explicit : (typeof current === 'string' ? current : '')
          // An explicitly named session has no live Agent to resolve Team
          // membership with, so it reports its own subtree.
          const view = sessionView(sessionId, Date.now(), explicit !== '' ? (includeTree ? 'tree' : 'self') : 'auto', exec?.agent)
          const session = view.session
          return {
            sessionId,
            calls: session === null ? 0 : session.calls,
            costCny: session === null ? 0 : Math.round(session.costCny * 1e6) / 1e6,
            costUsd: session === null ? 0 : Math.round(session.costUsd * 1e6) / 1e6,
            cacheHitTokens: session === null ? 0 : session.tokens.cacheHit,
            cacheMissTokens: session === null ? 0 : session.tokens.cacheMiss,
            outputTokens: session === null ? 0 : session.tokens.output,
            peakCostCny: session === null ? 0 : Math.round(session.peakCostCny * 1e6) / 1e6,
            offPeakCostCny: session === null ? 0 : Math.round(session.offPeakCostCny * 1e6) / 1e6,
            subagentCostCny: session === null ? 0 : Math.round(session.subagentCostCny * 1e6) / 1e6,
            subagents: session === null ? 0 : session.subagents,
            scope: view.scope,
            text: describe(sessionId, explicit !== '' ? undefined : exec?.agent),
          }
        },
        presentCall: () => ({ card: 'generic', title: 'Session API cost', kind: 'other', rawInput: {} }),
      }), `${name}: session_cost tool`)
    }
  }

  if (config.command !== false) {
    const commands = ctx.get('commands')
    if (commands !== undefined) {
      ctx.effect(() => commands.register({
        name: 'cost',
        description: 'Show the API cost of this conversation (DeepSeek peak / off-peak rates).',
        input: { hint: '[sessionId]' },
        handler: (invocation) => {
          const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : ''
          const current = sessionIdOf(invocation?.agent)
          const sessionId = raw !== '' ? raw : (typeof current === 'string' ? current : '')
          if (sessionId === '') return { kind: 'error', text: 'No session in scope; pass a session id: /cost <sessionId>' }
          const now = Date.now()
          // A named session has no live Agent to resolve Team membership with.
          const view = sessionView(sessionId, now, raw !== '' ? (includeTree ? 'tree' : 'self') : 'auto', invocation?.agent)
          const session = view.session
          const pricing = pricingSnapshot(now, session === null || session.recent.length === 0
            ? undefined
            : session.recent[session.recent.length - 1].modelId)
          const boundary = pricing.next === null || pricing.next.at === null
            ? ''
            : ` · ${pricing.next.peak ? 'peak' : 'off-peak'} in ${Math.max(0, Math.round((pricing.next.at - now) / 60000))} min`
          return {
            kind: 'success',
            text: `${describe(sessionId, raw !== '' ? undefined : invocation?.agent)}\nNow ${pricing.peak ? 'PEAK' : 'OFF-PEAK'} (${pricing.reason})${boundary}`
              + `\nRates now: cache-hit ¥${pricing.rates[pricing.peak ? 'peak' : 'offPeak'].cacheHitCny}/M · `
              + `cache-miss ¥${pricing.rates[pricing.peak ? 'peak' : 'offPeak'].cacheMissCny}/M · `
              + `output ¥${pricing.rates[pricing.peak ? 'peak' : 'offPeak'].outputCny}/M`,
          }
        },
      }), `${name}: /cost command`)
    }
  }

  console.log(`[${name}] pricing card ${RATE_CARD.retrievedAt} · effective ${RATE_CARD_EFFECTIVE_FROM}`)
}
