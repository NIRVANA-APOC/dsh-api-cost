import type { GateView } from '../shared/contracts.ts'
import { CostTransport } from './transport.ts'
import { scheduler, visibility } from './store.ts'
import type { Scheduler, Visibility } from './store.ts'

/** The snapshot `useSyncExternalStore` reads. Identity is stable between publishes. */
export interface GateStoreState {
  /** Last server-confirmed view. `null` until one read has succeeded, and kept on every later failure. */
  readonly gate: GateView | null
  /** A read is in flight. */
  readonly loading: boolean
  /** A write is in flight; the switch is frozen until the host answers. */
  readonly saving: boolean
  /** Last failure, or `null`. Never used as a substitute for state. */
  readonly error: string | null
}

const POLL_MS = 2000
/**
 * `state === 'holding'` lasts the whole peak window whenever the switch is on,
 * even with nothing parked, so a 2 s tick would run for hours for no new
 * information. The host has no push channel, so this is the price of noticing
 * that a request was just parked; nothing is polled while `off`/`open`.
 */
const IDLE_POLL_MS = 15000
const DEADLINE_MS = 8000
/** Browsers clamp longer delays; a distant boundary is re-armed instead of being read early. */
const MAX_DELAY = 2147483647
/** The snapshot of a session with no entry: one frozen value, so its identity is stable too. */
const EMPTY: GateStoreState = Object.freeze({ gate: null, loading: false, saving: false, error: null })
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const emit = (listeners: ReadonlySet<() => void>): void => { for (const listener of [...listeners]) listener() }

/**
 * One subscribed session. Every timer, flight and generation lives here rather
 * than on the store, which is what makes the per-session contract structural:
 * a write or a teardown on session A cannot reach session B's work by accident.
 */
interface Entry {
  readonly sessionId: string
  readonly listeners: Set<() => void>
  state: GateStoreState
  generation: number
  controller: AbortController | null
  flight: Promise<void> | null
  boundary: (() => void) | null
  poll: (() => void) | null
  deadline: (() => void) | null
  /** A write was cancelled (the page hid); re-read before trusting the last confirmed flag. */
  resync: boolean
}

/**
 * The client's mirror of the per-session off-peak gate (`src/host/gate.ts`).
 *
 * It is not a second source of truth: every value it publishes came back from
 * the host for that same session, a failed read keeps the last confirmed value,
 * and a failed write keeps the previous flag. The two things this store adds
 * are the cadence the panel needs (re-read at the next tier boundary, and every
 * 2 s while requests are actually parked) and a visibility pause, both copied
 * from `PricingStore`.
 *
 * The hold itself lives in the host process: this store only observes it, so a
 * closed panel, a hidden tab or a disposed plugin can never release or invent a
 * parked request.
 */
export class GateStore {
  private readonly entries = new Map<string, Entry>()
  private stopVisibility: (() => void) | null = null
  private disposed = false
  private readonly transport: CostTransport
  private readonly clock: Scheduler
  private readonly page: Visibility
  constructor(transport = new CostTransport(), clock: Scheduler = scheduler, page: Visibility = visibility) {
    this.transport = transport
    this.clock = clock
    this.page = page
  }
  /**
   * The view of one session. Never creates an entry: a session the panel has
   * not subscribed to cannot leak a map row just by being rendered.
   */
  snapshot = (sessionId: string): GateStoreState => this.entries.get(sessionId)?.state ?? EMPTY
  subscribe = (sessionId: string, listener: () => void): (() => void) => {
    if (this.disposed || sessionId === '') return () => {}
    const entry = this.entry(sessionId)
    entry.listeners.add(listener)
    // One visibility listener for the whole store: two stores (or two sessions)
    // must not install two document listeners for the same event.
    if (!this.stopVisibility) this.stopVisibility = this.page.subscribe(() => this.visibilityChanged())
    if (entry.listeners.size === 1) this.opened(entry)
    return () => {
      entry.listeners.delete(listener)
      if (entry.listeners.size !== 0) return
      // Teardown is scoped to this session: its flight dies, no other entry moves.
      this.cancel(entry)
      if (this.entries.get(sessionId) === entry) this.entries.delete(sessionId)
      if (![...this.entries.values()].some(row => row.listeners.size > 0)) {
        this.stopVisibility?.(); this.stopVisibility = null
      }
    }
  }
  /**
   * The only mutation, for the one session named. Optimistic-free: the switch
   * holds its last confirmed value until the host returns the view it actually
   * stored, so the panel can never claim a flag the host did not accept. A
   * write supersedes only this session's pending read — session B keeps its own.
   */
  setEnabled = async (sessionId: string, enabled: boolean): Promise<void> => {
    if (this.disposed || sessionId === '') return
    const entry = this.entry(sessionId)
    // A write supersedes this session's pending read: a late GET would describe the old flag.
    this.cancel(entry)
    entry.resync = false
    const generation = entry.generation
    const controller = new AbortController()
    entry.controller = controller
    const current = (): boolean => this.active(entry) && entry.generation === generation && !controller.signal.aborted
    // Cancelling the read settles `loading`; only the write is in flight now.
    this.publish(entry, { ...entry.state, loading: false, saving: true, error: null })
    entry.deadline = this.clock.later(() => {
      if (!current()) return
      this.cancel(entry)
      this.publish(entry, { ...entry.state, loading: false, saving: false, error: 'Request timed out' })
      this.arm(entry)
    }, DEADLINE_MS)
    try {
      const gate = await this.transport.setGate(sessionId, enabled, controller.signal)
      if (current()) this.publish(entry, { gate, loading: false, saving: false, error: null })
    } catch (error) {
      if (current()) this.publish(entry, { ...entry.state, loading: false, saving: false, error: message(error) })
    } finally {
      if (current()) {
        entry.deadline?.(); entry.deadline = null
        entry.controller = null
        this.arm(entry)
      } else if (this.entries.get(sessionId) === entry && entry.listeners.size === 0) {
        // The write outlived every listener: drop the orphan row rather than
        // leaving a `saving` snapshot behind for a later subscription to inherit.
        this.cancel(entry)
        this.entries.delete(sessionId)
      }
    }
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of [...this.entries.values()]) { this.cancel(entry); entry.listeners.clear() }
    this.entries.clear()
    this.stopVisibility?.(); this.stopVisibility = null
  }
  private entry(sessionId: string): Entry {
    let entry = this.entries.get(sessionId)
    if (!entry) {
      entry = { sessionId, listeners: new Set(), state: EMPTY, generation: 0, controller: null,
        flight: null, boundary: null, poll: null, deadline: null, resync: false }
      this.entries.set(sessionId, entry)
    }
    return entry
  }
  private active(entry: Entry): boolean {
    return !this.disposed && this.entries.get(entry.sessionId) === entry && entry.listeners.size > 0
  }
  private publish(entry: Entry, state: GateStoreState): void { entry.state = state; emit(entry.listeners) }
  private cancel(entry: Entry): void {
    entry.generation += 1
    entry.controller?.abort(); entry.controller = null; entry.flight = null
    entry.boundary?.(); entry.boundary = null
    entry.poll?.(); entry.poll = null
    entry.deadline?.(); entry.deadline = null
  }
  /** A view that describes an instant already past must be re-read, not trusted. */
  private stale(gate: GateView, now: number): boolean {
    return (gate.next !== null && gate.next.at <= now) || (gate.releaseAt !== null && gate.releaseAt <= now)
  }
  private opened(entry: Entry): void {
    if (!this.active(entry) || !this.page.visible()) return
    // A write is in flight: its answer will publish and arm. Starting a read now
    // would abort the write and could leave `saving` true without a confirmed view.
    if (entry.state.saving) { this.arm(entry); return }
    const gate = entry.state.gate
    if (entry.resync || !gate || this.stale(gate, this.clock.now())) void this.refresh(entry)
    else this.arm(entry)
  }
  private refresh = (entry: Entry): Promise<void> => {
    if (!this.active(entry) || !this.page.visible()) return Promise.resolve()
    if (entry.flight) return entry.flight
    this.cancel(entry)
    entry.resync = false
    const generation = entry.generation
    const controller = new AbortController()
    entry.controller = controller
    const current = (): boolean => this.active(entry) && entry.generation === generation && !controller.signal.aborted
    this.publish(entry, { ...entry.state, loading: true, error: null })
    entry.deadline = this.clock.later(() => {
      if (!current()) return
      this.cancel(entry)
      this.publish(entry, { ...entry.state, loading: false, error: 'Request timed out' })
      this.arm(entry)
    }, DEADLINE_MS)
    const promise = this.transport.gate(entry.sessionId, controller.signal)
      .then(gate => { if (current()) this.publish(entry, { gate, loading: false, saving: false, error: null }) })
      .catch((error: unknown) => { if (current()) this.publish(entry, { ...entry.state, loading: false, error: message(error) }) })
      .finally(() => {
        if (!current()) return
        entry.deadline?.(); entry.deadline = null
        entry.flight = null
        entry.controller = null
        this.arm(entry)
      })
    entry.flight = promise
    return promise
  }
  /**
   * Exactly two timers per session, never both idle while something is pending:
   *   * the boundary — the earlier of the next tier change and the hold release;
   *   * the poll — 2 s only while a request is really parked (the count and the
   *     hold duration move), 15 s while peak holds nothing, and never while the
   *     document is hidden or the gate is `off`/`open`.
   */
  private arm(entry: Entry): void {
    entry.boundary?.(); entry.boundary = null
    entry.poll?.(); entry.poll = null
    if (!this.active(entry) || !this.page.visible()) return
    const gate = entry.state.gate
    if (!gate) return
    if (gate.state === 'holding') {
      entry.poll = this.clock.later(() => { entry.poll = null; void this.refresh(entry) }, gate.holding > 0 ? POLL_MS : IDLE_POLL_MS)
    }
    const now = this.clock.now()
    // An instant already in the past is never armed: a clamp to 1 ms would spin.
    const instants = [gate.next?.at ?? null, gate.releaseAt].filter((at): at is number => at !== null && Number.isFinite(at) && at > now)
    if (instants.length === 0) return
    const delay = Math.min(MAX_DELAY, Math.max(1, Math.min(...instants) - now))
    entry.boundary = this.clock.later(() => { entry.boundary = null; this.opened(entry) }, delay)
  }
  /** A hidden document keeps no timer or flight alive; the host keeps holding regardless. */
  private visibilityChanged(): void {
    if (this.disposed) return
    for (const entry of [...this.entries.values()]) {
      if (entry.listeners.size === 0) continue
      if (!this.page.visible()) {
        const abandonedWrite = entry.state.saving
        this.cancel(entry)
        if (abandonedWrite) entry.resync = true
        if (entry.state.loading || entry.state.saving) this.publish(entry, { ...entry.state, loading: false, saving: false })
      } else if (this.active(entry)) {
        this.opened(entry)
      }
    }
  }
}
