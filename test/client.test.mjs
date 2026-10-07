/**
 * dsh-api-cost — Client bundle smoke test.
 *
 * Loads `client.js` the way the browser module system does — through a fake
 * `window.__ModuleLoader__` — and then drives the registered plugin far enough
 * to prove four things a syntax check cannot: the bundle actually registers
 * under the package name, the factory returns the loader's `{ inject, apply }`
 * face, `apply` mounts a dock entry, and the component renders a real tier line
 * from a fetched snapshot rather than throwing on its first paint.
 *
 * A minimal React stand-in is used (no rendering library): the component is
 * pure `React.createElement` calls, so the tree it returns is inspectable as
 * plain objects. Hooks are executed with a tiny runtime that records effects so
 * the test can flush them.
 *
 * Run: <node> --test test/client.test.mjs   (from the package directory)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(here, '..', 'client.js')
/**
 * The bundle registers under the manifest name, so read the manifest instead of
 * repeating the literal: a rename that misses `client.js` fails the whole combo
 * script at boot, and this constant used to hide exactly that.
 */
const PACKAGE_NAME = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).name

/* ------------------------------------------------------------------ *
 * React stand-in
 * ------------------------------------------------------------------ */

/**
 * Create the minimal React surface the bundle uses: element creation, the three
 * hooks it calls, and `memo`.
 * @returns {object} `{ React, flushEffects, reset }`.
 */
function fakeReact() {
  /** Effects queued by the render in progress. */
  let pending = []
  const state = new Map()
  let cursor = 0

  /** A real-enough element, shared by createElement's ref bookkeeping and the DOM stub. */
  const makeElement = () => ({
    dataset: {},
    textContent: '',
    parentNode: null,
    children: [],
    style: {},
    className: '',
    offsetWidth: 320,
    offsetHeight: 180,
    contains(target) { return target === this || this.children.includes(target) },
    appendChild(node) { node.parentNode = this; this.children.push(node); return node },
    getBoundingClientRect() { return { left: 40, right: 120, top: 600, bottom: 620, width: 80, height: 20 } },
    addEventListener() {},
    removeEventListener() {},
  })

  /** The last panel node React attached, so tests can drive a ResizeObserver. */
  let panelNode = null

  const React = {
    createElement(type, props, ...children) {
      // React writes `ref.current` on commit. The harness has no commit phase,
      // so it assigns here: without a node, placement and size observation are
      // skipped entirely and the tests would silently assert nothing.
      const ref = props === undefined || props === null ? undefined : props.ref
      if (ref !== undefined && ref !== null && typeof ref === 'object') {
        if (type === 'div' && typeof (props.className ?? '') === 'string' && props.className.includes('dac-panel')) {
          panelNode = makeElement()
        }
        if (ref.current === null || ref.current === undefined) ref.current = panelNode
      }
      return { type, props: props ?? {}, children: children.flat().filter((c) => c !== null && c !== undefined && c !== false) }
    },
    memo(component) { return component },
    useState(initial) {
      const slot = cursor++
      if (!state.has(slot)) state.set(slot, typeof initial === 'function' ? initial() : initial)
      const set = (next) => state.set(slot, typeof next === 'function' ? next(state.get(slot)) : next)
      return [state.get(slot), set]
    },
    useReducer(reducer, initial) {
      const slot = cursor++
      if (!state.has(slot)) state.set(slot, initial)
      const dispatch = (action) => state.set(slot, reducer(state.get(slot), action))
      return [state.get(slot), dispatch]
    },
    useEffect(effect, deps) {
      const slot = cursor++
      const previous = state.get(slot)
      const changed = previous === undefined || deps === undefined
        || deps.length !== previous.deps.length || deps.some((d, i) => !Object.is(d, previous.deps[i]))
      if (changed) {
        if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup()
        state.set(slot, { deps, cleanup: undefined })
        // Queue into this render's pending list, which render() hands to flush().
        pending.push(() => {
          const entry = state.get(slot)
          const cleanup = effect()
          state.set(slot, { deps: entry.deps, cleanup })
        })
      }
    },
    useMemo(factory, deps) { return factory() },
    useRef(initial) { return { current: initial } },
    // The placement hook runs in a layout effect; running it as an ordinary
    // effect is enough for a test that only asserts on the tree.
    useLayoutEffect(effect, deps) { React.useEffect(effect, deps) },
  }

  return {
    React,
    /**
     * Render one component instance. Hook slots are positional and survive
     * across renders (one instance), while the cursor rewinds each pass — the
     * two properties a hook-order bug shows up in.
     * @param {Function} component - the slot component.
     * @param {object} props - props for this pass.
     * @returns {object} the rendered tree.
     */
    render(component, props) {
      cursor = 0
      pending = []
      return component(props)
    },
    /** Run the effects queued by the last render, as React would after paint. */
    flushEffects() {
      const queued = pending
      pending = []
      for (const run of queued) run()
    },
    /** Hook slot inspection, for diagnosing positional-hook mistakes in tests. */
    dumpSlots() { return state.size },
    /** The element factory, so the DOM stub and ref bookkeeping share one shape. */
    makeElement,
    reset() { pending = []; state.clear(); cursor = 0 },
  }
}

/* ------------------------------------------------------------------ *
 * Browser stand-in
 * ------------------------------------------------------------------ */

/**
 * Install a fake `window`/`document` + module loader, load the bundle, and hand
 * back everything a test needs to drive it.
 * @returns {{registration: object, fetchCalls: string[], timers: object[]}}
 */
function loadBundle() {
  const runtime = fakeReact()
  const headChildren = []
  /** @type {string[]} */
  const fetchCalls = []
  /** @type {object[]} */
  const timers = []
  /** @type {object[]} */
  const registrations = []

  globalThis.window = {
    __ModuleLoader__: { load: (registration) => registrations.push(registration) },
    localStorage: { getItem: () => null, setItem: () => {} },
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: () => ({ getPropertyValue: () => '48px' }),
  }
  const body = {}
  globalThis.document = {
    head: { appendChild: (node) => headChildren.push(node) },
    body,
    documentElement: {},
    createElement: () => runtime.makeElement(),
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  // The panel's content is live, so the placement hook must observe its size.
  const observers = []
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.observed = []; observers.push(this) }
    observe(node) { this.observed.push(node) }
    disconnect() { this.disconnected = true }
  }
  globalThis.fetch = (url) => {
    fetchCalls.push(String(url))
    return Promise.resolve({
      ok: true,
      json: async () => SNAPSHOT,
    })
  }
  // A controller without a signal keeps the bundle from arming its abort timer,
  // so the test can use the real timers it needs to settle promises.
  globalThis.AbortController = class { constructor() { this.signal = undefined } abort() {} }

  const source = readFileSync(BUNDLE, 'utf8')
  // The bundle is a classic script that registers itself on the global loader.
  new Function(source)()

  assert.equal(registrations.length, 1, 'the bundle must register exactly one module')
  return {
    registration: registrations[0],
    runtime,
    // The factory must receive the SAME React the harness renders with,
    // otherwise the hooks the component calls land in a different runtime than
    // the one the test flushes.
    React: runtime.React,
    headChildren,
    fetchCalls,
    timers,
    body,
    /** ResizeObserver instances the widget created, for placement assertions. */
    observers,
    /** The module table the bundle sees: react plus a minimal react-dom portal. */
    require: (specifier) => {
      if (specifier === 'react') return runtime.React
      if (specifier === 'react-dom') return { createPortal: (node) => node }
      // The shipped primitives are optional in the bundle; omitting them here
      // exercises the local fallback placement + dismissal path.
      throw new Error('not in this composition: ' + specifier)
    },
  }
}

/** A snapshot shaped exactly like the Host half's `/dsh-api-cost/api` payload. */
const SNAPSHOT = {
  ok: true,
  pricing: {
    now: Date.parse('2026-09-30T10:00:00+08:00'),
    peak: true,
    reason: 'peak-window',
    local: { date: '2026-09-30', weekday: 3, minutes: 600 },
    holidayDataMissing: false,
    beforePeakPolicy: false,
    beforeCurrentCard: false,
    next: { at: Date.parse('2026-09-30T12:00:00+08:00'), peak: false, label: 'off-peak' },
    effectiveFrom: '2026-09-10T12:00:00+08:00',
    peakPolicyFrom: '2026-08-17T00:00:00+08:00',
    source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
    retrievedAt: '2026-09-30',
    model: { key: 'deepseek-flash', label: 'DeepSeek Flash', guessed: false, known: true },
    routingDisputed: false,
    rates: {
      peak: { cacheHitCny: 0.04, cacheMissCny: 2, outputCny: 8 },
      offPeak: { cacheHitCny: 0.02, cacheMissCny: 1, outputCny: 4 },
    },
  },
  session: {
    sessionId: 'session-test',
    calls: 5,
    tokens: { cacheHit: 1516160, cacheMiss: 4149, output: 2777, reasoning: 0, total: 1523086 },
    costCny: 0.0455802,
    costUsd: 0.00683703,
    peakCostCny: 0.0037,
    offPeakCostCny: 0.0419,
    byModel: { 'deepseek-flash': { calls: 5, costCny: 0.0455802 } },
    firstAt: 1,
    lastAt: 2,
    inFlight: [],
    recent: [{ model: 'deepseek-flash', modelId: 'deepseek-flash', peak: false, reason: 'outside-window', at: 1, tokens: { cacheHit: 1, cacheMiss: 1, output: 1, reasoning: 0, total: 3 }, costCny: 0.01, costUsd: 0.0015, beforeCurrentCard: false, routingDisputed: false }],
    known: true,
  },
  metering: { requests: 5, usageReports: 5, sessions: 1, lastError: null },
  rateCard: {
    'deepseek-flash': {
      label: 'DeepSeek Flash',
      aliases: ['deepseek-v4-flash'],
      peak: { cacheHitCny: 0.04, cacheMissCny: 2, outputCny: 8 },
      offPeak: { cacheHitCny: 0.02, cacheMissCny: 1, outputCny: 4 },
      peakUsd: { cacheHitUsd: 0.006, cacheMissUsd: 0.3, outputUsd: 1.2 },
      offPeakUsd: { cacheHitUsd: 0.003, cacheMissUsd: 0.15, outputUsd: 0.6 },
    },
  },
}

/**
 * Build a plugin context the way the client kernel does for a bundle half.
 * @param {object} options - `{ mountSlot }` to observe slot registrations.
 * @returns {object} the context handed to `apply`.
 */
function fakeContext(options = {}) {
  const effectCleanups = []
  const slots = {
    injected: [],
    registered: [],
    inject(key, callback) {
      this.injected.push(key)
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register(registration, component) {
      this.registered.push({ registration, component })
      if (options.mountSlot !== undefined) options.mountSlot(registration, component)
      return () => {}
    },
  }
  const locale = {
    dictionaries: [],
    register(ns, lang, dict) { this.dictionaries.push({ ns, lang, keys: Object.keys(dict).length }); return () => {} },
    // The real service returns the dictionary template (placeholders intact) and
    // lets the caller interpolate; the fake mirrors that so `{amount}` reaches
    // the bundle's fill().
    bind() {
      return (key, params) => {
        const template = ZH_TEMPLATES[key]
        if (template === undefined) return `t:${key}`
        return template.replace(/\{(\w+)\}/g, (match, name) => (params !== undefined && name in params ? String(params[name]) : match))
      }
    },
  }
  return {
    slots,
    locale,
    effectCleanups,
    ctx: {
      effect(callback) {
        const dispose = callback()
        effectCleanups.push(dispose)
        return () => { if (typeof dispose === 'function') dispose() }
      },
      interval(callback, ms) { return () => {} },
      get(service) {
        if (service === 'slots') return slots
        if (service === 'locale') return locale
        return undefined
      },
    },
  }
}

/** Templates the fake locale seat resolves; everything else falls back to `t:<key>`. */
const ZH_TEMPLATES = { 'cost.pill': '花费 {amount}', 'tok': 'tok', 'action.recovered': '补入 {count} 次调用' }

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

test('the bundle registers under the package name with a loader-compatible face', () => {
  const { registration, require: load } = loadBundle()
  assert.equal(registration.id, PACKAGE_NAME, 'the loader id must equal the package name')
  assert.equal(typeof registration.factory, 'function')
  const exports = registration.factory(load)
  assert.equal(typeof exports.apply, 'function', 'the loader reads exports.apply')
  assert.ok(Array.isArray(exports.inject), 'the loader reads exports.inject')
  assert.deepEqual([...exports.inject].sort(), ['slots', 'timer'])
})

test('apply registers styles, dictionaries and the dock entry', () => {
  const { registration, headChildren, require: load } = loadBundle()
  const exports = registration.factory(load)
  const harness = fakeContext()
  exports.apply(harness.ctx)
  assert.equal(headChildren.length, 1, 'exactly one <style> tag is injected')
  assert.ok(headChildren[0].textContent.includes('.dac-pill'), 'the stylesheet carries the pill rules')
  assert.ok(headChildren[0].textContent.includes('.dac-panel'), 'the stylesheet carries the dialog rules')
  assert.deepEqual(harness.locale.dictionaries.map((d) => d.lang), ['zh', 'en'])
  assert.deepEqual(harness.slots.injected, ['conversation.composer.dock'])
  assert.equal(harness.slots.registered.length, 1)
  const { registration: dock, component } = harness.slots.registered[0]
  assert.equal(dock.name, 'conversation.composer.dock')
  assert.equal(dock.id, 'api-cost')
  assert.equal(typeof component, 'function')
})

test('the pill matches the shipped stat-pill contract', async () => {
  const { registration, runtime, fetchCalls, require: load } = loadBundle()
  const exports = registration.factory(load)
  const harness = fakeContext()
  exports.apply(harness.ctx)
  const component = harness.slots.registered[0].component

  // First paint: nothing has been fetched, so the pill must render a tier word
  // rather than throwing or showing an undefined figure.
  const first = runtime.render(component, { sessionId: 'session-test' })
  assert.equal(first.type, 'span')
  assert.equal(first.props.className, 'dac-root')
  const anchor = first.children[0]
  assert.equal(anchor.props.className, 'dac-anchor', 'the trigger is wrapped in the anchor span')
  assert.ok(anchor.props.ref !== undefined, 'the anchor span carries the placement ref')
  const button = anchor.children[0]
  assert.equal(button.type, 'button')
  assert.equal(button.props['aria-haspopup'], 'dialog', 'the trigger announces a dialog')
  assert.equal(button.props['aria-expanded'], false, 'the trigger starts collapsed')
  assert.equal(first.children.length, 1, 'no panel is rendered while collapsed')
  assert.ok(!JSON.stringify(first).includes('undefined'), 'first paint must not leak undefined')

  // Flush the mount effect: it subscribes and starts the shared poller.
  runtime.flushEffects()
  assert.equal(fetchCalls.length, 1, 'mounting fetches the host snapshot')
  assert.match(fetchCalls[0], /^\/dsh-api-cost\/api\?session=session-test$/)

  await new Promise((resolve) => setTimeout(resolve, 0))
  const second = runtime.render(component, { sessionId: 'session-test' })
  const settledButton = second.children[0].children[0]
  const settledText = JSON.stringify(second)
  assert.ok(settledText.includes('t:tier.peakShort'), 'the peak tier is rendered from the snapshot')
  assert.ok(settledText.includes('¥0.046'), 'the session cost is rendered in CNY')
  assert.equal(settledButton.props.className, 'dac-pill dac-pill--peak', 'peak tints the pill')
  assert.equal(settledButton.props['aria-label'], '¥0.046 · t:tier.peakShort', 'the accessible name equals the visible text, tier included')
  const labelSpan = settledButton.children[1]
  assert.equal(labelSpan.props.className, 'dac-label', 'the figure and tier ride in the label span')
  const parts = labelSpan.children[0]
  assert.deepEqual(parts.children[0], '¥0.046', 'the label leads with the cost')
  assert.equal(parts.children[1].props.className, 'dac-sep', 'the shipped separator span divides them')
  assert.equal(parts.children[1].props['aria-hidden'], true, 'the separator is decorative')
  assert.equal(parts.children[2], 't:tier.peakShort', 'the label ends with the short tier mark')
  assert.equal(second.children.length, 1, 'the panel stays closed until the trigger is clicked')

  // Clicking the trigger opens the portaled dialog, exactly like the shipped pills.
  settledButton.props.onClick()
  const opened = runtime.render(component, { sessionId: 'session-test' })
  assert.equal(opened.children.length, 2, 'the open state portals one panel')
  const panel = opened.children[1]
  assert.equal(panel.props.role, 'dialog')
  assert.equal(panel.props['aria-label'], 't:cost.title')
  assert.equal(panel.props.className, 'dac-panel dac-panel--floating', 'the portaled panel floats; the in-place fallback does not')
  assert.ok(!panel.props.className.includes('dac-panel--inline'), 'portaling does not add the inline fallback class')
  const panelText = JSON.stringify(panel)
  assert.ok(panelText.includes('t:cost.title'), 'the panel is titled')
  assert.ok(panelText.includes('t:tier.nextOffPeak'), 'the panel counts down to the next tier')
  assert.ok(panelText.includes('t:detail.total'), 'the panel totals the session')
  assert.ok(panelText.includes('t:detail.peakCost'), 'the panel splits peak spend')
  assert.ok(panelText.includes('t:detail.offPeakCost'), 'the panel splits off-peak spend')
  // The rates block: heading without a model annotation, three label/value rows
  // on their own grid, and a unit footer.
  assert.ok(panelText.includes('t:detail.rates'), 'the panel lists the current rates')
  assert.ok(!panelText.includes('DeepSeek Flash'), 'the rate heading carries no model annotation')
  assert.ok(panelText.includes('t:rate.cacheHit'), 'the rate block names the cache-hit bucket')
  assert.ok(panelText.includes('t:rate.cacheMiss'), 'the rate block names the cache-miss bucket')
  assert.ok(panelText.includes('t:rate.output'), 'the rate block names the output bucket')
  assert.ok(panelText.includes('dac-section'), 'the rate rows ride the panel grid')
  assert.ok(panelText.includes('t:rate.unit'), 'the rate block states its unit')
  // The panel shows only what was asked for: totals, the tier line, and the
  // current rates. The per-bucket token rows, the call count, the model row and
  // the trailing note lines are gone.
  for (const dropped of ['t:detail.calls', 't:detail.cacheHit', 't:detail.cacheMiss', 't:detail.output', 't:detail.models', 't:note.', 't:detail.source', 't:detail.effective']) {
    assert.ok(!panelText.includes(dropped), `the panel no longer renders ${dropped}`)
  }
  assert.ok(!panelText.includes('undefined'), 'the open panel must not leak undefined')
})

test('the panel renders without a session id prop', async () => {
  // The dock owner passes no props of its own; a widget that requires
  // `props.sessionId` to be present would break on a fresh session.
  const { registration, runtime, require: load } = loadBundle()
  const exports = registration.factory(load)
  const harness = fakeContext()
  exports.apply(harness.ctx)
  const component = harness.slots.registered[0].component
  assert.doesNotThrow(() => runtime.render(component, {}))
  runtime.flushEffects()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const open = runtime.render(component, {})
  open.children[0].children[0].props.onClick()
  assert.doesNotThrow(() => runtime.render(component, {}))
})

test('the plugin survives a composition without slots', () => {
  const { registration, require: load } = loadBundle()
  const exports = registration.factory(load)
  // A composition where `slots` is missing must degrade, not throw.
  assert.doesNotThrow(() => exports.apply({ effect: () => {}, get: () => undefined }))
})

test('the panel splits the total when subsessions spent money', async () => {
  // A subagent or agent-team conversation must not look like the parent spent
  // the whole figure: the panel names the subsession share.
  const { registration, runtime, require: load } = loadBundle()
  const exports = registration.factory(load)
  const harness = fakeContext()
  exports.apply(harness.ctx)
  const component = harness.slots.registered[0].component

  const withChildren = {
    ...SNAPSHOT,
    session: {
      ...SNAPSHOT.session,
      calls: 12,
      costCny: 0.5,
      costUsd: 0.075,
      ownCostCny: 0.2,
      subagentCostCny: 0.3,
      subagents: 3,
    },
  }
  globalThis.fetch = () => Promise.resolve({ ok: true, json: async () => withChildren })

  runtime.render(component, { sessionId: 'session-test' })
  runtime.flushEffects()
  // Let the swapped snapshot land before opening the panel.
  await new Promise((resolve) => setTimeout(resolve, 0))
  const settled = runtime.render(component, { sessionId: 'session-test' })
  settled.children[0].children[0].props.onClick()
  const opened = runtime.render(component, { sessionId: 'session-test' })
  const panelText = JSON.stringify(opened.children[1])
  assert.ok(panelText.includes('t:detail.ownCost'), 'the panel names what this session spent')
  assert.ok(panelText.includes('t:detail.subagentCost'), 'the panel names what subsessions spent')
  assert.ok(panelText.includes('¥0.2'), 'the own figure is shown')
  assert.ok(panelText.includes('¥0.3'), 'the subsession figure is shown')
  assert.ok(panelText.includes('×3'), 'the subsession count is shown')
})

test('the panel omits the split when nothing was delegated', async () => {
  const { registration, runtime, require: load } = loadBundle()
  const exports = registration.factory(load)
  const harness = fakeContext()
  exports.apply(harness.ctx)
  const component = harness.slots.registered[0].component
  runtime.render(component, { sessionId: 'session-test' })
  runtime.flushEffects()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const settled = runtime.render(component, { sessionId: 'session-test' })
  settled.children[0].children[0].props.onClick()
  const opened = runtime.render(component, { sessionId: 'session-test' })
  const panelText = JSON.stringify(opened.children[1])
  assert.ok(!panelText.includes('t:detail.ownCost'), 'no split rows without subsessions')
  assert.ok(!panelText.includes('t:detail.subagentCost'), 'no subsession row without subsessions')
})

test('the panel lists the Team roster when the scope is a Team', async () => {
  // A Team member's widget shows the shared bill, so the panel has to say whose
  // spend makes it up — otherwise the total is unattributable.
  const { registration, runtime, require: load } = loadBundle()
  const exports = registration.factory(load)
  const harness = fakeContext()
  exports.apply(harness.ctx)
  const component = harness.slots.registered[0].component

  globalThis.fetch = () => Promise.resolve({
    ok: true,
    json: async () => ({
      ...SNAPSHOT,
      scope: 'team',
      teamRootId: 'session-lead',
      session: {
        ...SNAPSHOT.session,
        calls: 20,
        costCny: 1.5,
        costUsd: 0.225,
        ownCostCny: 0.4,
        subagentCostCny: 1.1,
        subagents: 2,
        members: [
          { sessionId: 'session-lead', name: 'lead', role: 'lead', status: 'running', calls: 8, costCny: 1.0, costUsd: 0.15 },
          { sessionId: 'session-a', name: 'mate-a', role: 'teammate', status: 'running', calls: 7, costCny: 0.4, costUsd: 0.06 },
          { sessionId: 'session-b', name: 'mate-b', role: 'teammate', status: 'inactive', calls: 5, costCny: 0.1, costUsd: 0.015 },
        ],
      },
    }),
  })

  runtime.render(component, { sessionId: 'session-a' })
  runtime.flushEffects()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const settled = runtime.render(component, { sessionId: 'session-a' })
  settled.children[0].children[0].props.onClick()
  const opened = runtime.render(component, { sessionId: 'session-a' })
  const panelText = JSON.stringify(opened.children[1])
  assert.ok(panelText.includes('t:detail.teamCost'), 'the split reads as teammates, not subsessions')
  assert.ok(!panelText.includes('t:detail.subagentCost'), 'the subsession wording is not used for a Team')
  assert.ok(panelText.includes('t:detail.teamRoster'), 'the roster row is present')
  assert.ok(panelText.includes('lead'), 'the Lead is listed')
  assert.ok(panelText.includes('mate-a') && panelText.includes('mate-b'), 'every teammate is listed')
  assert.ok(panelText.includes('¥1') && panelText.includes('¥0.4') && panelText.includes('¥0.1'), 'each seat carries its spend')
  assert.ok((panelText.match(/"type":"br"/g) ?? []).length >= 2, 'the roster stacks one member per line')
})

test('the footer button recounts from the logs and reports what it recovered', async () => {
  const { registration, runtime, require: load } = loadBundle()
  const exports = registration.factory(load)
  const harness = fakeContext()
  exports.apply(harness.ctx)
  const component = harness.slots.registered[0].component

  const requests = []
  globalThis.fetch = (url, init) => {
    requests.push({ url: String(url), method: (init ?? {}).method ?? 'GET' })
    const isReconcile = String(url).includes('/reconcile')
    return Promise.resolve({
      ok: true,
      json: async () => (isReconcile
        ? { ok: true, recovered: 7, scanned: 3, sessions: 3, truncated: false }
        : SNAPSHOT),
    })
  }

  runtime.render(component, { sessionId: 'session-test' })
  runtime.flushEffects()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const settled = runtime.render(component, { sessionId: 'session-test' })
  settled.children[0].children[0].props.onClick()
  const opened = runtime.render(component, { sessionId: 'session-test' })

  // The footer sits below the details, at the panel's bottom-left.
  const footer = opened.children[1].children[3]
  assert.equal(footer.props.className, 'dac-footer')
  const button = footer.children[0]
  assert.equal(button.type, 'button')
  assert.equal(button.props.className, 'dac-action')
  assert.equal(button.props.disabled, false)
  assert.ok(JSON.stringify(button).includes('t:action.refresh'), 'the button is labelled')
  assert.equal(footer.children.length, 1, 'no status line before the first recount')

  // Press it: the client must POST to the reconcile route for this session.
  const before = requests.length
  button.props.onClick()
  const running = runtime.render(component, { sessionId: 'session-test' })
  const runningButton = running.children[1].children[3].children[0]
  assert.equal(runningButton.props.disabled, true, 'a second press cannot stack a recount')
  assert.ok(JSON.stringify(runningButton).includes('t:action.refreshing'), 'the button shows progress')

  await new Promise((resolve) => setTimeout(resolve, 0))
  const pressed = requests.slice(before)
  const reconciles = pressed.filter((entry) => entry.url.includes('/reconcile'))
  assert.equal(reconciles.length, 1, 'exactly one reconcile call')
  assert.equal(reconciles[0].method, 'GET', 'the recount is a GET: the shell transport rejects unknown methods')
  assert.match(reconciles[0].url, /^\/dsh-api-cost\/api\/reconcile\?session=session-test&scope=/)
  assert.match(reconciles[0].url, /scope=(tree|self|team)/)

  // The status line reports the recovery, and the snapshot is re-read.
  const done = runtime.render(component, { sessionId: 'session-test' })
  const status = done.children[1].children[3].children[1]
  assert.ok(status !== null && status !== undefined, 'a status line appears')
  assert.equal(status.props.className, 'dac-actionNote')
  assert.equal(status.props.role, 'status')
  assert.ok(JSON.stringify(status).includes('7'), 'the recovered count is shown')
  assert.ok(requests.length > pressed.length, 'the panel re-read the snapshot after the recount')
})

test('a failed recount surfaces the error instead of pretending success', async () => {
  const { registration, runtime, require: load } = loadBundle()
  const exports = registration.factory(load)
  const harness = fakeContext()
  exports.apply(harness.ctx)
  const component = harness.slots.registered[0].component

  globalThis.fetch = (url) => Promise.resolve(String(url).includes('/reconcile')
    ? { ok: false, status: 503, json: async () => ({ ok: false, reason: 'session logs are not queryable' }) }
    : { ok: true, json: async () => SNAPSHOT })

  runtime.render(component, { sessionId: 'session-test' })
  runtime.flushEffects()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const settled = runtime.render(component, { sessionId: 'session-test' })
  settled.children[0].children[0].props.onClick()
  const opened = runtime.render(component, { sessionId: 'session-test' })
  opened.children[1].children[3].children[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const failed = runtime.render(component, { sessionId: 'session-test' })
  const errorFooter = failed.children[1].children[3]
  const status = errorFooter.children[1]
  assert.equal(status.props.className, 'dac-actionNote dac-actionNote--error')
  assert.equal(status.props.role, 'alert')
  assert.ok(JSON.stringify(status).includes('queryable'), 'the reason is shown')
})

test('the bundle only ever requires platform seed words', () => {
  // The module table resolves `react` / `react-dom` from the platform seed; any
  // other specifier would be a hard failure at materialization (and, per the
  // authoring contract, is forbidden for `@deepseek-ai/dsh-client-ui-*`). This
  // asserts the bundle never asks for anything else.
  const { registration, runtime } = loadBundle()
  const requested = []
  const load = (specifier) => {
    requested.push(specifier)
    if (specifier === 'react') return runtime.React
    if (specifier === 'react-dom') return { createPortal: (node) => node }
    throw new Error('unexpected module-table request: ' + specifier)
  }
  const exports = registration.factory(load)
  const harness = fakeContext()
  exports.apply(harness.ctx)
  const component = harness.slots.registered[0].component
  runtime.render(component, { sessionId: 'session-test' })
  runtime.flushEffects()
  assert.deepEqual([...new Set(requested)].sort(), ['react', 'react-dom'])
})

test('the placement hook clamps above the frame clearance and observes panel size', async () => {
  // Two divergences a source-level diff finds and a text-only test cannot:
  // the top clamp must respect the desktop frame's window-drag strip (published
  // as --dsh-frame-top-clearance), and a live panel must be re-measured when its
  // own size changes.
  const { registration, runtime, observers, require: load } = loadBundle()
  const exports = registration.factory(load)
  const harness = fakeContext()
  exports.apply(harness.ctx)
  const component = harness.slots.registered[0].component

  // Settle the store first: with no snapshot yet the mount effect refetches on
  // every pass, which would keep re-queueing effects underneath the assertions.
  runtime.render(component, { sessionId: 'session-test' })
  runtime.flushEffects()
  await new Promise((resolve) => setTimeout(resolve, 0))

  const settled = runtime.render(component, { sessionId: 'session-test' })
  settled.children[0].children[0].props.onClick()
  // Render the opened state, then flush the effects that pass queued: the
  // seat effect runs with `open` true and the panel ref already populated,
  // which is when the size observer is established.
  runtime.render(component, { sessionId: 'session-test' })
  runtime.flushEffects()
  assert.ok(observers.length >= 1, 'opening establishes a panel observer')
  const live = observers.filter((observer) => observer.disconnected !== true)
  assert.equal(live.length, 1, 'exactly one observer stays attached while open')
  assert.equal(live[0].observed.length, 1, 'the observer watches the panel node')

  const opened = runtime.render(component, { sessionId: 'session-test' })
  const panel = opened.children[1]
  // Anchor top 600, panel height 180, gap 8 ⇒ 412, which is above the
  // 48 + 20 = 68px clearance, so the clearance must not move it.
  assert.deepEqual(panel.props.style, { left: 40, top: 412 }, 'the panel sits above its trigger')
})

test('the panel keeps a valid description list and stacks the rate lines', async () => {
  const { registration, runtime, require: load } = loadBundle()
  const exports = registration.factory(load)
  const harness = fakeContext()
  exports.apply(harness.ctx)
  const component = harness.slots.registered[0].component
  runtime.render(component, { sessionId: 'session-test' })
  runtime.flushEffects()
  // Let the snapshot land: the dialog must be inspected in its populated state.
  await new Promise((resolve) => setTimeout(resolve, 0))

  const settled = runtime.render(component, { sessionId: 'session-test' })
  settled.children[0].children[0].props.onClick()
  const opened = runtime.render(component, { sessionId: 'session-test' })
  const panel = opened.children[1]
  const dl = panel.children[2]
  assert.equal(dl.type, 'dl')
  // Every value cell must follow a term, or the list is not a valid <dl>.
  const types = dl.children.map((child) => child.type)
  for (let index = 0; index < types.length; index += 1) {
    if (types[index] === 'dd') {
      assert.equal(types[index - 1], 'dt', `dd at ${index} must follow a dt in the <dl>`)
    }
  }
  // The rates block rides the panel's own grid: a full-width heading row, then
  // one label/value row per bucket so the names share the panel's label column
  // and the figures share its right-aligned value column, then a unit footer.
  const rateHead = dl.children[dl.children.length - 9]
  assert.equal(rateHead.type, 'dt')
  assert.equal(rateHead.props.className, 'dac-section', 'the rates heading spans the row')
  assert.equal(rateHead.children[0], 't:detail.rates', 'the rates heading is unannotated')
  const rateRows = dl.children.slice(dl.children.length - 8, dl.children.length - 1)
  assert.deepEqual(rateRows.map((child) => child.type), ['dt', 'dd', 'dt', 'dd', 'dt', 'dd', 'dt'])
  assert.equal(rateRows[0].props.className, undefined, 'a rate name is a plain grid cell')
  assert.equal(rateRows[1].props.className, undefined, 'a rate price is a plain grid cell')
  const rateText = JSON.stringify(rateRows)
  assert.ok(rateText.indexOf('t:rate.cacheHit') < rateText.indexOf('t:rate.cacheMiss'), 'cache hit precedes miss')
  assert.ok(rateText.indexOf('t:rate.cacheMiss') < rateText.indexOf('t:rate.output'), 'cache miss precedes output')
  assert.ok(rateText.includes('¥0.04') && rateText.includes('¥2') && rateText.includes('¥8'), 'each bucket carries its price')
  assert.ok(!rateText.includes('　'), 'no full-width space glues the unit to a figure')
  const unit = dl.children[dl.children.length - 1]
  assert.equal(unit.type, 'dd')
  assert.equal(unit.props.className, 'dac-rate-unit', 'the unit is a full-width footer note')
  assert.equal(unit.children[0], 't:rate.unit')
})
