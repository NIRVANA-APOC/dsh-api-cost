import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PricingEngine } from '../pricing/index.ts'
import type { GateConfig, GateState, GateView } from '../shared/contracts.ts'

export interface GateClock {
  now(): number
  /** Resolve `true` when the delay elapsed, `false` when `signal` aborted first. */
  sleep(milliseconds: number, signal?: AbortSignal | undefined): Promise<boolean>
}

export interface HoldOutcome { readonly released: boolean; readonly waitedMs: number }

export interface GateStore {
  /** The stored flag, or `undefined` when nothing has been stored / it is unreadable. */
  read(): boolean | undefined
  /** Persist `enabled`; `true` when the write is durable. Never throws. */
  write(enabled: boolean): boolean
}

export interface OffPeakGate {
  /** Current value. Pure read; never throws. */
  readonly view: () => GateView
  /** The only mutation. Never rejects; persistence failure is reported, not thrown. */
  readonly setEnabled: (enabled: boolean) => Promise<GateView>
  /** Hold until the tier is off-peak. Resolves as soon as dispatch may proceed. Never rejects. */
  readonly wait: (signal?: AbortSignal | undefined) => Promise<HoldOutcome>
  /**
   * The `llm/stream` middleware. SYNCHRONOUS: returns an `AsyncIterable`, never a Promise.
   * When the gate does not apply it must return `next()` — the very same object.
   */
  readonly middleware: <T>(options: { readonly signal?: AbortSignal | undefined }, next: () => AsyncIterable<T>) => AsyncIterable<T>
  readonly dispose: () => void
}

export interface CreateGateOptions {
  readonly engine: PricingEngine
  readonly config?: GateConfig | undefined
  readonly clock?: GateClock | undefined
  readonly store?: GateStore | undefined
  /** Called after every observable change, so a transport can publish it. */
  readonly onChange?: (() => void) | undefined
}

/** One timer arm may not exceed 2^31-1 ms: a larger delay overflows and fires at once. */
const MAX_SLEEP = 2147483647
const GATE_FILE_ENV = 'DSH_API_COST_GATE_FILE'
const DSH_HOME_ENV = 'DSH_HOME'
const GATE_FILE_NAME = 'gate.json'
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

/**
 * FNV-1a 64, matching the pricing engine's revision label. Only rendered fields are
 * folded in: a revision that moved with the wall clock would make every read a new
 * ETag and turn the client's conditional fetch into a poll.
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

const NO_STORE: GateStore = Object.freeze({ read: (): undefined => undefined, write: (): boolean => false })

interface Holder {
  readonly startedAt: number
  readonly releaseAt: number
  /** Aborting this is how the gate releases a parked request without touching the caller's signal. */
  readonly stop: AbortController
}

/**
 * The hold state machine: one instance per process, one holder per parked request.
 *
 * Every decision path fails open. The gate exists to move a settlement into the
 * cheap window; it must be incapable of delaying a call it cannot classify, of
 * dispatching one inside peak, and of hanging one forever.
 */
class Gate implements OffPeakGate {
  private readonly engine: PricingEngine
  private readonly clock: GateClock
  private readonly store: GateStore | null
  private readonly publish: (() => void) | undefined
  private readonly holders = new Map<number, Holder>()
  private sequence = 0
  private enabled: boolean
  private durable: boolean
  private changedAt: number
  private heldTotal = 0
  private delayedMs = 0
  private lastNow: number
  private disposed = false

  constructor(options: CreateGateOptions) {
    this.engine = options.engine
    this.clock = options.clock ?? systemClock()
    this.publish = options.onChange
    const config = options.config
    const store = config?.persist === false
      ? null
      : options.store ?? defaultGateStore(usablePath(config?.path))
    this.store = store
    let stored: boolean | undefined
    if (store !== null) {
      try {
        const value = store.read()
        if (typeof value === 'boolean') stored = value
      } catch { /* a store that throws is a store whose answer we do not have */ }
    }
    this.enabled = stored ?? (config?.enabled === true)
    // `durable` answers "does the enabled flag survive a restart", so it is true only
    // once the flag has actually been read from, or written to, durable storage.
    this.durable = stored !== undefined
    this.lastNow = Date.now()
    this.changedAt = this.tryNow() ?? this.lastNow
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

  /** `since` is the oldest parked start, `releaseAt` the earliest boundary a holder expects. */
  private parkedWindow(): { readonly since: number | null; readonly releaseAt: number | null } {
    let since: number | null = null
    let releaseAt: number | null = null
    for (const holder of this.holders.values()) {
      if (since === null || holder.startedAt < since) since = holder.startedAt
      if (releaseAt === null || holder.releaseAt < releaseAt) releaseAt = holder.releaseAt
    }
    return { since, releaseAt }
  }

  private holdSignature(): string {
    const window = this.parkedWindow()
    return `${this.holders.size}|${window.since ?? ''}|${window.releaseAt ?? ''}`
  }

  private emit(): void {
    const publish = this.publish
    if (publish === undefined) return
    try { publish() } catch { /* a publisher that throws must never break a model call */ }
  }

  private park(id: number, startedAt: number, releaseAt: number, stop: AbortController): void {
    const before = this.holdSignature()
    this.holders.set(id, { startedAt, releaseAt, stop })
    if (this.holdSignature() !== before) this.emit()
  }

  private unpark(id: number): void {
    if (!this.holders.has(id)) return
    const before = this.holdSignature()
    this.holders.delete(id)
    if (this.holdSignature() !== before) this.emit()
  }

  /**
   * Release every parked waiter. The registry is cleared here rather than in each
   * waiter's continuation: those continuations only run on a later microtask, and a
   * view read in between must not report requests that were already released.
   */
  private releaseAll(): void {
    for (const holder of this.holders.values()) {
      try { holder.stop.abort() } catch { /* keep releasing the rest */ }
    }
    this.holders.clear()
  }

  /** The whole fail-open classification, shared by the middleware's synchronous decision and the hold. */
  private planHold(caller: AbortSignal | undefined): { readonly controller: AbortController; readonly signal: AbortSignal } | null {
    try {
      if (this.disposed || !this.enabled) return null
      const now = this.tryNow()
      if (now === null) return null
      const tier = this.tier(now)
      if (!tier.peak || releaseBoundary(tier.next) === null) return null
      const controller = new AbortController()
      return { controller, signal: caller === undefined ? controller.signal : AbortSignal.any([caller, controller.signal]) }
    } catch {
      return null
    }
  }

  private async slept(milliseconds: number, signal: AbortSignal): Promise<Wake> {
    try { await this.clock.sleep(milliseconds, signal); return 'settled' }
    catch { return 'failed' }
  }

  private settle(startedAt: number, released: boolean): HoldOutcome {
    const now = this.tryNow()
    const waitedMs = now === null ? 0 : Math.max(0, now - startedAt)
    // Only a released hold delayed a dispatch; an aborted request was never sent, so
    // charging its wait to `delayedMs` would overstate what the gate cost the session.
    if (released) this.delayedMs += waitedMs
    return Object.freeze({ released, waitedMs })
  }

  private async hold(startedAt: number, signal: AbortSignal | undefined): Promise<HoldOutcome> {
    const stop = new AbortController()
    const combined = signal === undefined ? stop.signal : AbortSignal.any([signal, stop.signal])
    const id = ++this.sequence
    let parked = false
    try {
      for (;;) {
        if (this.disposed || stop.signal.aborted) return this.settle(startedAt, true)
        if (signal?.aborted === true) return this.settle(startedAt, false)
        const now = this.tryNow()
        if (now === null) return this.settle(startedAt, true)
        const tier = this.tier(now)
        if (!tier.peak) return this.settle(startedAt, true)
        const releaseAt = releaseBoundary(tier.next)
        // No boundary, or one that is already behind us while the tier still reports
        // peak: the engine and the clock disagree, and waiting on it would spin.
        if (releaseAt === null || releaseAt <= now) return this.settle(startedAt, true)
        if (!parked) { parked = true; this.heldTotal += 1 }
        this.park(id, startedAt, releaseAt, stop)
        const delay = Math.min(releaseAt - now, MAX_SLEEP)
        const guard = abortGuard(combined)
        const wake = await Promise.race<Wake>([this.slept(delay, combined), guard.promise])
        guard.forget()
        this.unpark(id)
        if (wake === 'failed') return this.settle(startedAt, true)
        // Every wake re-classifies: a suspend, a clock jump or an early timer can only
        // end in a fresh decision, never in a dispatch during peak.
      }
    } finally {
      this.unpark(id)
    }
  }

  readonly view = (): GateView => {
    const now = this.tryNow() ?? this.lastNow
    const tier = this.tier(now)
    const enabled = this.enabled
    const state: GateState = !enabled ? 'off' : tier.peak ? 'holding' : 'open'
    const holding = this.holders.size
    const window = this.parkedWindow()
    const releaseAt = holding === 0 ? null : window.releaseAt
    return Object.freeze({
      schemaVersion: 2,
      enabled,
      state,
      peak: tier.peak,
      reason: tier.reason,
      releaseAt,
      holding,
      since: holding === 0 ? null : window.since,
      heldTotal: this.heldTotal,
      delayedMs: this.delayedMs,
      changedAt: this.changedAt,
      durable: this.durable,
      // `now`, `since` and `delayedMs` are display-only. Folding them in would make
      // every read a new revision and defeat conditional fetching.
      revision: gateRevision([enabled, state, holding, releaseAt, this.changedAt, this.heldTotal, tier.revision]),
      next: tier.next,
      now,
    })
  }

  readonly setEnabled = async (enabled: boolean): Promise<GateView> => {
    if (!this.disposed) {
      const next = enabled === true
      const changed = next !== this.enabled
      const wasDurable = this.durable
      if (changed) {
        this.enabled = next
        this.changedAt = this.tryNow() ?? this.lastNow
      }
      if (this.store !== null) {
        try { this.durable = this.store.write(this.enabled) === true } catch { this.durable = false }
      }
      // Switching off is a release order: parked requests must proceed at once.
      if (changed && !this.enabled) this.releaseAll()
      if (changed || this.durable !== wasDurable) this.emit()
    }
    return this.view()
  }

  readonly wait = async (signal?: AbortSignal | undefined): Promise<HoldOutcome> => {
    const startedAt = this.tryNow()
    // A gate that is off, disposed, or unable to read its clock has nothing to hold.
    if (startedAt === null || this.disposed || !this.enabled) return RELEASED_IMMEDIATELY
    try {
      return await this.hold(startedAt, signal)
    } catch {
      return this.settle(startedAt, true)
    }
  }

  readonly middleware = <T>(options: { readonly signal?: AbortSignal | undefined }, next: () => AsyncIterable<T>): AsyncIterable<T> => {
    const plan = this.planHold(options?.signal)
    // The ungated path must be invisible: the very object `next()` returned, not a wrapper.
    if (plan === null) return next()
    const { controller, signal } = plan
    const gate = this
    const iterator: AsyncGenerator<T, void, unknown> = (async function* (): AsyncGenerator<T, void, unknown> {
      // `next()` stays uncalled while parked: the provider dispatch is lazy, so not
      // calling it is exactly what keeps a peak-priced request from being sent.
      try { await gate.wait(signal) } catch { /* wait never rejects; a broken hold must still dispatch */ }
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
    middleware: gate.middleware,
    dispose: gate.dispose,
  })
}

/** The default durable flag: `<dsh home>/state/dsh-api-cost/gate.json`. */
export function defaultGateStore(path?: string | undefined): GateStore {
  const target = gateFilePath(usablePath(path))
  // Nowhere to write is reported as "not durable" by `write`, which is the truth.
  if (target === null) return NO_STORE
  let sequence = 0
  return {
    read(): boolean | undefined {
      try {
        const parsed: unknown = JSON.parse(readFileSync(target, 'utf8'))
        if (parsed === null || typeof parsed !== 'object') return undefined
        const record = parsed as { readonly version?: unknown; readonly enabled?: unknown }
        return record.version === 1 && typeof record.enabled === 'boolean' ? record.enabled : undefined
      } catch { return undefined }
    },
    write(enabled: boolean): boolean {
      sequence += 1
      // A sibling temporary file plus rename keeps the flag readable at every instant:
      // a partially written target would be indistinguishable from a corrupt one.
      const temporary = `${target}.${process.pid}.${sequence}.tmp`
      try {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(temporary, `${JSON.stringify({ version: 1, enabled, changedAt: Date.now() })}\n`, 'utf8')
        renameSync(temporary, target)
        return true
      } catch {
        try { rmSync(temporary, { force: true }) } catch { /* the flag is already lost; report, do not throw */ }
        return false
      }
    },
  }
}
