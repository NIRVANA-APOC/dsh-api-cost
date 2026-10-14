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
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const emit = (listeners: ReadonlySet<() => void>): void => { for (const listener of [...listeners]) listener() }

/**
 * The client's mirror of the off-peak gate (`src/host/gate.ts`).
 *
 * It is not a second source of truth: every value it publishes came back from
 * the host, a failed read keeps the last confirmed value, and a failed write
 * keeps the previous flag. The two things this store adds are the cadence the
 * panel needs (re-read at the next tier boundary, and every 2 s while requests
 * are actually parked) and a visibility pause, both copied from `PricingStore`.
 *
 * The hold itself lives in the host process: this store only observes it, so a
 * closed panel, a hidden tab or a disposed plugin can never release or invent a
 * parked request.
 */
export class GateStore {
  private state: GateStoreState = { gate: null, loading: false, saving: false, error: null }
  private readonly listeners = new Set<() => void>()
  private controller: AbortController | null = null
  private flight: Promise<void> | null = null
  private generation = 0
  private boundary: (() => void) | null = null
  private poll: (() => void) | null = null
  private deadline: (() => void) | null = null
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
  snapshot = (): GateStoreState => this.state
  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      this.stopVisibility = this.page.subscribe(() => {
        // A hidden document keeps no timer alive; the host keeps holding regardless.
        if (!this.page.visible()) { this.cancel(); this.publish({ ...this.state, loading: false }) }
        else this.ensure()
      })
      this.ensure()
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) { this.cancel(); this.stopVisibility?.(); this.stopVisibility = null }
    }
  }
  /**
   * The only mutation. Optimistic-free: the switch holds its last confirmed
   * value until the host returns the view it actually stored, so the panel can
   * never claim a flag the host did not accept.
   */
  setEnabled = async (enabled: boolean): Promise<void> => {
    if (this.disposed) return
    // A write supersedes every pending read: a late GET would describe the old flag.
    this.cancel()
    const generation = this.generation
    const controller = new AbortController()
    this.controller = controller
    const current = (): boolean => !this.disposed && this.listeners.size > 0 && generation === this.generation && !controller.signal.aborted
    this.publish({ ...this.state, saving: true, error: null })
    this.deadline = this.clock.later(() => {
      if (!current()) return
      this.cancel()
      this.publish({ ...this.state, saving: false, error: 'Request timed out' })
      this.arm()
    }, DEADLINE_MS)
    try {
      const gate = await this.transport.setGate(enabled, controller.signal)
      if (current()) this.publish({ gate, loading: false, saving: false, error: null })
    } catch (error) {
      if (current()) this.publish({ ...this.state, loading: false, saving: false, error: message(error) })
    } finally {
      if (current()) {
        this.deadline?.(); this.deadline = null
        this.controller = null
        this.arm()
      }
    }
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancel()
    this.listeners.clear()
    this.stopVisibility?.(); this.stopVisibility = null
  }
  private publish(state: GateStoreState): void { this.state = state; emit(this.listeners) }
  private cancel(): void {
    this.generation += 1
    this.controller?.abort(); this.controller = null; this.flight = null
    this.boundary?.(); this.boundary = null
    this.poll?.(); this.poll = null
    this.deadline?.(); this.deadline = null
  }
  /** A view that describes an instant already past must be re-read, not trusted. */
  private stale(gate: GateView, now: number): boolean {
    return (gate.next !== null && gate.next.at <= now) || (gate.releaseAt !== null && gate.releaseAt <= now)
  }
  private ensure(): void {
    if (this.disposed || this.listeners.size === 0 || !this.page.visible()) return
    const gate = this.state.gate
    if (!gate || this.stale(gate, this.clock.now())) void this.refresh()
    else this.arm()
  }
  refresh = (): Promise<void> => {
    if (this.disposed || this.listeners.size === 0 || !this.page.visible()) return Promise.resolve()
    if (this.flight) return this.flight
    this.cancel()
    const generation = this.generation
    const controller = new AbortController()
    this.controller = controller
    const current = (): boolean => !this.disposed && this.listeners.size > 0 && generation === this.generation && !controller.signal.aborted
    this.publish({ ...this.state, loading: true, error: null })
    this.deadline = this.clock.later(() => {
      if (!current()) return
      this.cancel()
      this.publish({ ...this.state, loading: false, error: 'Request timed out' })
      this.arm()
    }, DEADLINE_MS)
    const promise = this.transport.gate(controller.signal)
      .then(gate => { if (current()) this.publish({ gate, loading: false, saving: false, error: null }) })
      .catch((error: unknown) => { if (current()) this.publish({ ...this.state, loading: false, error: message(error) }) })
      .finally(() => {
        if (!current()) return
        this.deadline?.(); this.deadline = null
        this.flight = null
        this.controller = null
        this.arm()
      })
    this.flight = promise
    return promise
  }
  /**
   * Exactly two timers, never both idle while something is pending:
   *   * the boundary — the earlier of the next tier change and the hold release;
   *   * the poll — 2 s only while a request is really parked (the count and the
   *     hold duration move), 15 s while peak holds nothing, and never while the
   *     document is hidden or the gate is `off`/`open`.
   */
  private arm(): void {
    this.boundary?.(); this.boundary = null
    this.poll?.(); this.poll = null
    if (this.disposed || this.listeners.size === 0 || !this.page.visible()) return
    const gate = this.state.gate
    if (!gate) return
    if (gate.state === 'holding') {
      this.poll = this.clock.later(() => { this.poll = null; void this.refresh() }, gate.holding > 0 ? POLL_MS : IDLE_POLL_MS)
    }
    const now = this.clock.now()
    // An instant already in the past is never armed: a clamp to 1 ms would spin.
    const instants = [gate.next?.at ?? null, gate.releaseAt].filter((at): at is number => at !== null && Number.isFinite(at) && at > now)
    if (instants.length === 0) return
    const delay = Math.min(MAX_DELAY, Math.max(1, Math.min(...instants) - now))
    this.boundary = this.clock.later(() => { this.boundary = null; this.ensure() }, delay)
  }
}
