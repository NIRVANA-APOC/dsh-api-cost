import type { CostView, PricingView } from '../shared/contracts.ts'
import { CostTransport } from './transport.ts'
import type { Detail } from './transport.ts'

export interface Scheduler {
  now(): number
  later(callback: () => void, milliseconds: number): () => void
}
export interface Visibility {
  visible(): boolean
  subscribe(listener: () => void): () => void
}
const scheduler: Scheduler = {
  now: () => Date.now(),
  later(callback, ms) { const timer = globalThis.setTimeout(callback, ms); return () => globalThis.clearTimeout(timer) },
}
const visibility: Visibility = {
  visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  subscribe(listener) {
    if (typeof document === 'undefined') return () => {}
    document.addEventListener('visibilitychange', listener)
    return () => document.removeEventListener('visibilitychange', listener)
  },
}
export interface ViewState { readonly view: CostView | null; readonly loading: boolean; readonly error: string | null }
export interface PricingState { readonly pricing: PricingView | null; readonly loading: boolean; readonly error: string | null }
export interface Observation {
  readonly running: boolean
  readonly projectionReady: boolean
  readonly projectionRevision: string
  readonly catalogRevision: string
  readonly catalogProjectionRevision: string
}
interface Flight { readonly controller: AbortController; readonly generation: number; readonly detail: Detail; readonly promise: Promise<void>; readonly deadline: () => void }
interface Entry {
  readonly sessionId: string
  readonly listeners: Set<() => void>
  state: ViewState
  observation: Observation
  generation: number
  panels: number
  flight: Flight | null
  poll: (() => void) | null
  queued: boolean
  dirty: boolean
}
const emptyObservation: Observation = { running: false, projectionReady: false, projectionRevision: '', catalogRevision: '', catalogProjectionRevision: '' }
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const emit = (listeners: ReadonlySet<() => void>): void => { for (const listener of [...listeners]) listener() }

/** A small HTTP bridge for scope discovery/cross-session views. Native own projections never live here. */
export class CostStore {
  private readonly entries = new Map<string, Entry>()
  private stopVisibility: (() => void) | null = null
  private disposed = false
  readonly pricing: PricingStore
  private readonly transport: CostTransport
  private readonly clock: Scheduler
  private readonly page: Visibility
  constructor(transport = new CostTransport(), clock: Scheduler = scheduler, page: Visibility = visibility) {
    this.transport = transport
    this.clock = clock
    this.page = page
    this.pricing = new PricingStore(transport, clock, page)
  }
  private entry(sessionId: string): Entry {
    let entry = this.entries.get(sessionId)
    if (!entry) {
      entry = { sessionId, listeners: new Set(), state: { view: null, loading: false, error: null },
        observation: emptyObservation, generation: 0, panels: 0, flight: null, poll: null, queued: false, dirty: false }
      this.entries.set(sessionId, entry)
    }
    return entry
  }
  snapshot(sessionId: string): ViewState { return this.entry(sessionId).state }
  subscribe(sessionId: string, listener: () => void): () => void {
    if (this.disposed || sessionId === '') return () => {}
    const entry = this.entry(sessionId)
    entry.listeners.add(listener)
    if (!this.stopVisibility) this.stopVisibility = this.page.subscribe(() => this.visibilityChanged())
    if (entry.listeners.size === 1 && this.page.visible()) void this.refreshEntry(entry, false)
    return () => {
      entry.listeners.delete(listener)
      if (entry.listeners.size !== 0) return
      this.stopPoll(entry)
      this.abort(entry)
      if (this.entries.get(sessionId) === entry) this.entries.delete(sessionId)
      if (![...this.entries.values()].some(row => row.listeners.size > 0)) {
        this.stopVisibility?.(); this.stopVisibility = null
      }
    }
  }
  observe(sessionId: string, observation: Observation): void {
    if (this.disposed || sessionId === '') return
    const entry = this.entry(sessionId)
    const previous = entry.observation
    entry.observation = observation
    // The first observation only records the baseline the mount refresh already
    // used; invalidating on it would repeat the same request for nothing.
    const view = entry.state.view
    const changed = view !== null && previous.catalogRevision !== '' && (previous.catalogRevision !== observation.catalogRevision
      || (view.scope !== 'self' && (previous.projectionRevision !== observation.projectionRevision
        || previous.catalogProjectionRevision !== observation.catalogProjectionRevision)))
    if (changed) this.invalidate(entry)
    if (previous.running !== observation.running || previous.projectionReady !== observation.projectionReady) this.schedule(entry)
  }
  /** Full detail is acquired only for an actually opened panel. Multiple seats share the flight. */
  open(sessionId: string): () => void {
    if (this.disposed || sessionId === '') return () => {}
    const entry = this.entry(sessionId)
    entry.panels += 1
    if (entry.panels === 1 && this.page.visible()) void this.refreshEntry(entry, false)
    let closed = false
    return () => {
      if (closed) return
      closed = true
      entry.panels = Math.max(0, entry.panels - 1)
      if (entry.panels === 0 && entry.flight?.detail === 'full') {
        this.abort(entry)
        this.publish(entry, { ...entry.state, loading: false })
        if (!entry.state.view && this.active(entry) && this.page.visible()) void this.refreshEntry(entry, false)
        else this.schedule(entry)
      }
    }
  }
  /** Refresh is GET-only; force replaces even a same-session in-flight request. */
  refresh(sessionId: string, force = false): Promise<void> {
    if (this.disposed || sessionId === '') return Promise.resolve()
    return this.refreshEntry(this.entry(sessionId), force)
  }
  private active(entry: Entry): boolean {
    return !this.disposed && this.entries.get(entry.sessionId) === entry && entry.listeners.size > 0
  }
  private publish(entry: Entry, state: ViewState): void { entry.state = state; emit(entry.listeners) }
  private stopPoll(entry: Entry): void { entry.poll?.(); entry.poll = null }
  private abort(entry: Entry): void {
    entry.generation += 1
    entry.flight?.deadline()
    entry.flight?.controller.abort()
    entry.flight = null
    entry.dirty = false
  }
  private needsPolling(entry: Entry): boolean { return entry.state.view?.scope !== 'self' || !entry.observation.projectionReady }
  private schedule(entry: Entry): void {
    this.stopPoll(entry)
    if (!this.active(entry) || !this.page.visible() || entry.flight || !this.needsPolling(entry)) return
    entry.poll = this.clock.later(() => { entry.poll = null; void this.refreshEntry(entry, false) }, entry.observation.running ? 2500 : 15000)
  }
  private invalidate(entry: Entry): void {
    if (!this.active(entry) || !this.page.visible()) return
    if (entry.flight) { entry.dirty = true; return }
    if (entry.queued) return
    entry.queued = true
    queueMicrotask(() => {
      entry.queued = false
      if (this.active(entry) && this.page.visible()) void this.refreshEntry(entry, false)
    })
  }
  private refreshEntry(entry: Entry, force: boolean): Promise<void> {
    if (!this.active(entry) || !this.page.visible()) return Promise.resolve()
    const detail: Detail = entry.panels > 0 ? 'full' : 'summary'
    if (entry.flight && !force && (entry.flight.detail === 'full' || detail === 'summary')) return entry.flight.promise
    this.stopPoll(entry)
    this.abort(entry)
    const generation = entry.generation
    const controller = new AbortController()
    const current = (): boolean => this.active(entry) && entry.generation === generation && !controller.signal.aborted
    this.publish(entry, { ...entry.state, loading: true, error: null })
    const deadline = this.clock.later(() => {
      if (!current()) return
      this.abort(entry)
      this.publish(entry, { ...entry.state, loading: false, error: 'Request timed out' })
      this.schedule(entry)
    }, 8000)
    const promise = this.transport.view(entry.sessionId, 'auto', detail, controller.signal)
      .then(view => { if (current()) this.publish(entry, { view, loading: false, error: null }) })
      .catch((error: unknown) => { if (current()) this.publish(entry, { ...entry.state, loading: false, error: message(error) }) })
      .finally(() => {
        deadline()
        if (!current()) return
        entry.flight = null
        if (entry.dirty) { entry.dirty = false; this.invalidate(entry) }
        else this.schedule(entry)
      })
    entry.flight = { controller, generation, detail, promise, deadline }
    return promise
  }
  private visibilityChanged(): void {
    for (const entry of this.entries.values()) {
      if (!this.page.visible()) {
        this.stopPoll(entry); this.abort(entry)
        if (entry.state.loading) this.publish(entry, { ...entry.state, loading: false })
      } else if (this.active(entry) && (this.needsPolling(entry) || entry.panels > 0 || !entry.state.view)) {
        void this.refreshEntry(entry, false)
      }
    }
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.entries.values()) { this.stopPoll(entry); this.abort(entry); entry.listeners.clear() }
    this.entries.clear()
    this.stopVisibility?.(); this.stopVisibility = null
    this.pricing.dispose()
  }
}

/** Pricing refreshes at its validity boundary, never on a recurring ticker. */
export class PricingStore {
  private state: PricingState = { pricing: null, loading: false, error: null }
  private readonly listeners = new Set<() => void>()
  private controller: AbortController | null = null
  private flight: Promise<void> | null = null
  private generation = 0
  private boundary: (() => void) | null = null
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
  snapshot = (): PricingState => this.state
  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      this.stopVisibility = this.page.subscribe(() => {
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
  private publish(state: PricingState): void { this.state = state; emit(this.listeners) }
  private cancel(): void {
    this.generation += 1
    this.controller?.abort(); this.controller = null; this.flight = null
    this.boundary?.(); this.boundary = null
    this.deadline?.(); this.deadline = null
  }
  private ensure(): void {
    if (this.disposed || this.listeners.size === 0 || !this.page.visible()) return
    if (!this.state.pricing || this.state.pricing.validUntil <= this.clock.now()) void this.refresh()
    else this.schedule()
  }
  private schedule(): void {
    this.boundary?.(); this.boundary = null
    if (this.disposed || this.listeners.size === 0 || !this.page.visible() || !this.state.pricing) return
    // Browsers clamp delays above 2^31-1; a long validity window is re-armed, not fetched early.
    const delay = Math.min(2147483647, Math.max(1, this.state.pricing.validUntil - this.clock.now()))
    this.boundary = this.clock.later(() => { this.boundary = null; this.ensure() }, delay)
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
      this.cancel(); this.publish({ ...this.state, loading: false, error: 'Request timed out' })
    }, 8000)
    const promise = this.transport.pricing(controller.signal)
      .then(pricing => {
        if (!current()) return
        if (pricing.validUntil <= this.clock.now()) throw new Error('Expired pricing view')
        this.publish({ pricing, loading: false, error: null }); this.schedule()
      })
      .catch((error: unknown) => { if (current()) this.publish({ ...this.state, loading: false, error: message(error) }) })
      .finally(() => {
        if (!current()) return
        this.deadline?.(); this.deadline = null; this.flight = null; this.controller = null
      })
    this.flight = promise
    return promise
  }
  dispose(): void { this.disposed = true; this.cancel(); this.listeners.clear(); this.stopVisibility?.(); this.stopVisibility = null }
}
