import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PricingEngine } from '../pricing/index.ts'
import type { GateConfig, GateSource, GateState, GateView } from '../shared/contracts.ts'

export interface GateClock {
  now(): number
  /** Resolve `true` when the delay elapsed, `false` when `signal` aborted first. */
  sleep(milliseconds: number, signal?: AbortSignal | undefined): Promise<boolean>
}

export interface HoldOutcome { readonly released: boolean; readonly waitedMs: number }

export interface GateStore {
  /** The choice stored for exactly this session, or `undefined` when that session has none / it is unreadable. */
  read(sessionId: string): boolean | undefined
  /** Persist this session's choice; `true` when the write is durable. Never throws. */
  write(sessionId: string, enabled: boolean): boolean
}

export interface OffPeakGate {
  /** This session's control surface. Pure read; never throws. */
  readonly view: (sessionId: string) => GateView
  /** The only mutation; it touches exactly one session. Never rejects; persistence failure is reported, not thrown. */
  readonly setEnabled: (sessionId: string, enabled: boolean) => Promise<GateView>
  /** Hold this session's dispatch until the tier is off-peak. Resolves as soon as dispatch may proceed. Never rejects. */
  readonly wait: (sessionId: string, signal?: AbortSignal | undefined) => Promise<HoldOutcome>
  /**
   * Record the delegation link this session was announced with (`session/created`).
   * Links are live runtime state, not durable state: the durable file keeps only
   * explicit per-session choices. Never throws.
   */
  readonly observeSession: (sessionId: string, parentSession: string | undefined) => void
  /**
   * The `llm/stream` middleware. SYNCHRONOUS: returns an `AsyncIterable`, never a Promise.
   * When the gate does not apply to `options.sessionId` it must return `next()` — the very same object.
   */
  readonly middleware: <T>(options: { readonly signal?: AbortSignal | undefined; readonly sessionId?: string | undefined }, next: () => AsyncIterable<T>) => AsyncIterable<T>
  readonly dispose: () => void
}

export interface CreateGateOptions {
  readonly engine: PricingEngine
  readonly config?: GateConfig | undefined
  readonly clock?: GateClock | undefined
  readonly store?: GateStore | undefined
  /**
   * Synchronous live fallback for a parent link we have not been told about. Used
   * for a session that was never announced (e.g. one that existed before this
   * plugin loaded); a throwing or unknown resolver means "root".
   */
  readonly parentOf?: ((sessionId: string) => string | undefined) | undefined
  /** Called after every observable change, so a transport can publish it. */
  readonly onChange?: (() => void) | undefined
}

/** One timer arm may not exceed 2^31-1 ms: a larger delay overflows and fires at once. */
const MAX_SLEEP = 2147483647
/**
 * Bounded per-session memory. A session whose state is evicted is simply re-read
 * from the durable store on its next touch; the bound exists so a long-lived
 * process cannot accumulate one record per conversation it has ever seen.
 */
const MAX_SESSIONS = 1024
/**
 * Bounded parent-link memory. The links describe the live delegation tree; they
 * are deliberately not persisted. An evicted link is re-resolved from the live
 * resolver (or from a later `session/created`) on the next touch.
 */
const MAX_PARENT_LINKS = 4096
/**
 * A parent walk stops after this many hops. A cycle in the announced links is
 * not something the framework can produce, but a bounded walk is what keeps a
 * malformed tree from turning a model call into a spun loop.
 */
const MAX_ANCESTRY = 64
/**
 * Bounded durable file. Oldest `changedAt` goes first, because the most recently
 * switched sessions are the ones a user is most likely to still care about.
 */
const MAX_STORED_SESSIONS = 512
const GATE_FILE_NAME = 'gate.json'
const GATE_FILE_VERSION = 2
const GATE_FILE_ENV = 'DSH_API_COST_GATE_FILE'
const DSH_HOME_ENV = 'DSH_HOME'
const RELEASED_IMMEDIATELY: HoldOutcome = Object.freeze({ released: true, waitedMs: 0 })

/** How one wake ended: `failed` is a timer that could not be armed, and releases at once. */
type Wake = 'settled' | 'failed'
interface Guard { readonly promise: Promise<Wake>; readonly forget: () => void }

/**
 * A completion owned by this module rather than by the clock. `GateClock.sleep` is
 * contractually required to resolve `false` on abort, but a request must never be
 * parked forever because an injected clock overlooked that clause, so every wait
 * races its own abort completion as well.
 */
function abortGuard(signal: AbortSignal): Guard {
  let forget = (): void => {}
  const promise = new Promise<Wake>(resolve => {
    const listener = (): void => { resolve('settled') }
    signal.addEventListener('abort', listener, { once: true })
    forget = () => { signal.removeEventListener('abort', listener) }
    // A listener added to an already-aborted signal never fires, so re-check.
    if (signal.aborted) resolve('settled')
  })
  return { promise, forget: () => forget() }
}

interface Boundary { readonly at: number; readonly peak: boolean }

/** A tier boundary worth trusting; `null` for anything the hold paths must not act on. */
function readBoundary(value: unknown): Boundary | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as { readonly at?: unknown; readonly peak?: unknown }
  if (typeof record.at !== 'number' || !Number.isSafeInteger(record.at)) return null
  if (typeof record.peak !== 'boolean') return null
  return Object.freeze({ at: record.at, peak: record.peak })
}

/**
 * The boundary a hold may end at. The engine's contract is that `next` while peak
 * is the flip to off-peak; a `next` that still points at peak is a contradiction,
 * and holding on it could park a request past the cheap window.
 */
function releaseBoundary(next: unknown): number | null {
  const boundary = readBoundary(next)
  return boundary !== null && !boundary.peak ? boundary.at : null
}

interface Tier {
  readonly peak: boolean
  readonly reason: string
  readonly next: Boundary | null
  readonly revision: string
}
/** Fail-open classification: an engine that cannot be read means "dispatch now", never "hold". */
const TIER_UNAVAILABLE: Tier = Object.freeze({ peak: false, reason: 'pricing-unavailable', next: null, revision: 'unavailable' })

/** The effective position of one session and where it came from. */
interface Decision {
  readonly enabled: boolean
  readonly source: GateSource
  readonly inheritedFrom: string | null
}

/**
 * FNV-1a 64, matching the pricing engine's revision label. Only rendered fields are
 * folded in: a revision that moved with the wall clock would make every read a new
 * ETag and turn the client's conditional fetch into a poll. `sessionId` is folded
 * in because two sessions legitimately describe different values even when their
 * counters are identical, so their ETags must differ.
 */
function gateRevision(parts: readonly unknown[]): string {
  const text = JSON.stringify(parts)
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < text.length; index += 1) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(text.charCodeAt(index))) * 0x100000001b3n)
  }
  return `gate-${hash.toString(16)}`
}

/** Production clock. Tests inject their own, so no test ever sleeps in real time. */
function systemClock(): GateClock {
  return {
    now: (): number => Date.now(),
    sleep(milliseconds: number, signal?: AbortSignal | undefined): Promise<boolean> {
      if (signal?.aborted === true) return Promise.resolve(false)
      return new Promise<boolean>(resolve => {
        let settled = false
        const finish = (elapsed: boolean): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          resolve(elapsed)
        }
        const onAbort = (): void => { finish(false) }
        const timer = setTimeout(() => { finish(true) }, milliseconds)
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted === true) finish(false)
      })
    },
  }
}

/** A trimmed, non-blank path; anything else is treated as "not configured". */
function usablePath(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** A usable session id: a non-empty string. Format validation belongs to the HTTP surface. */
function usableSessionId(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `config.path` > `$DSH_API_COST_GATE_FILE` > `<dsh home>/state/dsh-api-cost/gate.json`. */
function gateFilePath(explicit: string | undefined): string | null {
  const direct = explicit ?? usablePath(process.env[GATE_FILE_ENV])
  if (direct !== undefined) return direct
  const configuredHome = usablePath(process.env[DSH_HOME_ENV])
  if (configuredHome !== undefined) return join(configuredHome, 'state', 'dsh-api-cost', GATE_FILE_NAME)
  let home: string
  try { home = homedir().trim() } catch { return null }
  return home === '' ? null : join(home, '.dsh', 'state', 'dsh-api-cost', GATE_FILE_NAME)
}

const NO_STORE: GateStore = Object.freeze({
  read: (_sessionId: string): undefined => undefined,
  write: (_sessionId: string, _enabled: boolean): boolean => false,
})

interface Holder {
  readonly startedAt: number
  readonly releaseAt: number
  /** Aborting this is how the gate releases a parked request without touching the caller's signal. */
  readonly stop: AbortController
}

/** The synchronous decision that a call has to be parked, plus its consumer-return channel. */
interface HoldPlan {
  readonly sessionId: string
  readonly controller: AbortController
  readonly signal: AbortSignal
}

/**
 * Everything the gate knows about one session. A record exists only after the
 * session has actually been seen; an evicted record is rebuilt from the durable
 * store (or from the configured default) on the next touch.
 *
 * `enabled`/`changedAt`/`durable` describe this session's OWN choice only. The
 * effective position is derived by walking the delegation links, so flipping a
 * parent never has to rewrite its descendants' records.
 */
interface SessionState {
  readonly sessionId: string
  /** This session's own stored/in-memory choice, else the configured default. */
  enabled: boolean
  /** True once this session has a choice of its own — stored durably or only held in memory. */
  explicit: boolean
  /** Instant this session's own switch last changed; null while it has no choice of its own. */
  changedAt: number | null
  /** True when this session's own choice is persisted for the next process. */
  durable: boolean
  heldTotal: number
  delayedMs: number
  /** Last access, for the bounded-session eviction order. */
  touched: number
  readonly holders: Map<number, Holder>
}

/** The default store contract is boolean-only; a richer store may also remember when. */
interface StoreWithChangedAt extends GateStore {
  readonly readChangedAt?: ((sessionId: string) => number | undefined) | undefined
}

/** The stored `changedAt` when the store can remember it, without requiring it. */
function storedChangedAt(store: GateStore, sessionId: string): number | null {
  try {
    const value = (store as StoreWithChangedAt).readChangedAt?.(sessionId)
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
  } catch { return null }
}

/** The subtree counters one rendered view aggregates over `self + tracked descendants`. */
interface SubtreeCounters {
  readonly holding: number
  readonly since: number | null
  readonly releaseAt: number | null
  readonly heldTotal: number
  readonly delayedMs: number
}

/**
 * The off-peak hold state machine: one gate per process, one independent switch
 * per session, and one delegation subtree under every session.
 *
 * The scope of a switch is this session **and the sessions it delegates to**: a
 * subagent session with no explicit choice of its own follows the nearest
 * explicit ancestor, so enabling a conversation parks its whole tree while an
 * unrelated conversation is untouched. The one switch the panel writes is the
 * session's own; inheritance is rebuilt from the live parent links (the durable
 * file never stores them).
 *
 * Every decision path fails open. The gate exists to move a settlement into the
 * cheap window; it must be incapable of delaying a call it cannot classify, of
 * dispatching one inside peak, of hanging one forever, and — since the switch is
 * scoped to one conversation tree — of parking a session whose tree never turned
 * the gate on.
 */
class Gate implements OffPeakGate {
  private readonly engine: PricingEngine
  private readonly clock: GateClock
  private readonly store: GateStore | null
  private readonly publish: (() => void) | undefined
  private readonly defaultEnabled: boolean
  private readonly parentOf: ((sessionId: string) => string | undefined) | undefined
  private readonly sessions = new Map<string, SessionState>()
  /**
   * The live delegation links, bounded and not persisted: child → parent (`null`
   * means "known root") plus the reverse index the subtree walks use. Both are
   * deliberately independent of `sessions`, whose records are evictable state.
   */
  private readonly parents = new Map<string, string | null>()
  private readonly children = new Map<string, Set<string>>()
  private sequence = 0
  /** Parked requests across every session: `holding` and `otherHolding` are both slices of this. */
  private totalHolding = 0
  /** Monotonic clock for the in-memory eviction order; never rendered. */
  private tick = 0
  private lastNow: number
  private disposed = false

  constructor(options: CreateGateOptions) {
    this.engine = options.engine
    this.clock = options.clock ?? systemClock()
    this.publish = options.onChange
    this.parentOf = options.parentOf
    const config = options.config
    this.store = config?.persist === false
      ? null
      : options.store ?? defaultGateStore(usablePath(config?.path))
    this.defaultEnabled = config?.enabled === true
    this.lastNow = Date.now()
  }

  /**
   * The clock reading a decision may use, or `null` when there is none. A display
   * read falls back to the last good instant; a hold must not act on a stale one.
   */
  private tryNow(): number | null {
    try {
      const instant = this.clock.now()
      if (Number.isSafeInteger(instant)) { this.lastNow = instant; return instant }
    } catch { /* handled by the caller: fail open, or render the last known instant */ }
    return null
  }

  private tier(now: number): Tier {
    try {
      const status = this.engine.status(now)
      if (status === null || typeof status !== 'object') return TIER_UNAVAILABLE
      if (typeof status.peak !== 'boolean') return TIER_UNAVAILABLE
      return {
        peak: status.peak,
        reason: typeof status.reason === 'string' && status.reason !== '' ? status.reason : 'unknown',
        next: readBoundary(status.next),
        revision: typeof status.revision === 'string' ? status.revision : 'unavailable',
      }
    } catch { return TIER_UNAVAILABLE }
  }

  /* ---------------------------------------------------------------- *
   * Delegation links (bounded, live-only, never persisted)
   * ---------------------------------------------------------------- */

  /** The cached link, touching its LRU position; `undefined` when it was never resolved. */
  private cachedParent(sessionId: string): string | null | undefined {
    if (!this.parents.has(sessionId)) return undefined
    const parent = this.parents.get(sessionId) ?? null
    this.parents.delete(sessionId)
    this.parents.set(sessionId, parent)
    return parent
  }

  private detachChild(parent: string, child: string): void {
    const siblings = this.children.get(parent)
    if (siblings === undefined) return
    siblings.delete(child)
    if (siblings.size === 0) this.children.delete(parent)
  }

  /**
   * Record (or replace) one child → parent link. A later `session/created` wins
   * over a live-resolver guess, and a self-link is a root rather than a cycle.
   */
  private linkParent(child: string, parent: string | null): void {
    const root = parent === child ? null : parent
    const existing = this.cachedParent(child)
    if (existing !== undefined && existing === root) return
    if (existing !== undefined && existing !== null) this.detachChild(existing, child)
    if (root !== null && root !== child) {
      const siblings = this.children.get(root)
      if (siblings === undefined) this.children.set(root, new Set([child]))
      else siblings.add(child)
    }
    this.parents.delete(child)
    this.parents.set(child, root)
    this.enforceParentCap()
  }

  /**
   * Keep the link cache bounded. Evicting a link loses nothing durable: the live
   * resolver (or the next `session/created`) supplies it again, and a session
   * without a link is a root.
   */
  private enforceParentCap(): void {
    while (this.parents.size > MAX_PARENT_LINKS) {
      const oldest = this.parents.keys().next()
      if (oldest.done === true) return
      const child = oldest.value
      const parent = this.parents.get(child) ?? null
      this.parents.delete(child)
      if (parent !== null) this.detachChild(parent, child)
    }
  }

  /** The live parent of one session: cached link, else the synchronous resolver, else root. */
  private nodeParent(sessionId: string): string | null {
    const cached = this.cachedParent(sessionId)
    if (cached !== undefined) return cached
    const resolver = this.parentOf
    if (resolver === undefined) { this.linkParent(sessionId, null); return null }
    let parent: string | null = null
    try {
      const candidate: unknown = resolver(sessionId)
      if (typeof candidate === 'string' && candidate !== '') parent = candidate
    } catch {
      // A resolver we cannot read is a root for this call; do not freeze that as
      // a link, because the very next `session/created` may know better.
      return null
    }
    this.linkParent(sessionId, parent)
    return parent
  }

  /** Record the delegation link a fresh session was announced with. Never throws. */
  readonly observeSession = (sessionId: string, parentSession: string | undefined): void => {
    try {
      const child = usableSessionId(sessionId)
      if (child === null) return
      this.linkParent(child, usableSessionId(parentSession))
    } catch { /* a link we could not record is one the live resolver may still supply */ }
  }

  /* ---------------------------------------------------------------- *
   * Effective decisions
   * ---------------------------------------------------------------- */

  /**
   * The effective position for one session: its own explicit choice, else the
   * nearest explicit ancestor's, else the configured default. Cycle-safe and
   * depth-bounded; never throws (the walk touches only in-memory state and the
   * never-throwing resolver seam).
   */
  private decide(sessionId: string): Decision {
    const seen = new Set<string>()
    let cursor: string | null = sessionId
    for (let depth = 0; cursor !== null && depth <= MAX_ANCESTRY; depth += 1) {
      if (seen.has(cursor)) break
      seen.add(cursor)
      const state = this.ensure(cursor)
      if (state.explicit) {
        return cursor === sessionId
          ? { enabled: state.enabled, source: 'self', inheritedFrom: null }
          : { enabled: state.enabled, source: 'inherited', inheritedFrom: cursor }
      }
      cursor = this.nodeParent(cursor)
    }
    return { enabled: this.defaultEnabled, source: 'default', inheritedFrom: null }
  }

  /** The tracked subtree of one session, `self` included, cycle-safe. */
  private subtree(sessionId: string): string[] {
    const ids: string[] = []
    const seen = new Set<string>()
    const stack: string[] = [sessionId]
    while (stack.length > 0) {
      const current = stack.pop() as string
      if (seen.has(current)) continue
      seen.add(current)
      ids.push(current)
      const descendants = this.children.get(current)
      if (descendants === undefined) continue
      for (const child of descendants) if (!seen.has(child)) stack.push(child)
    }
    return ids
  }

  /** The counters a view aggregates over this session's tracked subtree. */
  private aggregate(sessionId: string): SubtreeCounters {
    let holding = 0
    let since: number | null = null
    let releaseAt: number | null = null
    let heldTotal = 0
    let delayedMs = 0
    for (const member of this.subtree(sessionId)) {
      const state = this.sessions.get(member)
      if (state === undefined) continue
      for (const holder of state.holders.values()) {
        holding += 1
        if (since === null || holder.startedAt < since) since = holder.startedAt
        if (releaseAt === null || holder.releaseAt < releaseAt) releaseAt = holder.releaseAt
      }
      heldTotal += state.heldTotal
      delayedMs += state.delayedMs
    }
    return { holding, since, releaseAt, heldTotal, delayedMs }
  }

  /* ---------------------------------------------------------------- *
   * Session records and their bounded memory
   * ---------------------------------------------------------------- */

  /**
   * The record for this session, creating it (and consulting the store once) on
   * first touch. `prepare` runs before a fresh record joins the bounded map, so a
   * switch being stored is already marked as an explicit choice when the cap
   * decides what to evict — otherwise a brand-new session would look like an
   * inherited one and be the first thing thrown away.
   */
  private ensure(sessionId: string, prepare?: (state: SessionState) => void): SessionState {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) {
      if (prepare !== undefined) prepare(existing)
      existing.touched = ++this.tick
      return existing
    }
    const created = this.load(sessionId)
    if (prepare !== undefined) prepare(created)
    this.sessions.set(sessionId, created)
    this.enforceSessionCap()
    return created
  }

  private load(sessionId: string): SessionState {
    let stored: boolean | undefined
    let storedAt: number | null = null
    if (this.store !== null) {
      try {
        const value = this.store.read(sessionId)
        if (typeof value === 'boolean') { stored = value; storedAt = storedChangedAt(this.store, sessionId) }
      } catch { /* a store that throws is a store whose answer we do not have */ }
    }
    const inherited = stored === undefined
    return {
      sessionId,
      enabled: stored ?? this.defaultEnabled,
      explicit: !inherited,
      changedAt: inherited ? null : storedAt ?? this.tryNow() ?? this.lastNow,
      durable: !inherited,
      heldTotal: 0,
      delayedMs: 0,
      touched: ++this.tick,
      holders: new Map(),
    }
  }

  /**
   * Keep the in-memory session map bounded. Pure-inheritance records (no choice,
   * no parked request) are evicted first and oldest-touched first — losing one is
   * invisible, it is rebuilt from the default on the next touch. A record with a
   * choice survives as long as the bound allows, because dropping it would
   * silently undo the user's switch; a record with a holder is never evicted.
   */
  private enforceSessionCap(): void {
    if (this.sessions.size <= MAX_SESSIONS) return
    while (this.sessions.size > MAX_SESSIONS) {
      let victim: SessionState | null = null
      let victimRank: readonly [number, number] | null = null
      for (const state of this.sessions.values()) {
        if (state.holders.size > 0) continue
        // Lower is evicted first: an inherited, never-switched session before an
        // explicitly switched one, then the least recently touched.
        const rank: readonly [number, number] = [state.explicit ? 1 : 0, state.touched]
        if (victimRank === null || rank[0] < victimRank[0] || (rank[0] === victimRank[0] && rank[1] < victimRank[1])) {
          victim = state
          victimRank = rank
        }
      }
      if (victim === null) return
      this.sessions.delete(victim.sessionId)
    }
  }

  /** `since` is the oldest parked start in this session, `releaseAt` the earliest boundary one expects. */
  private parkedWindow(state: SessionState): { readonly since: number | null; readonly releaseAt: number | null } {
    let since: number | null = null
    let releaseAt: number | null = null
    for (const holder of state.holders.values()) {
      if (since === null || holder.startedAt < since) since = holder.startedAt
      if (releaseAt === null || holder.releaseAt < releaseAt) releaseAt = holder.releaseAt
    }
    return { since, releaseAt }
  }

  private holdSignature(state: SessionState): string {
    const window = this.parkedWindow(state)
    return `${state.holders.size}|${window.since ?? ''}|${window.releaseAt ?? ''}`
  }

  private emit(): void {
    const publish = this.publish
    if (publish === undefined) return
    try { publish() } catch { /* a publisher that throws must never break a model call */ }
  }

  private park(state: SessionState, id: number, startedAt: number, releaseAt: number, stop: AbortController): void {
    const before = this.holdSignature(state)
    state.holders.set(id, { startedAt, releaseAt, stop })
    this.totalHolding += 1
    if (this.holdSignature(state) !== before) this.emit()
  }

  private unpark(state: SessionState, id: number): void {
    if (!state.holders.has(id)) return
    const before = this.holdSignature(state)
    state.holders.delete(id)
    this.totalHolding = Math.max(0, this.totalHolding - 1)
    if (this.holdSignature(state) !== before) this.emit()
  }

  /**
   * Release every parked waiter of ONE session. The registry is cleared here
   * rather than in each waiter's continuation: those continuations only run on a
   * later microtask, and a view read in between must not report requests that were
   * already released. Other sessions are untouched — that is the whole point of
   * the tree scope.
   */
  private releaseSession(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (state === undefined || state.holders.size === 0) return
    const before = this.holdSignature(state)
    const released = state.holders.size
    for (const holder of state.holders.values()) {
      try { holder.stop.abort() } catch { /* keep releasing the rest */ }
    }
    state.holders.clear()
    this.totalHolding = Math.max(0, this.totalHolding - released)
    if (this.holdSignature(state) !== before) this.emit()
  }

  /**
   * Turning a switch OFF un-gates its own session and the descendants that were
   * following it. The walk stops at a descendant with an explicit choice of its
   * own: that choice wins, and its whole subtree keeps its position (an explicit
   * ON child stays parked and counted). Requests outside the tree are untouched.
   */
  private releaseInheriting(rootSessionId: string): void {
    const seen = new Set<string>()
    const stack: string[] = [rootSessionId]
    while (stack.length > 0) {
      const current = stack.pop() as string
      if (seen.has(current)) continue
      seen.add(current)
      this.releaseSession(current)
      const descendants = this.children.get(current)
      if (descendants === undefined) continue
      for (const child of descendants) {
        if (seen.has(child)) continue
        const childState = this.sessions.get(child)
        // A child that was switched by hand keeps its own choice; nothing below it
        // is un-gated by this change either.
        if (childState !== undefined && childState.explicit) continue
        stack.push(child)
      }
    }
  }

  private releaseAll(): void {
    for (const state of this.sessions.values()) this.releaseSession(state.sessionId)
  }

  /**
   * Re-attach a record that a cap pass could have dropped before it acquired a
   * holder. A parked record is never a candidate for eviction, so once re-inserted
   * here it is safe for the rest of the hold.
   */
  private registerHeld(state: SessionState): void {
    if (this.sessions.get(state.sessionId) === state) return
    this.sessions.set(state.sessionId, state)
    this.enforceSessionCap()
  }

  /** The whole fail-open classification, shared by the middleware's synchronous decision and the hold. */
  private planHold(sessionId: unknown, caller: AbortSignal | undefined): HoldPlan | null {
    try {
      const id = usableSessionId(sessionId)
      if (id === null || this.disposed) return null
      if (!this.decide(id).enabled) return null
      const now = this.tryNow()
      if (now === null) return null
      const tier = this.tier(now)
      if (!tier.peak || releaseBoundary(tier.next) === null) return null
      const controller = new AbortController()
      return { sessionId: id, controller, signal: caller === undefined ? controller.signal : AbortSignal.any([caller, controller.signal]) }
    } catch {
      return null
    }
  }

  private async slept(milliseconds: number, signal: AbortSignal): Promise<Wake> {
    try { await this.clock.sleep(milliseconds, signal); return 'settled' }
    catch { return 'failed' }
  }

  private settle(state: SessionState, startedAt: number, released: boolean): HoldOutcome {
    const now = this.tryNow()
    const waitedMs = now === null ? 0 : Math.max(0, now - startedAt)
    // Only a released hold delayed a dispatch; an aborted request was never sent, so
    // charging its wait to `delayedMs` would overstate what the gate cost the session.
    if (released) state.delayedMs += waitedMs
    return Object.freeze({ released, waitedMs })
  }

  /**
   * A record with parked holders is never evicted, and the loop has no `await`
   * between a release and the next park, so the state reference stays in the map
   * for the whole hold.
   */
  private async hold(state: SessionState, startedAt: number, signal: AbortSignal | undefined): Promise<HoldOutcome> {
    const stop = new AbortController()
    const combined = signal === undefined ? stop.signal : AbortSignal.any([signal, stop.signal])
    const id = ++this.sequence
    let parked = false
    try {
      for (;;) {
        if (this.disposed || stop.signal.aborted) return this.settle(state, startedAt, true)
        if (signal?.aborted === true) return this.settle(state, startedAt, false)
        const now = this.tryNow()
        if (now === null) return this.settle(state, startedAt, true)
        const tier = this.tier(now)
        if (!tier.peak) return this.settle(state, startedAt, true)
        const releaseAt = releaseBoundary(tier.next)
        // No boundary, or one that is already behind us while the tier still reports
        // peak: the engine and the clock disagree, and waiting on it would spin.
        if (releaseAt === null || releaseAt <= now) return this.settle(state, startedAt, true)
        if (!parked) { parked = true; state.heldTotal += 1 }
        this.park(state, id, startedAt, releaseAt, stop)
        // The holder now protects the record from eviction; re-attach it if a cap
        // pass had dropped it between its creation and this first park.
        this.registerHeld(state)
        const delay = Math.min(releaseAt - now, MAX_SLEEP)
        const guard = abortGuard(combined)
        const wake = await Promise.race<Wake>([this.slept(delay, combined), guard.promise])
        guard.forget()
        this.unpark(state, id)
        if (wake === 'failed') return this.settle(state, startedAt, true)
        // Every wake re-classifies: a suspend, a clock jump or an early timer can only
        // end in a fresh decision, never in a dispatch during peak.
      }
    } finally {
      this.unpark(state, id)
    }
  }

  private render(state: SessionState): GateView {
    const now = this.tryNow() ?? this.lastNow
    const tier = this.tier(now)
    const decision = this.decide(state.sessionId)
    const enabled = decision.enabled
    const name: GateState = !enabled ? 'off' : tier.peak ? 'holding' : 'open'
    // `holding`/`since`/`releaseAt`/`heldTotal`/`delayedMs` describe this session's
    // tracked subtree, not just this one session: the switch the panel writes
    // governs the whole conversation tree.
    const subtree = this.aggregate(state.sessionId)
    const holding = subtree.holding
    const ownHolding = state.holders.size
    const releaseAt = holding === 0 ? null : subtree.releaseAt
    const since = holding === 0 ? null : subtree.since
    const otherHolding = Math.max(0, this.totalHolding - holding)
    // Only this session's OWN choice may be reported as its own: an inherited or
    // default position was never switched by hand, so it can report neither a
    // change instant nor durability of its own.
    const changedAt = decision.source === 'self' ? state.changedAt : null
    const durable = decision.source === 'self' ? state.durable : false
    return Object.freeze({
      schemaVersion: 4,
      sessionId: state.sessionId,
      enabled,
      source: decision.source,
      inheritedFrom: decision.inheritedFrom,
      state: name,
      peak: tier.peak,
      reason: tier.reason,
      releaseAt,
      holding,
      ownHolding,
      since,
      heldTotal: subtree.heldTotal,
      delayedMs: subtree.delayedMs,
      changedAt,
      durable,
      // `now`, `since` and `delayedMs` are display-only. Folding them in would make
      // every read a new revision and defeat conditional fetching. `enabled`,
      // `source` and `inheritedFrom` are rendered (the panel shows who governs this
      // session), so two sessions that resolve to the same counters still differ.
      revision: gateRevision([state.sessionId, enabled, decision.source, decision.inheritedFrom, name, holding, ownHolding, otherHolding, releaseAt, changedAt, subtree.heldTotal, tier.revision]),
      next: tier.next,
      now,
      otherHolding,
    })
  }

  /** Defensive rendering for a caller that handed us no usable session id: fail open, never throw. */
  private renderUnknown(raw: unknown): GateView {
    const sessionId = typeof raw === 'string' ? raw : ''
    const now = this.tryNow() ?? this.lastNow
    const tier = this.tier(now)
    return Object.freeze({
      schemaVersion: 4,
      sessionId,
      enabled: false,
      source: 'default' as const,
      inheritedFrom: null,
      state: 'off' as const,
      peak: tier.peak,
      reason: tier.reason,
      releaseAt: null,
      holding: 0,
      ownHolding: 0,
      since: null,
      heldTotal: 0,
      delayedMs: 0,
      changedAt: null,
      durable: false,
      revision: gateRevision([sessionId, false, 'default', null, 'off', 0, 0, this.totalHolding, null, null, 0, tier.revision]),
      next: tier.next,
      now,
      otherHolding: this.totalHolding,
    })
  }

  readonly view = (sessionId: string): GateView => {
    try {
      const id = usableSessionId(sessionId)
      if (id === null) return this.renderUnknown(sessionId)
      return this.render(this.ensure(id))
    } catch {
      return this.renderUnknown(sessionId)
    }
  }

  readonly setEnabled = async (sessionId: string, enabled: boolean): Promise<GateView> => {
    const id = usableSessionId(sessionId)
    if (id === null) return this.renderUnknown(sessionId)
    if (!this.disposed) {
      const next = enabled === true
      const now = this.tryNow() ?? this.lastNow
      let changed = false
      let hadChoice = false
      let wasDurable = false
      // The mutation is applied inside `ensure`, before a fresh record joins the
      // bounded map, so the new explicit choice is never the cap's first victim.
      const state = this.ensure(id, (target) => {
        changed = next !== target.enabled
        hadChoice = target.explicit
        wasDurable = target.durable
        if (changed || !hadChoice) {
          target.enabled = next
          target.changedAt = now
          target.explicit = true
        }
      })
      if (this.store !== null) {
        try { state.durable = this.store.write(id, state.enabled) === true } catch { state.durable = false }
      } else {
        state.durable = false
      }
      // Switching off is a release order for the requests this change un-gates:
      // this session's own holders and the inheriting descendants'. Switching on
      // releases nothing.
      if (!next) this.releaseInheriting(id)
      if (changed || !hadChoice || state.durable !== wasDurable) this.emit()
    }
    return this.view(id)
  }

  readonly wait = async (sessionId: string, signal?: AbortSignal | undefined): Promise<HoldOutcome> => {
    try {
      const id = usableSessionId(sessionId)
      if (id === null) return RELEASED_IMMEDIATELY
      const startedAt = this.tryNow()
      // A gate that is off, disposed, or unable to read its clock has nothing to hold.
      if (startedAt === null || this.disposed) return RELEASED_IMMEDIATELY
      const state = this.ensure(id)
      if (!this.decide(id).enabled) return RELEASED_IMMEDIATELY
      return await this.hold(state, startedAt, signal)
    } catch {
      return RELEASED_IMMEDIATELY
    }
  }

  readonly middleware = <T>(options: { readonly signal?: AbortSignal | undefined; readonly sessionId?: string | undefined }, next: () => AsyncIterable<T>): AsyncIterable<T> => {
    // A session-less request is never gated: the switch controls conversations, not the process.
    let plan: HoldPlan | null = null
    try { plan = this.planHold(options?.sessionId, options?.signal) } catch { plan = null }
    // The ungated path must be invisible: the very object `next()` returned, not a wrapper.
    if (plan === null) return next()
    const { controller, signal, sessionId } = plan
    const gate = this
    const iterator: AsyncGenerator<T, void, unknown> = (async function* (): AsyncGenerator<T, void, unknown> {
      // `next()` stays uncalled while parked: the provider dispatch is lazy, so not
      // calling it is exactly what keeps a peak-priced request from being sent.
      try { await gate.wait(sessionId, signal) } catch { /* wait never rejects; a broken hold must still dispatch */ }
      // Only our own consumer-return channel means "nobody wants the stream": a caller
      // abort deliberately falls through, so the framework can emit its canonical
      // aborted finish chunk instead of us inventing a terminal one.
      if (controller.signal.aborted) return
      yield* next()
    })()
    return {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next: (value?: unknown) => iterator.next(value),
          // A consumer that abandons the stream must end the hold now, not at the
          // boundary: a plain generator parked at an await could not observe a queued
          // return() until the await settled, and would dispatch for nobody.
          return: () => { controller.abort(); return iterator.return(undefined) },
          throw: (error?: unknown) => { controller.abort(); return iterator.throw(error) },
        }
      },
    }
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    // Aborting each holder's stop signal is also what cancels the default clock's
    // timer, so a disposed gate leaves no armed timer behind.
    this.releaseAll()
  }
}

export function createOffPeakGate(options: CreateGateOptions): OffPeakGate {
  const gate = new Gate(options)
  // A frozen facade over arrow methods: handing `middleware` to the waterfall cannot
  // lose its receiver, and the public shape cannot be mutated by a caller.
  return Object.freeze({
    view: gate.view,
    setEnabled: gate.setEnabled,
    wait: gate.wait,
    observeSession: gate.observeSession,
    middleware: gate.middleware,
    dispose: gate.dispose,
  })
}

interface StoredEntry { readonly enabled: boolean; readonly changedAt: number }

/** Parse the durable document; anything that is not a valid v2 file contributes nothing. */
function readStoredSessions(target: string): Map<string, StoredEntry> {
  const sessions = new Map<string, StoredEntry>()
  try {
    const parsed: unknown = JSON.parse(readFileSync(target, 'utf8'))
    // A version-1 file held ONE process-global flag: it cannot be attributed to a
    // session, so it is deliberately ignored rather than guessed at.
    if (!isRecord(parsed) || parsed['version'] !== GATE_FILE_VERSION || !isRecord(parsed['sessions'])) return sessions
    for (const [sessionId, entry] of Object.entries(parsed['sessions'])) {
      if (sessionId === '' || !isRecord(entry)) continue
      const enabled: unknown = entry['enabled']
      const changedAt: unknown = entry['changedAt']
      if (typeof enabled !== 'boolean' || typeof changedAt !== 'number' || !Number.isSafeInteger(changedAt) || changedAt < 0) continue
      sessions.set(sessionId, Object.freeze({ enabled, changedAt }))
    }
  } catch { /* missing / unreadable / corrupt: treat as "nothing stored" */ }
  return sessions
}

/** Serialize the map back into the v2 document shape, preserving insertion order for tie-breaking. */
function writeStoredSessions(target: string, sessions: ReadonlyMap<string, StoredEntry>, sequence: number): boolean {
  const temporary = `${target}.${process.pid}.${sequence}.tmp`
  try {
    const document = { version: GATE_FILE_VERSION, sessions: Object.fromEntries([...sessions].map(([id, entry]) => [id, { enabled: entry.enabled, changedAt: entry.changedAt }])) }
    mkdirSync(dirname(target), { recursive: true })
    // A sibling temporary file plus rename keeps the file readable at every instant:
    // a partially written target would be indistinguishable from a corrupt one.
    writeFileSync(temporary, `${JSON.stringify(document)}\n`, 'utf8')
    renameSync(temporary, target)
    return true
  } catch {
    try { rmSync(temporary, { force: true }) } catch { /* the flag is already lost; report, do not throw */ }
    return false
  }
}

/**
 * The default durable store: `<dsh home>/state/dsh-api-cost/gate.json`, holding at
 * most 512 sessions. It keeps only explicit per-session choices and their
 * `changedAt`; the delegation links are never written (they are live runtime
 * state), so inheritance is reconstructed from the live tree after a restart.
 */
export function defaultGateStore(path?: string | undefined): GateStore {
  const target = gateFilePath(usablePath(path))
  // Nowhere to write is reported as "not durable" by `write`, which is the truth.
  if (target === null) return NO_STORE
  let sequence = 0
  // The extra `readChangedAt` capability is deliberately not part of `GateStore`:
  // it is an enrichment the gate uses when a store offers it, never a requirement.
  const store = {
    read(sessionId: string): boolean | undefined {
      try { return readStoredSessions(target).get(sessionId)?.enabled } catch { return undefined }
    },
    readChangedAt(sessionId: string): number | undefined {
      try { return readStoredSessions(target).get(sessionId)?.changedAt } catch { return undefined }
    },
    write(sessionId: string, enabled: boolean): boolean {
      sequence += 1
      try {
        const sessions = readStoredSessions(target)
        sessions.set(sessionId, Object.freeze({ enabled: enabled === true, changedAt: Date.now() }))
        while (sessions.size > MAX_STORED_SESSIONS) {
          let victim: string | null = null
          let victimAt = Number.POSITIVE_INFINITY
          for (const [id, entry] of sessions) {
            if (entry.changedAt < victimAt) { victim = id; victimAt = entry.changedAt }
          }
          if (victim === null) break
          sessions.delete(victim)
        }
        return writeStoredSessions(target, sessions, sequence)
      } catch { return false }
    },
  }
  return store
}
