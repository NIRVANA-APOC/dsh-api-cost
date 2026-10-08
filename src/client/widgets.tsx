import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { SessionListState, SessionSnapshot, UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { MaybeSnapshotSelectorHook, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { Coverage, LedgerView, Money, PricingView, Totals } from '../shared/contracts.ts'
import { countdownString, moneyString } from '../shared/format.ts'
import { validCoverage, validTotals } from './transport.ts'
import type { CostStore, ViewState } from './store.ts'
import type { CostPillProps } from './types.ts'
import type { LocaleKey, Translate } from './locale.ts'

function CostMark() {
  return <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><circle cx={12} cy={12} r={9} /><path d="M8.3 7.3 12 11.9l3.7-4.6M12 11.9V17M9.2 13.3h5.6M9.2 15.3h5.6" /></svg>
}
function RefreshMark() {
  return <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1M20.7 4.2v5.2h-5.2" /></svg>
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
const pairedMoney = (money: Money | undefined): string => money ? moneyString(money.cny) + ' · ' + moneyString(money.usd, 'usd') : '—'

/** This is the only one-second clock. It mounts only inside the open panel. */
function Countdown({ at }: { at: number }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined }
    const tick = () => {
      stop()
      if (document.visibilityState === 'hidden') return
      setNow(Date.now())
      timer = setTimeout(tick, 1000)
    }
    document.addEventListener('visibilitychange', tick)
    tick()
    return () => { stop(); document.removeEventListener('visibilitychange', tick) }
  }, [])
  return <span>{countdownString(at - now)}</span>
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
function Row({ label, children, wrap = false }: { label: string; children: ReactNode; wrap?: boolean }) {
  return <><dt>{label}</dt><dd className={wrap ? 'dac-wrap' : undefined}>{children}</dd></>
}
function CoverageRows({ coverage, t }: { coverage: Coverage | undefined; t: Translate }) {
  if (!coverage) return <Row label={t('detail.coverage')}>{t('cost.unavailable')}</Row>
  const status: LocaleKey = coverage.status === 'complete' ? 'detail.complete' : coverage.status === 'partial' ? 'cost.partial' : 'cost.unavailable'
  return <>
    <Row label={t('detail.coverage')}>{t(status)}</Row>
    {(coverage.failedSessions > 0 || coverage.omittedSessions > 0) && <Row label={t('detail.failed')}>{coverage.failedSessions} / {coverage.omittedSessions}</Row>}
    {/* Session-scope gaps. Rate-card caveats are a separate row: a complete
        session must never read as partial because the card is disputed. */}
    {coverage.issues.length > 0 && <Row label={t('cost.partial')} wrap>{coverage.issues.map(issue => t(`issue.${issue}`)).join(' · ')}</Row>}
  </>
}
function PricingRows({ pricing, t }: { pricing: PricingView | null; t: Translate }) {
  if (!pricing) return <Row label={t('detail.period')}>{t('cost.unavailable')}</Row>
  return <>
    <Row label={t('detail.period')}>{t(pricing.peak ? 'tier.peak' : 'tier.offPeak')}</Row>
    {pricing.next && <Row label={t(pricing.next.peak ? 'tier.nextPeak' : 'tier.nextOffPeak')}><Countdown at={pricing.next.at} /></Row>}
    <Row label={t('detail.rates')} wrap><div className="dac-roster">{Object.entries(pricing.rateCard).map(([model, value]) => {
      const rates = (pricing.peak ? value.peak : value.offPeak).cny
      return <span key={model}>{value.label}: {rates.cacheHit} / {rates.cacheMiss} / {rates.output}</span>
    })}<span className="dac-actionNote">{t('detail.rateUnit')}</span></div></Row>
    {/* A card-level caveat, deliberately NOT the coverage label: this rests on
        the published rate card, not on this session's numbers. */}
    {pricing.issues.length > 0 && <Row label={t('detail.cardNotes')} wrap>{pricing.issues.map(issue => t(`issue.${issue}`)).join(' · ')}</Row>}
  </>
}
interface PanelProps extends CostPillProps {
  readonly store: CostStore
  readonly sessionId: string
  readonly state: ViewState
  readonly pricing: PricingView | null
  readonly t: Translate
  readonly anchor: RefObject<HTMLSpanElement>
  readonly close: () => void
  readonly id: string
}
function CostPanel(props: PanelProps) {
  const { store, sessionId, state, pricing, t, anchor, close, id } = props
  const useProjection = props.useProjection ?? NO_PROJECTION
  const { panel, position } = usePanel(anchor, close)
  const projectedOwn = useProjection('apiCost', ownTotals)
  const projectedCoverage = useProjection('apiCost', ownCoverage)
  useEffect(() => store.open(sessionId), [store, sessionId])
  const view = state.view
  const nativeOwn = projectedCoverage?.status !== 'unavailable' ? projectedOwn : undefined
  const own = nativeOwn ?? (view?.coverage.status !== 'unavailable' ? view?.own : undefined)
  const total = view?.scope === 'self' && nativeOwn ? nativeOwn : view?.coverage.status !== 'unavailable' ? view?.total : undefined
  const others = view?.coverage.status !== 'unavailable' ? view?.others : undefined
  const coverage = view?.scope === 'self' && projectedCoverage ? projectedCoverage : view?.coverage
  return createPortal(<div ref={panel} id={id} role="dialog" aria-label={t('cost.title')} tabIndex={-1} className="dac-panel dac-panel--floating" style={position}>
    <div className="dac-title"><span className="dac-titleLabel"><CostMark />{t('cost.title')}</span><span className="dac-titleValue">{pairedMoney(total?.money)}</span></div>
    <div className="dac-rule" aria-hidden="true" />
    <dl className="dac-details">
      <Row label={t('detail.total')}>{pairedMoney(total?.money)}</Row>
      <Row label={t('detail.own')}>{pairedMoney(own?.money)}</Row>
      <Row label={t('detail.others')}>{pairedMoney(others?.money)}</Row>
      <CoverageRows coverage={coverage} t={t} />
      <Row label={t('detail.sessions')}>{view ? String(view.sessionCount) : '—'}</Row>
      <Row label={t('detail.calls')}>{total ? String(total.calls) : '—'}</Row>
      <Row label={t('detail.peak')}>{pairedMoney(total?.periods.peak)}</Row>
      <Row label={t('detail.offPeak')}>{pairedMoney(total?.periods.offPeak)}</Row>
      {view?.scope === 'team' && <Row label={t('detail.team')} wrap>{view.members?.length ? <div className="dac-roster">{view.members.map(member => <span key={member.sessionId}>{member.role === 'lead' ? '★ ' : ''}{member.name}: {coverage?.status === 'unavailable' ? '—' : pairedMoney(member.money)}</span>)}</div> : state.loading ? t('cost.loading') : t('cost.unavailable')}</Row>}
      <PricingRows pricing={pricing} t={t} />
    </dl>
    <div className="dac-footer"><button type="button" className={'dac-action' + (state.loading ? ' dac-action--busy' : '')} disabled={state.loading} title={t('action.refreshHint')} onClick={() => { void store.refresh(sessionId, true) }}><RefreshMark />{t(state.loading ? 'action.refreshing' : 'action.refresh')}</button>{state.error && <span className="dac-actionNote dac-actionNote--error" role="alert">{state.error}</span>}</div>
  </div>, document.body)
}

/** Factory captures the single scope-query bridge, not a framework or runtime DSH module. */
export function createCostPill(store: CostStore, t: Translate) {
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
    const tier = price.pricing ? t(price.pricing.peak ? 'tier.peakShort' : 'tier.offPeakShort') : ''
    const partial = status === 'partial' ? t('cost.partial') : ''
    const label = [costLabel, tier, partial].filter(Boolean).join(' · ')
    return <span className="dac-root"><span ref={anchor} className="dac-anchor"><button type="button" className={'dac-pill' + (price.pricing?.peak ? ' dac-pill--peak' : '')} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} aria-label={label} title={state.error ?? price.error ?? undefined} onClick={() => setOpenedSession(open ? null : sessionId)}><CostMark /><span className="dac-label">{[costLabel, tier, partial].filter(Boolean).map((part, index) => <Fragment key={index}>{index > 0 && <span className="dac-sep" aria-hidden="true">·</span>}{part}</Fragment>)}</span></button></span>{open && <CostPanel key={sessionId} {...props} store={store} sessionId={sessionId} state={state} pricing={price.pricing} t={t} anchor={anchor} close={close} id={id} />}</span>
  }
}
