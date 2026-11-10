import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { SessionListState, SessionSnapshot, UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { MaybeSnapshotSelectorHook, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { Coverage, GateView, LedgerView, MemberView, Money, PricingView, Totals } from '../shared/contracts.ts'
import { countdownString, moneyString } from '../shared/format.ts'
import { validCoverage, validTotals } from './transport.ts'
import { cardNotes } from './cardNotes.ts'
import type { CostStore, ViewState } from './store.ts'
import type { GateStore, GateStoreState } from './gate.ts'
import type { CostPillProps } from './types.ts'
import type { Translate } from './locale.ts'

function CostMark() {
  return <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><circle cx={12} cy={12} r={9} /><path d="M8.3 7.3 12 11.9l3.7-4.6M12 11.9V17M9.2 13.3h5.6M9.2 15.3h5.6" /></svg>
}
const identity = (snapshot: SessionSnapshot | undefined): string => snapshot?.sessionId ?? ''
const running = (snapshot: SessionSnapshot | undefined): boolean => snapshot?.running ?? false
/**
 * A composition without the session or projection standard seats still renders:
 * these fallbacks report absence, and the pill answers from the HTTP view
 * instead of crashing the whole dock entry.
 */
const EMPTY_CATALOG = { ids: [], byId: {} } as unknown as SessionListState
const NO_SESSION = ((selector: (value: SessionSnapshot | undefined) => unknown) => selector(undefined)) as unknown as MaybeSnapshotSelectorHook<SessionSnapshot>
const NO_SESSIONS = ((selector: (value: SessionListState) => unknown) => selector(EMPTY_CATALOG)) as unknown as SnapshotSelectorHook<SessionListState>
const NO_PROJECTION = ((_key: string, selector: (value: unknown) => unknown) => selector(undefined)) as unknown as UseProjection
const ownTotals = (ledger: LedgerView | undefined): Totals | undefined => ledger && validTotals(ledger.totals) ? ledger.totals : undefined
const ownCoverage = (ledger: LedgerView | undefined): Coverage | undefined => ledger && validCoverage(ledger.coverage) ? ledger.coverage : undefined
const ownCny = (ledger: LedgerView | undefined): string | undefined => {
  const coverage = ownCoverage(ledger)
  return coverage && coverage.status !== 'unavailable' ? ownTotals(ledger)?.money.cny : undefined
}
const ledgerRevision = (ledger: LedgerView | undefined): string => ledger?.revision ?? ''
const coverageStatus = (ledger: LedgerView | undefined): Coverage['status'] | undefined => ownCoverage(ledger)?.status
const topology = (list: SessionListState): string => JSON.stringify(list.ids.map(id => [id, list.byId[id]?.parentId ?? '']))
const catalogProjections = (list: SessionListState): string => JSON.stringify(list.ids.map(id => [id, list.byId[id]?.projectionValues?.apiCost?.revision ?? '']))
const catalogRunning = (list: SessionListState): boolean => list.ids.some(id => list.byId[id]?.running === true)
/** The hero splits the currency mark from the digits so only the mark is raised. */
const heroParts = (value: string | undefined): [string, string] => {
  const text = moneyString(value)
  if (text.startsWith('<¥')) return ['<¥', text.slice(2)]
  if (text.startsWith('¥')) return ['¥', text.slice(1)]
  return ['', text]
}
/** A hold can span hours, so the elapsed value is spelled in the reader's units. */
const holdDuration = (milliseconds: number, t: Translate): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return t('gate.duration.dh', { days, hours })
  if (hours > 0) return t('gate.duration.hm', { hours, minutes: String(minutes).padStart(2, '0') })
  return t('gate.duration.ms', { minutes, seconds: String(seconds % 60).padStart(2, '0') })
}

/**
 * The panel's single one-second clock. Every countdown and elapsed value on the
 * panel reads this one `now`, so two numbers on screen never disagree, and a
 * hidden document stops ticking until it is visible again.
 */
function useNow(): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const stop = () => { if (timer !== undefined) { clearInterval(timer); timer = undefined } }
    const tick = () => { if (document.visibilityState !== 'hidden') setNow(Date.now()) }
    const start = () => { stop(); tick(); timer = setInterval(tick, 1000) }
    const visibility = () => { if (document.visibilityState === 'hidden') stop(); else start() }
    start()
    document.addEventListener('visibilitychange', visibility)
    return () => { stop(); document.removeEventListener('visibilitychange', visibility) }
  }, [])
  return now
}

/** Open-panel-only positioning, dismissal, observation, and focus restoration. */
function usePanel(anchor: RefObject<HTMLSpanElement>, close: () => void) {
  const panel = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden', left: 0, top: 0 })
  useLayoutEffect(() => {
    const trigger = anchor.current?.querySelector('button')
    const element = panel.current
    if (!element) return
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect()
      if (!rect) return
      const raw = getComputedStyle(document.documentElement).getPropertyValue('--dsh-frame-top-clearance')
      const parsed = Number.parseFloat(raw)
      const topMargin = Math.max(12, (Number.isFinite(parsed) ? parsed : 0) + 20)
      const leftLimit = Math.max(12, window.innerWidth - element.offsetWidth - 12)
      const topLimit = Math.max(topMargin, window.innerHeight - element.offsetHeight - 12)
      setPosition({ left: Math.min(Math.max(rect.left, 12), leftLimit),
        top: Math.min(Math.max(rect.top - 8 - element.offsetHeight, topMargin), topLimit) })
    }
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return
      if (!anchor.current?.contains(event.target) && !element.contains(event.target)) close()
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close() } }
    place()
    element.focus({ preventScroll: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    observer?.observe(element)
    if (anchor.current) observer?.observe(anchor.current)
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
      if (trigger?.isConnected && (document.activeElement === document.body || element.contains(document.activeElement))) trigger.focus({ preventScroll: true })
    }
  }, [anchor, close])
  return { panel, position }
}

/** Header cluster: current tariff word, its colour tick, and the time to the next change. */
function TierLine({ pricing, now, t }: { pricing: PricingView | null; now: number; t: Translate }) {
  if (!pricing) return null
  const next = pricing.next
  return <span className="dac-tier">
    <span className={'dac-tick' + (pricing.peak ? '' : ' dac-tick--off')} aria-hidden="true" />
    <span className={'dac-tierWord ' + (pricing.peak ? 'dac-peak' : 'dac-off')}>{t(pricing.peak ? 'tier.peakShort' : 'tier.offPeakShort')}</span>
    {next !== null && <span className="dac-tierWait">{t(pricing.peak ? 'tier.nextOffPeak' : 'tier.nextPeak', { time: countdownString(next.at - now) })}</span>}
  </span>
}
/**
 * The panel's one bold element: this scope's money split across the two tariff
 * windows. Widths are proportional; a window with no spend collapses to a
 * hairline, and the words 峰/谷 below carry the same reading without colour.
 */
function TariffBand({ peak, offPeak, t }: { peak: Money | undefined; offPeak: Money | undefined; t: Translate }) {
  const peakAmount = peak ? Number(peak.cny) : 0
  const offAmount = offPeak ? Number(offPeak.cny) : 0
  const grow = (amount: number): CSSProperties => amount > 0 ? { flexGrow: amount, flexBasis: 0 } : { flex: '0 0 2px' }
  return <>
    <div className="dac-band" aria-hidden="true">
      <span className="dac-bandPeak" style={grow(peakAmount)} />
      <span className="dac-bandOff" style={grow(offAmount)} />
    </div>
    <div className="dac-legend">
      <span className="dac-legendGroup">
        <span className="dac-tick" aria-hidden="true" />
        <span className="dac-legendWord dac-peak">{t('tier.peakShort')}</span>
        <span className="dac-legendMoney">{moneyString(peak?.cny)}</span>
      </span>
      <span className="dac-legendGroup">
        <span className="dac-tick dac-tick--off" aria-hidden="true" />
        <span className="dac-legendWord dac-off">{t('tier.offPeakShort')}</span>
        <span className="dac-legendMoney">{moneyString(offPeak?.cny)}</span>
      </span>
    </div>
  </>
}
/** Who spent what inside this scope, as two quiet columns. */
function Split({ own, others, t }: { own: Money | undefined; others: Money | undefined; t: Translate }) {
  return <div className="dac-split">
    <div><span className="dac-splitLabel">{t('detail.own')}</span><span className="dac-splitMoney">{moneyString(own?.cny)}</span></div>
    <div><span className="dac-splitLabel">{t('detail.others')}</span><span className="dac-splitMoney">{moneyString(others?.cny)}</span></div>
  </div>
}
/** Coverage: the status word itself lives in the meta line; this row explains it. */
function CoverageNote({ coverage, t }: { coverage: Coverage | undefined; t: Translate }) {
  const parts: string[] = []
  if (coverage) {
    for (const issue of coverage.issues) parts.push(t(`issue.${issue}`))
    if (coverage.failedSessions > 0 || coverage.omittedSessions > 0) parts.push(t('detail.failed') + ' ' + coverage.failedSessions + ' / ' + coverage.omittedSessions)
  }
  const status = coverage?.status
  // The status word itself is never dropped: it is the reading, and the caveat
  // below it only explains it. A partial scope gets weight, not just a tint.
  const word = t(status === 'complete' ? 'detail.complete' : status === 'partial' ? 'cost.partial' : 'cost.unavailable')
  return <div className="dac-note"><span className="dac-noteLabel">{t('detail.coverage')}</span>
    <span className={'dac-covWord' + (status === 'partial' ? ' dac-covWord--warn' : status === 'unavailable' || status === undefined ? ' dac-covWord--bad' : '')}>{word}</span>
    {parts.length > 0 && <span className="dac-covWhy">{parts.join(t('list.separator'))}</span>}
  </div>
}
/** The rate card in force right now, in this scope's own settlement currency. */
function Rates({ pricing, models, t }: { pricing: PricingView | null; models: readonly string[] | undefined; t: Translate }) {
  if (!pricing) return <div className="dac-note"><span className="dac-noteLabel">{t('detail.rates')}</span><span className="dac-noteValue">{t('cost.unavailable')}</span></div>
  const notes = cardNotes(pricing.issues, models)
  return <div className="dac-rates">
    <div className="dac-noteLabel">{t('detail.rates')}</div>
    {Object.entries(pricing.rateCard).map(([model, value]) => {
      const rates = (pricing.peak ? value.peak : value.offPeak).cny
      return <div className="dac-rateRow" key={model}><span>{value.label}</span><span>{rates.cacheHit} / {rates.cacheMiss} / {rates.output}</span></div>
    })}
    <div className="dac-unit">{t('detail.rateUnit')}</div>
    {/* A card-level caveat, deliberately not the coverage label, shown only when
        it can move this scope's numbers (see cardNotes). */}
    {notes.length > 0 && <div className="dac-note"><span className="dac-noteLabel">{t('detail.cardNotes')}</span><span className="dac-noteValue">{notes.map(issue => t(`issue.${issue}`)).join(t('list.separator'))}</span></div>}
  </div>
}
/** Team scope: one money figure per member, the Lead marked. */
function Roster({ members, loading, t }: { members: readonly MemberView[] | undefined; loading: boolean; t: Translate }) {
  return <div className="dac-roster">
    <span className="dac-rosterLabel">{t('detail.team')}</span>
    {members?.length ? members.map(member => <div className="dac-member" key={member.sessionId}>
      <span className="dac-memberName">{member.role === 'lead' ? '★ ' : ''}{member.name}</span>
      <span className="dac-memberMoney">{moneyString(member.money.cny)}</span>
    </div>) : <span className="dac-rosterEmpty">{loading ? t('cost.loading') : t('cost.unavailable')}</span>}
  </div>
}
/**
 * The off-peak gate control: one switch for this session and its delegation
 * subtree, and — while requests are parked — the only place a human can learn
 * why the session looks idle but is still alive.
 *
 * The switch always shows the last host-confirmed *effective* position: a
 * session that follows a parent's switch shows the parent's position, a quiet
 * 继承/Inherited badge, and a line saying what flipping it here would do. The
 * same applies to `default`: the position is the configured one, not a choice
 * this session made. Nothing here is inferred: `aria-checked` never flips
 * before the host answers, and a failure keeps the previous value and adds an
 * alert below it.
 */
function GateBlock({ gateStore, sessionId, state, now, t, id }: { gateStore: GateStore; sessionId: string; state: GateStoreState; now: number; t: Translate; id: string }) {
  const view = state.gate
  const enabled = view?.enabled === true
  const source = view?.source
  const word = view === null ? (state.error ? t('gate.failed') : t('cost.loading')) : t(enabled ? 'gate.on' : 'gate.off')
  // `source` decides the badge, not `changedAt`: an inherited position has no
  // change instant of its own, and calling it 默认/default would misdescribe it.
  const badge = source === 'inherited' ? t('gate.inherited') : source === 'default' ? t('gate.default') : ''
  const scopeId = id + '-scope'
  const releaseAt = view?.releaseAt ?? view?.next?.at ?? null
  // `holding` counts this whole subtree; show only the part the reader cannot
  // see from here (the child sessions') as a quiet note beside the total.
  const childHolding = view !== null && view.holding > view.ownHolding ? view.holding - view.ownHolding : 0
  let status: ReactNode
  if (view === null) status = <div className="dac-gateHint">{state.loading ? t('cost.loading') : t('gate.failed')}</div>
  else if (enabled && view.state === 'holding') status = <>
    <div className="dac-statusRow">
      <span className="dac-statusStrong">{view.holding > 0 ? t('gate.holding', { count: view.holding }) : t('gate.holdingEmpty')}</span>
      {releaseAt !== null && <span className="dac-statusQuiet">{t('gate.release', { time: countdownString(releaseAt - now) })}</span>}
    </div>
    {(view.since !== null || childHolding > 0 || view.otherHolding > 0) && <div className="dac-gateMeta">
      {view.since !== null && <span className="dac-statusQuiet">{t('gate.since') + ' ' + holdDuration(now - view.since, t)}</span>}
      {childHolding > 0 && <span className="dac-statusQuiet">{t('gate.childHolding', { count: childHolding })}</span>}
      {view.otherHolding > 0 && <span className="dac-statusQuiet">{t('gate.otherHolding', { count: view.otherHolding })}</span>}
    </div>}
  </>
  else if (enabled) status = <>
    <div className="dac-gateHint">{t('gate.passThrough')}</div>
    {view.otherHolding > 0 && <div className="dac-statusRow"><span className="dac-statusQuiet">{t('gate.otherHolding', { count: view.otherHolding })}</span></div>}
  </>
  else status = <>
    <div className="dac-gateHint">{t('gate.hint')}</div>
    {view.otherHolding > 0 && <div className="dac-statusRow"><span className="dac-statusQuiet">{t('gate.otherHolding', { count: view.otherHolding })}</span></div>}
  </>
  return <div className={'dac-gate' + (view?.state === 'holding' ? ' dac-gate--hold' : '')}>
    <div className="dac-gateHead">
      <span className="dac-gateTitle">{t('gate.title')}</span>
      <span className="dac-gateControl">
        {/* The state word is part of the accessible name on purpose: `aria-checked`
            can only be true/false, so before the first answer it would announce a
            confident "off" for a state the host has not confirmed yet. The source
            badge rides along because it qualifies what flipping the switch does. */}
        <button type="button" role="switch" aria-checked={enabled} aria-label={t('gate.title') + ' ' + word + (badge === '' ? '' : ' ' + badge)}
          aria-describedby={scopeId} className={'dac-switch' + (enabled ? ' dac-switch--on' : '')} title={t('gate.hint')}
          disabled={state.saving || view === null} onClick={() => { void gateStore.setEnabled(sessionId, !enabled) }}>
          <span className="dac-switchTrack" aria-hidden="true"><span className="dac-switchKnob" /></span>
          <span className="dac-switchWord">{word}</span>
          {badge !== '' && <span className="dac-switchBadge">{badge}</span>}
        </button>
        {state.saving && <span className="dac-gateNote">{t('gate.saving')}</span>}
      </span>
    </div>
    <div id={scopeId}>
      <div className="dac-gateScope">{t('gate.scope')}</div>
      {source === 'inherited' && <div className="dac-gateFollow">{t('gate.following')}</div>}
    </div>
    <div className="dac-gateStatus">{status}</div>
    {state.error && <div className="dac-gateError" role="alert">{state.error}</div>}
  </div>
}
interface PanelProps extends CostPillProps {
  readonly store: CostStore
  readonly gateStore: GateStore
  readonly gate: GateStoreState
  readonly sessionId: string
  readonly state: ViewState
  readonly pricing: PricingView | null
  readonly t: Translate
  readonly anchor: RefObject<HTMLSpanElement>
  readonly close: () => void
  readonly id: string
}
function CostPanel(props: PanelProps) {
  const { store, gateStore, gate, sessionId, state, pricing, t, anchor, close, id } = props
  const useProjection = props.useProjection ?? NO_PROJECTION
  const { panel, position } = usePanel(anchor, close)
  const now = useNow()
  const projectedOwn = useProjection('apiCost', ownTotals)
  const projectedCoverage = useProjection('apiCost', ownCoverage)
  useEffect(() => store.open(sessionId), [store, sessionId])
  const view = state.view
  // The native seat wins whenever it has a complete answer; the HTTP view is the
  // fallback, never a second source shown beside it.
  const nativeOwn = projectedCoverage?.status !== 'unavailable' ? projectedOwn : undefined
  const own = nativeOwn ?? (view?.coverage.status !== 'unavailable' ? view?.own : undefined)
  const total = view?.scope === 'self' && nativeOwn ? nativeOwn : view?.coverage.status !== 'unavailable' ? view?.total : undefined
  const others = view?.coverage.status !== 'unavailable' ? view?.others : undefined
  const coverage = view?.scope === 'self' && projectedCoverage ? projectedCoverage : view?.coverage
  const [symbol, amount] = heroParts(total?.money.cny)
  const meta: string[] = []
  if (view !== null) meta.push(t('detail.sessions', { count: view.sessionCount }))
  if (total !== undefined) meta.push(t('detail.calls', { count: total.calls }))
  return createPortal(<div ref={panel} id={id} role="dialog" aria-label={t('cost.title')} tabIndex={-1} className="dac-panel dac-panel--floating" style={position}>
    <div className="dac-head">
      <span className="dac-headTitle">{t('cost.title')}</span>
      <TierLine pricing={pricing} now={now} t={t} />
    </div>
    <div className="dac-hero">
      <span className="dac-heroCny">{symbol !== '' && <span className="dac-heroSymbol">{symbol}</span>}{amount}</span>
      <span className="dac-heroUsd">{moneyString(total?.money.usd, 'usd')}</span>
    </div>
    {meta.length > 0 && <div className="dac-meta">{meta.join(t('list.separator'))}</div>}
    <TariffBand peak={total?.periods.peak} offPeak={total?.periods.offPeak} t={t} />
    <div className="dac-rule" aria-hidden="true" />
    <Split own={own?.money} others={others?.money} t={t} />
    <CoverageNote coverage={coverage} t={t} />
    <Rates pricing={pricing} models={view?.byModel?.map(model => model.model)} t={t} />
    {view?.scope === 'team' && <Roster members={view.members} loading={state.loading} t={t} />}
    <div className="dac-rule" aria-hidden="true" />
    <GateBlock gateStore={gateStore} sessionId={sessionId} state={gate} now={now} t={t} id={id} />
    <div className="dac-footer">
      {state.error ? <span className="dac-footerError" role="alert">{state.error}</span> : <span />}
      <button type="button" className={'dac-action' + (state.loading ? ' dac-action--busy' : '')} disabled={state.loading} onClick={() => { void store.refresh(sessionId, true) }}>{t(state.loading ? 'action.refreshing' : 'action.refresh')}</button>
    </div>
  </div>, document.body)
}

/** Factory captures the single scope-query bridge, not a framework or runtime DSH module. */
export function createCostPill(store: CostStore, gateStore: GateStore, t: Translate) {
  return function CostPill(props: CostPillProps) {
    const useSession = props.useSession ?? NO_SESSION
    const useSessions = props.useSessions ?? NO_SESSIONS
    const useProjection = props.useProjection ?? NO_PROJECTION
    const sessionId = useSession(identity) ?? ''
    const ownAmount = useProjection('apiCost', ownCny)
    const ownStatus = useProjection('apiCost', coverageStatus)
    const revision = useProjection('apiCost', ledgerRevision)
    const ownRunning = useSession(running)
    const catalogRevision = useSessions(topology)
    const catalogProjectionRevision = useSessions(catalogProjections)
    const otherRunning = useSessions(catalogRunning)
    const subscribe = useCallback((listener: () => void) => store.subscribe(sessionId, listener), [store, sessionId])
    const snapshot = useCallback(() => store.snapshot(sessionId), [store, sessionId])
    const state = useSyncExternalStore(subscribe, snapshot, snapshot)
    const price = useSyncExternalStore(store.pricing.subscribe, store.pricing.snapshot, store.pricing.snapshot)
    const subscribeGate = useCallback((listener: () => void) => gateStore.subscribe(sessionId, listener), [gateStore, sessionId])
    const snapshotGate = useCallback(() => gateStore.snapshot(sessionId), [gateStore, sessionId])
    const gate = useSyncExternalStore(subscribeGate, snapshotGate, snapshotGate)
    const anchor = useRef<HTMLSpanElement>(null)
    const [openedSession, setOpenedSession] = useState<string | null>(null)
    const close = useCallback(() => setOpenedSession(null), [])
    const id = useId()
    const open = sessionId !== '' && openedSession === sessionId
    useEffect(() => {
      store.observe(sessionId, { running: ownRunning || (state.view?.scope !== 'self' && otherRunning),
        projectionReady: ownAmount !== undefined, projectionRevision: revision, catalogRevision, catalogProjectionRevision })
    }, [store, sessionId, ownRunning, otherRunning, ownAmount, revision, catalogRevision, catalogProjectionRevision, state.view?.scope])
    const scope = state.view?.scope
    const status = scope === 'self' && ownStatus ? ownStatus : state.view?.coverage.status
    const amount = scope === 'self' && ownAmount !== undefined ? ownAmount : status !== 'unavailable' ? state.view?.total.money.cny : undefined
    const costLabel = amount !== undefined ? moneyString(amount) : t(state.loading && !state.view ? 'cost.loading' : 'cost.unavailable')
    const peak = price.pricing?.peak
    const tier = price.pricing ? t(peak ? 'tier.peakShort' : 'tier.offPeakShort') : ''
    const holding = gate.gate?.state === 'holding' ? gate.gate.holding : 0
    const hold = gate.gate?.state === 'holding' ? t('gate.pillHolding') : ''
    const partial = status === 'partial' ? t('cost.partial') : ''
    // The parked count stays off the capsule (it does not read cleanly beside the
    // words) but stays in the accessible name; the panel carries the number.
    const label = [costLabel, tier, hold + (holding > 0 ? ' ' + holding : ''), partial].filter(Boolean).join(' ')
    return <span ref={anchor} className="dac-root">
      <button type="button" className="dac-pill" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} aria-label={label} title={state.error ?? price.error ?? undefined} onClick={() => setOpenedSession(open ? null : sessionId)}>
        <CostMark />
        <span className="dac-pillAmount">{costLabel}</span>
        {tier !== '' && <>
          <span className="dac-pillDivider" aria-hidden="true" />
          <span className={'dac-pillTier ' + (peak ? 'dac-peak' : 'dac-off')}>{tier}</span>
        </>}
        {hold !== '' && <span className="dac-pillHold">{hold}{holding > 0 ? '×' + holding : ''}</span>}
        {partial !== '' && <span className="dac-pillPartial">{partial}</span>}
      </button>{open && <CostPanel key={sessionId} {...props} store={store} gateStore={gateStore} gate={gate} sessionId={sessionId} state={state} pricing={price.pricing} t={t} anchor={anchor} close={close} id={id} />}</span>
  }
}
