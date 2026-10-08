/**
 * dsh-api-cost — Client half.
 *
 * One pill in the composer dock, exactly like the shipped `会话统计` / `Token 用量`
 * pills: an icon plus a compact figure, and a click opens a trigger-anchored
 * dialog portaled above it. Same anchors, same metrics, same dismissal rules —
 * so the three pills read as one family in the composer row.
 *
 * Interaction contract copied from `@deepseek-ai/dsh-client-ui-chat`'s StatsPills:
 *   - trigger: `<span class=anchor><button class=pill aria-haspopup="dialog"
 *     aria-expanded=…>icon + label</button></span>`
 *   - panel: `createPortal(<div role="dialog" style={pos ?? MEASURE_STYLE}>…,
 *     document.body)`, placed above the trigger and closed by outside
 *     pointerdown + Escape
 *   - panel body: title row (icon + label, optional right-aligned value), hair
 *     rule, then a `<dl>` of label/value rows
 * Only `react` / `react-dom` come from the module table — both are platform seed
 * words. The placement and dismissal hooks are local copies of the shipped ones
 * (see below) because the in-app authoring contract forbids a plugin from
 * requiring `@deepseek-ai/dsh-client-ui-*`.
 *
 * The figure itself still comes from the Host half over HTTP — this half never
 * prices anything, so a wrong number has exactly one place to be fixed.
 *
 * Plain JavaScript on purpose: the browser module table loads this file as-is.
 * The `__ModuleLoader__.load` handshake is mandatory — the combo route serves
 * every client bundle as one script, so a bundle that never registers breaks
 * every other package in the same response.
 */
window.__ModuleLoader__.load({
  // Must equal the package name: the boot graph keys every row by the resolved
  // package of its loader row, and a mismatched id fails the whole combo script.
  id: 'dsh-api-cost',
  factory(require) {
    const React = require('react');

    /**
     * HTTP prefix the Host half registered. Deliberately not under `/api`: that
     * bridge enforces the connection layer's request trust policy and answers a
     * plain page GET with 401. This path is owned by the plugin's own webserver
     * route, which is what the other pricing widgets in this ecosystem do too.
     */
    const API = '/dsh-api-cost/api';
    /** How often the ledger is refreshed while the widget is mounted. */
    const POLL_MS = 2500;
    /** How often the countdown is redrawn between polls. */
    const TICK_MS = 1000;
    /** Requests slower than this are treated as a transport problem. */
    const FETCH_TIMEOUT_MS = 8000;

    /* ---------------------------------------------------------------- *
     * Host-shared UI modules, loaded defensively
     *
     * The shipped pills use `react-dom`'s portal and the primitives' placement
     * hooks. Both are optional here: if either is missing from this composition
     * the widget still renders — anchored with a local equivalent, or inline
     * without a portal — instead of taking down the client entry.
     * ---------------------------------------------------------------- */

    let reactDom = null;
    try { reactDom = require('react-dom'); } catch (error) { reactDom = null; }

    /** Exactly the geometry contract the shipped placement hook accepts. */
    const PLACEMENT = { side: 'top', gap: 8, margin: 12 };
    /** Unplaced panel: hidden but laid out, so the clamp measures real size. */
    const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 };

    /**
     * Everything below the desktop frame's top clearance is unusable by a fixed
     * panel: the caption / traffic-light strip is a window-drag region. Mirrors
     * the shipped helper — 20px of breathing room under a clearance that the
     * layout publishes as `--dsh-frame-top-clearance` (0 outside a fullscreen
     * window, so a plain browser needs no special case).
     * @param {number} margin - the caller's own margin.
     * @returns {number} the smallest allowed `top`.
     */
    function overlayTopMargin(margin) {
      let clearance = 0;
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function' && document.documentElement !== undefined) {
        const raw = window.getComputedStyle(document.documentElement).getPropertyValue('--dsh-frame-top-clearance');
        const parsed = Number.parseFloat(raw);
        if (isFinite(parsed)) clearance = parsed;
      }
      return Math.max(margin, clearance + 20);
    }

    /**
     * Local copy of the primitives' placement hook, behaviourally identical to
     * `useAnchoredPosition({ side: 'top' })`: viewport clamp, overlay-top
     * clearance, scroll/resize tracking, and a ResizeObserver so a panel whose
     * content grows while open is re-clamped instead of growing off-screen.
     * Copied rather than imported on purpose: the in-app plugin authoring
     * contract forbids a plugin from requiring `@deepseek-ai/dsh-client-ui-*`,
     * since they are compiled into the shell without a stable plugin-facing
     * interface — a rename would break a plain-JS bundle with no type check.
     * Only the public theme tokens below are shared with the host.
     * @param {object} options - `{ open, anchorRef, panelRef, side, gap, margin }`.
     * @returns {{left: number, top: number}|null} viewport position, or null while unplaced.
     */
    function useAnchoredPosition(options) {
      const { open, anchorRef, panelRef, side = 'bottom', gap = 0, margin = 0 } = options;
      const [position, setPosition] = React.useState(null);
      React.useLayoutEffect(() => {
        if (!open) {
          setPosition(null);
          return undefined;
        }
        const place = () => {
          const anchor = anchorRef.current;
          const rect = anchor === null || anchor === undefined ? undefined : anchor.getBoundingClientRect();
          if (rect === undefined) return;
          const panel = panelRef.current;
          const width = panel === null || panel === undefined ? 0 : panel.offsetWidth;
          const height = panel === null || panel === undefined ? 0 : panel.offsetHeight;
          let left = rect.left;
          let top = side === 'top' ? rect.top - gap - height : rect.bottom + gap;
          if (width > 0) left = Math.min(Math.max(left, margin), window.innerWidth - width - margin);
          if (height > 0) top = Math.min(Math.max(top, overlayTopMargin(margin)), window.innerHeight - height - margin);
          setPosition({ left, top });
        };
        place();
        window.addEventListener('scroll', place, true);
        window.addEventListener('resize', place);
        // This panel's content is live (a 1s ticker, a 2.5s poll), so its size
        // can change while open; without re-measuring, a top-anchored panel grows
        // downward off-screen instead of being re-clamped above the trigger.
        const panel = panelRef.current;
        let observer = null;
        if (typeof ResizeObserver !== 'undefined' && panel !== null && panel !== undefined) {
          observer = new ResizeObserver(place);
          observer.observe(panel);
        }
        return () => {
          if (observer !== null) observer.disconnect();
          window.removeEventListener('scroll', place, true);
          window.removeEventListener('resize', place);
        };
      }, [open, anchorRef, panelRef, side, gap, margin]);
      return position;
    }

    /**
     * Local copy of the primitives' outside-pointer dismissal.
     * @param {object} root - trigger ref.
     * @param {boolean} open - whether the panel is open.
     * @param {(open: boolean) => void} setOpen - open-state setter.
     * @param {object} portal - panel ref.
     */
    function useDismissOnOutsidePointer(root, open, setOpen, portal) {
      React.useEffect(() => {
        if (!open) return undefined;
        const closeOutside = (event) => {
          const target = event.target;
          // Same non-Node guard the shipped hook keeps: a synthetic event whose
          // target is not a DOM node must not close the panel.
          if (typeof Node === 'function' && !(target instanceof Node)) return;
          const insideRoot = root.current !== null && root.current !== undefined && root.current.contains(target);
          const insidePortal = portal.current !== null && portal.current !== undefined && portal.current.contains(target);
          if (insideRoot !== true && insidePortal !== true) setOpen(false);
        };
        document.addEventListener('pointerdown', closeOutside);
        return () => document.removeEventListener('pointerdown', closeOutside);
      }, [root, open, setOpen, portal]);
    }

    /** `createPortal` when react-dom is reachable, otherwise render in place. */
    const createPortal = reactDom !== null && typeof reactDom.createPortal === 'function'
      ? reactDom.createPortal
      : null;

    /* ---------------------------------------------------------------- *
     * Locale
     * ---------------------------------------------------------------- */
    const ZH = {
      'cost.pill': '花费 {amount}',
      'cost.title': '会话花费',
      'cost.empty': '本会话还没有已结算的调用。',
      'tier.peak': '高峰时段',
      'tier.offPeak': '空闲时段',
      'tier.peakShort': '峰',
      'tier.idleShort': '谷',
      'tier.nextPeak': '距高峰开始',
      'tier.nextOffPeak': '距空闲开始',
      'tier.weekend': '周末全天空闲',
      'tier.holiday': '法定节假日全天空闲',
      'tier.makeup': '调休上班日按空闲计费',
      'detail.total': '合计',
      'detail.ownCost': '其中本会话',
      'detail.subagentCost': '其中子会话',
      'detail.teamCost': '其中团队成员',
      'detail.teamRoster': '团队',
      'detail.peakCost': '其中高峰',
      'detail.offPeakCost': '其中空闲',
      'detail.inFlight': '进行中',
      'detail.rates': '当前费率',
      'rate.cacheHit': '缓存命中',
      'rate.cacheMiss': '缓存未命中',
      'rate.output': '输出',
      'rate.unit': '元 / 百万 tokens',
      'action.refresh': '重新统计',
      'action.refreshing': '正在重算…',
      'action.refreshHint': '以会话日志为准，重算该范围内的调用数（含插件启动前、以及进程重启前的）',
      'action.refreshed': '已重算',
      'action.recovered': '共 {count} 次调用',
      'action.retry': '重试',
    };

    const EN = {
      'cost.pill': 'Cost {amount}',
      'cost.title': 'Session cost',
      'cost.empty': 'No settled call in this session yet.',
      'tier.peak': 'Peak',
      'tier.offPeak': 'Off-peak',
      'tier.peakShort': 'Peak',
      'tier.idleShort': 'Off',
      'tier.nextPeak': 'Peak starts in',
      'tier.nextOffPeak': 'Off-peak starts in',
      'tier.weekend': 'All weekend off-peak',
      'tier.holiday': 'Holiday — off-peak all day',
      'tier.makeup': 'Makeup workday — off-peak',
      'detail.total': 'Total',
      'detail.ownCost': 'of which this session',
      'detail.subagentCost': 'of which subsessions',
      'detail.teamCost': 'of which teammates',
      'detail.teamRoster': 'Team',
      'detail.peakCost': 'of which peak',
      'detail.offPeakCost': 'of which off-peak',
      'detail.inFlight': 'In flight',
      'detail.rates': 'Current rates',
      'rate.cacheHit': 'Cache hit',
      'rate.cacheMiss': 'Cache miss',
      'rate.output': 'Output',
      'rate.unit': 'CNY / 1M tokens',
      'action.refresh': 'Recount',
      'action.refreshing': 'Recounting…',
      'action.refreshHint': 'Re-count the calls in scope from the session logs — the source of truth, including calls that settled before the plugin loaded',
      'action.refreshed': 'Recounted',
      'action.recovered': '{count} calls counted',
      'action.retry': 'Retry',
    };

    /* ---------------------------------------------------------------- *
     * Display helpers (formatting only — never pricing)
     * ---------------------------------------------------------------- */

    /**
     * Adaptive-precision CNY amount.
     * @param {number} v - yuan amount.
     * @returns {string} formatted amount.
     */
    function cny(v) {
      const n = typeof v === 'number' && isFinite(v) ? v : 0;
      if (n === 0) return '¥0';
      if (n < 0.01) return '¥' + n.toFixed(4);
      if (n < 1) return '¥' + n.toFixed(3);
      return '¥' + n.toFixed(2);
    }

    /**
     * Adaptive-precision USD amount.
     * @param {number} v - dollar amount.
     * @returns {string} formatted amount.
     */
    function usd(v) {
      const n = typeof v === 'number' && isFinite(v) ? v : 0;
      if (n === 0) return '$0';
      if (n < 0.01) return '$' + n.toFixed(4);
      if (n < 1) return '$' + n.toFixed(3);
      return '$' + n.toFixed(2);
    }

    /**
     * Countdown, in the pills' short-form idiom: "2d 3h" / "3h 07m" / "07m 12s".
     * @param {number} ms - remaining milliseconds.
     * @returns {string} human duration.
     */
    function countdown(ms) {
      if (typeof ms !== 'number' || !isFinite(ms)) return '--';
      let s = Math.max(0, Math.round(ms / 1000));
      const d = Math.floor(s / 86400);
      s -= d * 86400;
      const h = Math.floor(s / 3600);
      s -= h * 3600;
      const m = Math.floor(s / 60);
      s -= m * 60;
      const pad = (n) => (n < 10 ? '0' + n : String(n));
      if (d > 0) return d + 'd ' + h + 'h';
      if (h > 0) return h + 'h ' + pad(m) + 'm';
      return m + 'm ' + pad(s) + 's';
    }

    /**
     * Interpolate `{name}` placeholders the way the client locale service does.
     * @param {string} template - raw dictionary string.
     * @param {Record<string, unknown>} params - substitutions.
     * @returns {string} the rendered string.
     */
    function fill(template, params) {
      return String(template).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
    }

    /* ---------------------------------------------------------------- *
     * Icons
     * ---------------------------------------------------------------- */

    /**
     * Cost mark: the coin/¥ glyph from this plugin's bundle icon. Kept local
     * rather than borrowing a host icon so the composer pills stay visually
     * distinguishable from one another.
     * @returns {object} the svg element.
     */
    function CostMark() {
      return React.createElement('svg', {
        viewBox: '0 0 24 24',
        width: 14,
        height: 14,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
      },
      React.createElement('circle', { cx: 12, cy: 12, r: 9 }),
      React.createElement('path', { d: 'M8.3 7.3 12 11.9l3.7-4.6' }),
      React.createElement('path', { d: 'M12 11.9V17' }),
      React.createElement('path', { d: 'M9.2 13.3h5.6M9.2 15.3h5.6' }));
    }

    /**
     * Refresh mark: a circular arrow, the panel footer's only action.
     * @returns {object} the svg element.
     */
    function RefreshMark() {
      return React.createElement('svg', {
        viewBox: '0 0 24 24',
        width: 13,
        height: 13,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
      },
      React.createElement('path', { d: 'M20.5 12a8.5 8.5 0 1 1-2.6-6.1' }),
      React.createElement('path', { d: 'M20.7 4.2v5.2h-5.2' }));
    }

    /* ---------------------------------------------------------------- *
     * Styles — plugin-scoped class names, host token values
     * ---------------------------------------------------------------- */

    const CSS = `
.dac-root { box-sizing: border-box; min-width: 0; max-width: 100%; font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px); line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px)); display: inline-flex; }
.dac-anchor { min-width: 0; display: inline-flex; }
.dac-pill { box-sizing: border-box; corner-shape: round; max-width: 100%; color: var(--dsw-alias-label-tertiary); font: inherit; font-variant-numeric: tabular-nums; line-height: inherit; white-space: nowrap; background: none; border: none; border-radius: 999px; align-items: center; gap: 6px; padding: 1px 8px; display: inline-flex; }
.dac-pill svg { flex: none; width: 14px; height: 14px; }
button.dac-pill { cursor: pointer; }
button.dac-pill:hover, button.dac-pill[aria-expanded='true'] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.dac-pill--peak { color: var(--dsw-alias-state-warn-primary); }
.dac-label { text-overflow: ellipsis; min-width: 0; overflow: hidden; }
.dac-sep { color: var(--dsw-alias-separator-primary); margin: 0 6px; }
.dac-panel { z-index: 1100; box-sizing: border-box; border-radius: var(--dsw-radius-lg); background: var(--dsw-specific-menu); width: max-content; min-width: min(300px, 100vw - 24px); max-width: min(440px, 100vw - 24px); backdrop-filter: var(--dsw-menu-backdrop-filter); --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); box-shadow: var(--dsw-elevation-prominent); color: var(--dsw-alias-label-secondary); cursor: default; border: 0; padding: 16px; font-size: 12px; line-height: 18px; }
.dac-panel--floating { position: fixed; }
.dac-panel--inline { position: absolute; }
.dac-title { color: var(--dsw-alias-label-primary); justify-content: space-between; gap: 16px; margin-bottom: 8px; font-weight: 500; display: flex; }
.dac-titleLabel { align-items: center; gap: 6px; min-width: 0; display: inline-flex; }
.dac-titleLabel svg { flex: none; width: 14px; height: 14px; }
.dac-titleValue { font-variant-numeric: tabular-nums; }
.dac-rule { border-top: 0.5px solid var(--dsw-alias-border-l2); margin-bottom: 10px; }
.dac-details { color: var(--dsw-alias-label-tertiary); grid-template-columns: minmax(76px, auto) minmax(0, 1fr); gap: 6px 16px; margin: 0; display: grid; }
.dac-details dt, .dac-details dd { min-width: 0; margin: 0; }
.dac-details dd { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; text-align: right; }
.dac-details dd.dac-wrap { overflow-wrap: anywhere; }
/* Section heading inside the details grid: a label on its own line, with the
   rows it introduces following beneath it. The footer's heading is hidden —
   a note needs a term for the list to stay valid, not a visible label. */
.dac-details .dac-section { grid-column: 1 / -1; margin: 0; color: var(--dsw-alias-label-tertiary); text-align: left; }
.dac-details .dac-section-visually-hidden { display: none; }
.dac-rate-unit { grid-column: 1 / -1; margin: 0; color: var(--dsw-alias-label-tertiary); text-align: right; }
/* Panel footer: a small action row, button at the left. */
.dac-footer { justify-content: space-between; align-items: center; gap: 12px; margin-top: 12px; display: flex; }
.dac-action { appearance: none; font: inherit; font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer; background: none; border: 0; border-radius: var(--dsw-radius-sm, 6px); align-items: center; gap: 4px; padding: 2px 6px; display: inline-flex; }
.dac-action:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dac-action:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dac-action:disabled { cursor: default; opacity: 0.65; }
.dac-action svg { flex: none; width: 13px; height: 13px; }
.dac-action--busy svg { animation: dac-spin 900ms linear infinite; }
.dac-actionNote { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.dac-actionNote--error { color: var(--dsw-alias-state-error-primary); }
@keyframes dac-spin { to { transform: rotate(360deg); } }
`;

    /* ---------------------------------------------------------------- *
     * Panel builders (plain functions: no hooks, no per-render identity)
     * ---------------------------------------------------------------- */

    /**
     * Title row: icon + label, with an optional right-aligned value.
     * @param {string} text - title text.
     * @param {object|null} value - optional right-hand element.
     * @returns {object} the title element.
     */
    function titleRow(text, value) {
      return React.createElement('div', { className: 'dac-title' },
        React.createElement('span', { className: 'dac-titleLabel' },
          React.createElement(CostMark, null),
          text),
        value);
    }

    /**
     * Why the current tier applies, when there is no boundary to count down to.
     * @param {object} pricing - host pricing snapshot.
     * @param {(key: string) => string} tr - translate.
     * @returns {string|null} the reason text, or null when the countdown covers it.
     */
    function reasonText(pricing, tr) {
      if (pricing.reason === 'weekend') return tr('tier.weekend');
      if (pricing.reason === 'holiday') return tr('tier.holiday');
      if (pricing.reason === 'makeup-workday') return tr('tier.makeup');
      return null;
    }

    /**
     * One line per Team member: name, role, and what that seat spent. The rows
     * are already sorted by spend, so the expensive seat sits first.
     * @param {object[]} members - host member rows.
     * @returns {object[]} a `<br>`-separated run of members.
     */
    function memberLines(members) {
      const lines = [];
      for (let index = 0; index < members.length; index += 1) {
        const member = members[index];
        if (index > 0) lines.push(React.createElement('br', { key: 'br' + index }));
        const role = member.role === 'lead' ? '★ ' : '';
        lines.push(role + String(member.name) + '  ' + cny(member.costCny));
      }
      return lines;
    }

    /**
     * Build the dialog body: title row, hair rule, then the shipped `<dl>` of
     * label/value rows. Every figure was computed by the Host half.
     * @param {object|null} snap - host snapshot, or null before the first poll.
     * @param {number} now - shared clock, for the boundary countdown.
     * @param {(key: string, params?: object) => string} tr - translate.
     * @returns {object[]} the panel's children.
     */
    function panelChildren(snap, now, tr) {
      if (snap === null) {
        return [
          titleRow(tr('cost.title'), null),
          React.createElement('div', { className: 'dac-rule', 'aria-hidden': true }),
          React.createElement('dl', { className: 'dac-details' },
            React.createElement('dt', null, tr('detail.total')),
            React.createElement('dd', null, tr('cost.empty'))),
        ];
      }

      const pricing = snap.pricing;
      const session = snap.session;
      const tier = pricing.peak === true ? 'peak' : 'offPeak';
      const rates = pricing.rates === undefined || pricing.rates === null ? null : pricing.rates[tier];
      const rows = [];
      let rowKey = 0;
      /**
       * Append one label/value row.
       * @param {string} label - row label.
       * @param {string} value - row value.
       * @param {boolean} [wrap] - allow the value to wrap anywhere.
       */
      const push = (label, value, wrap) => {
        rowKey += 1;
        rows.push(React.createElement('dt', { key: 'k' + rowKey }, label));
        rows.push(React.createElement('dd', { key: 'v' + rowKey, className: wrap === true ? 'dac-wrap' : undefined }, value));
      };

      // Where "now" stands in the pricing calendar. The reason wins over the
      // plain tier word when it explains WHY (weekend / holiday / makeup day);
      // the countdown wins when a real boundary is coming; with neither, the
      // tier word stands alone and the label column carries the countdown's
      // usual wording so the grid keeps its two-column shape.
      const next = pricing.next === null || pricing.next === undefined ? null : pricing.next;
      const remaining = next === null || typeof next.at !== 'number' ? null : next.at - now;
      const reason = reasonText(pricing, tr);
      const tierWord = pricing.peak === true ? tr('tier.peak') : tr('tier.offPeak');
      if (remaining === null) {
        push(reason !== null ? reason : tierWord, reason !== null ? tierWord : tr('cost.empty'));
      } else {
        push(reason !== null ? reason : tierWord,
          tr(pricing.peak === true ? 'tier.nextOffPeak' : 'tier.nextPeak') + ' ' + countdown(remaining));
      }

      if (session !== null && session !== undefined && session.calls > 0) {
        push(tr('detail.total'), cny(session.costCny) + '  ·  ' + usd(session.costUsd));
        // A subagent or agent-team conversation splits the total into what this
        // session spent and what the sessions under it spent. Without the split
        // the total would look like it came from nowhere.
        const subagentCost = typeof session.subagentCostCny === 'number' ? session.subagentCostCny : 0;
        if (subagentCost > 0) {
          const count = typeof session.subagents === 'number' ? session.subagents : 0;
          // A Team figure reads as teammates, not as delegated subsessions.
          const isTeam = Array.isArray(session.members) && session.members.length > 1;
          push(tr('detail.ownCost'), cny(session.ownCostCny));
          push(tr(isTeam ? 'detail.teamCost' : 'detail.subagentCost'), cny(subagentCost) + '  ×' + String(count));
        }
        if (Array.isArray(session.members) && session.members.length > 1) {
          push(tr('detail.teamRoster'), memberLines(session.members));
        }
        push(tr('detail.peakCost'), cny(session.peakCostCny));
        push(tr('detail.offPeakCost'), cny(session.offPeakCostCny));
        if (Array.isArray(session.inFlight) && session.inFlight.length > 0) {
          push(tr('detail.inFlight'), session.inFlight.map((call) => call.model || '?').join(', '), true);
        }
      } else {
        push(tr('detail.total'), tr('cost.empty'));
      }

      // Current rates, promoted into the panel's own grid: a full-width heading
      // row, then one label/value row per bucket so the names and the figures
      // share the panel's columns (a nested grid would sit in the middle of the
      // value cell instead of filling it), and a full-width unit footer.
      if (rates !== null) {
        rows.push(React.createElement('dt', {
          key: 'rates-head',
          className: 'dac-section',
        }, tr('detail.rates')));
        /** One rate row: bucket name on the left, price on the right. */
        const rateRow = (name, price) => {
          rowKey += 1;
          rows.push(React.createElement('dt', { key: 'k' + rowKey }, name));
          rows.push(React.createElement('dd', { key: 'v' + rowKey }, '¥' + price));
        };
        rateRow(tr('rate.cacheHit'), rates.cacheHitCny);
        rateRow(tr('rate.cacheMiss'), rates.cacheMissCny);
        rateRow(tr('rate.output'), rates.outputCny);
        rows.push(React.createElement('dt', {
          key: 'rates-unit-head',
          className: 'dac-section dac-section-visually-hidden',
        }, ''));
        rows.push(React.createElement('dd', { key: 'rates-unit', className: 'dac-rate-unit' }, tr('rate.unit')));
      }

      const total = session !== null && session !== undefined && session.calls > 0
        ? React.createElement('span', { className: 'dac-titleValue' }, cny(session.costCny) + ' · ' + usd(session.costUsd))
        : null;
      return [
        titleRow(tr('cost.title'), total),
        React.createElement('div', { className: 'dac-rule', 'aria-hidden': true }),
        React.createElement('dl', { className: 'dac-details' }, rows),
      ];
    }

    /* ---------------------------------------------------------------- *
     * Package
     * ---------------------------------------------------------------- */

    return {
      inject: ['slots', 'timer'],
      apply(ctx) {
        const locale = ctx.get('locale');
        /** Translate through the client locale service, falling back to the bundled zh dictionary. */
        const bound = locale === undefined ? null : locale.bind('dsh-api-cost');
        const t = (key, params) => {
          const fallback = ZH[key] === undefined ? key : ZH[key];
          if (bound === null) return fill(fallback, params ?? {});
          const rendered = bound(key, params);
          // The service falls back to the raw key when a namespace is missing.
          return rendered === key ? fill(fallback, params ?? {}) : rendered;
        };
        if (locale !== undefined) {
          ctx.effect(() => locale.register('dsh-api-cost', 'zh', ZH));
          ctx.effect(() => locale.register('dsh-api-cost', 'en', EN));
        }

        ctx.effect(() => {
          const style = document.createElement('style');
          style.dataset.plugin = 'dsh-api-cost';
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => { if (style.parentNode !== null) style.parentNode.removeChild(style); };
        }, 'dsh-api-cost: styles');

        /* ------------------------------------------------------------ *
         * Shared snapshot store (one poller for every mounted widget)
         * ------------------------------------------------------------ */

        /** Latest snapshot; its identity changes only when a poll lands. */
        let snapshot = null;
        /** Shared wall clock, advanced by the ticker without a new snapshot. */
        let clock = Date.now();
        let error = null;
        let subscribers = 0;
        let stopTick = null;
        let stopPoll = null;
        /**
         * Session an HTTP request is currently in flight for, or null when idle.
         * Tracked per session so switching sessions never has its refresh
         * swallowed by a slower request for the session that just left.
         */
        let fetchingSession = null;
        /** Session the widgets currently want; a response for any other is dropped. */
        let wantedSession = null;
        /** Session id the current snapshot belongs to. */
        let boundSession = null;
        const listeners = new Set();

        /** Wake every mounted widget. */
        function emit() {
          for (const listener of Array.from(listeners)) {
            try { listener(); } catch (err) { console.error('[dsh-api-cost] listener failed', err); }
          }
        }

        /**
         * Fetch the snapshot for one session.
         * @param {string} sessionId - session to report.
         */
        function refresh(sessionId, force) {
          wantedSession = sessionId;
          // A recount wants the Host to re-resolve the delegation tree instead of
          // reusing its short cache, and must not be swallowed by an in-flight
          // poll for the same session.
          if (force === true) fetchingSession = null;
          if (fetchingSession === sessionId) return;
          fetchingSession = sessionId;
          const controller = typeof AbortController === 'function' ? new AbortController() : null;
          const timer = controller === null ? null : setTimeout(() => controller.abort(), 8000);
          const query = sessionId === '' ? '' : '?session=' + encodeURIComponent(sessionId)
          const url = API + query + (force === true ? (query === '' ? '?force=1' : '&force=1') : '');
          fetch(url, { headers: { accept: 'application/json' }, signal: controller === null ? undefined : controller.signal })
            .then((response) => {
              if (!response.ok) throw new Error('HTTP ' + response.status);
              return response.json();
            })
            .then((body) => {
              if (fetchingSession === sessionId) fetchingSession = null;
              if (timer !== null) clearTimeout(timer);
              if (body === null || typeof body !== 'object' || body.ok !== true) throw new Error('malformed snapshot');
              // A late response for a session nobody is showing must not
              // overwrite the one on screen.
              if (wantedSession !== sessionId) return;
              error = null;
              boundSession = sessionId;
              clock = Date.now();
              snapshot = body;
              emit();
            })
            .catch((err) => {
              if (fetchingSession === sessionId) fetchingSession = null;
              if (timer !== null) clearTimeout(timer);
              if (wantedSession !== sessionId) return;
              error = String(err && err.message ? err.message : err);
              console.warn('[dsh-api-cost] snapshot fetch failed:', error);
              emit();
            });
        }

        /** Start the shared ticker + poller once. */
        function startTimers() {
          if (stopTick === null) {
            stopTick = ctx.interval(() => {
              clock = Date.now();
              if (snapshot !== null) emit();
            }, 1000);
          }
          if (stopPoll === null) {
            stopPoll = ctx.interval(() => {
              if (wantedSession !== null) refresh(wantedSession);
            }, 2500);
          }
        }

        /** Stop both once nothing is mounted. */
        function stopTimers() {
          if (stopTick !== null) { stopTick(); stopTick = null; }
          if (stopPoll !== null) { stopPoll(); stopPoll = null; }
        }

        /* ------------------------------------------------------------ *
         * Refresh (recount from the durable logs)
         * ------------------------------------------------------------ */

        /**
         * Ask the Host to replay the session logs for the current scope. The
         * logs hold every call that ever settled — including the ones from
         * before the plugin loaded — so this is what fills the gaps in.
         * @param {string} sessionId - session whose scope to recount.
         * @param {'auto'|'self'|'tree'|'team'} scope - the scope the panel shows.
         * @returns {Promise<object>} the Host's reconcile report.
         */
        async function requestReconcile(sessionId, scope) {
          // GET, not POST: the desktop shell's transport answers an unknown
          // method on an unregistered path with 405, and this action is
          // idempotent, so the method buys nothing but risk.
          const url = API + '/reconcile?session=' + encodeURIComponent(sessionId) + '&scope=' + encodeURIComponent(scope);
          const response = await fetch(url, { headers: { accept: 'application/json' } });
          const body = await response.json().catch(() => null);
          if (body === null || typeof body !== 'object') throw new Error('HTTP ' + response.status);
          if (body.ok !== true) throw new Error(String(body.reason ?? ('HTTP ' + response.status)));
          return body;
        }

        /* ------------------------------------------------------------ *
         * Widget
         * ------------------------------------------------------------ */

        /**
         * Trigger-anchored dialog seat: open state, viewport-clamped placement
         * above the trigger, outside-pointer and Escape dismissal. Mirrors the
         * shipped stat dialogs.
         * @returns {{open: boolean, setOpen: (next: boolean) => void, rootRef: object, panelRef: object, pos: object|null}} the seat.
         */
        function useStatDialog() {
          const [open, setOpen] = React.useState(false);
          const rootRef = React.useRef(null);
          const panelRef = React.useRef(null);
          const pos = useAnchoredPosition({ open, anchorRef: rootRef, panelRef, ...PLACEMENT });
          useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef);
          React.useEffect(() => {
            if (!open) return undefined;
            const onKeyDown = (event) => { if (event.key === 'Escape') setOpen(false); };
            document.addEventListener('keydown', onKeyDown);
            return () => document.removeEventListener('keydown', onKeyDown);
          }, [open, setOpen]);
          return { open, setOpen, rootRef, panelRef, pos };
        }

        /**
         * Mount-time subscription: join the shared store, start the poller, and
         * always refetch on mount so a first poll that raced the Host route
         * self-heals instead of parking on a placeholder.
         * @param {string} sessionId - session this widget reports.
         * @returns {{snapshot: object|null, clock: number, error: string|null, reread: (force?: boolean) => void}} the store view.
         */
        function useCostStore(sessionId) {
          const [, force] = React.useReducer((n) => n + 1, 0);
          React.useEffect(() => {
            const listener = () => force();
            listeners.add(listener);
            subscribers += 1;
            startTimers();
            if (snapshot === null || error !== null || boundSession !== sessionId) refresh(sessionId);
            return () => {
              listeners.delete(listener);
              subscribers -= 1;
              if (subscribers <= 0) { subscribers = 0; stopTimers(); }
            };
          }, [sessionId]);
          // `reread` exists so an action that changes the figure (a recount) can
          // pull the new value immediately instead of waiting for the next poll.
          return { snapshot, clock, error, reread: (force) => refresh(sessionId, force === true) };
        }

        /**
         * Pill label. Mirroring the shipped pills, the tier is a word rather
         * than a colour alone, so the state survives a colour-blind reading; it
         * rides in the compact 峰 / 谷 form to keep the pill short, while the
         * dialog spells both tiers out.
         * @param {object|null} body - latest snapshot.
         * @param {(key: string, params?: object) => string} tr - translate.
         * @returns {string|object} the label text, or an element when split.
         */
        function labelFor(body, tr) {
          if (body === null) return '';
          const session = body.session;
          const tier = body.pricing !== null && body.pricing !== undefined && body.pricing.peak === true
            ? tr('tier.peakShort')
            : tr('tier.idleShort');
          if (session === null || session === undefined || session.calls === 0) {
            return React.createElement('span', null, tier);
          }
          return React.createElement('span', null,
            cny(session.costCny),
            React.createElement('span', { className: 'dac-sep', 'aria-hidden': true }, '·'),
            tier);
        }

        /**
         * Plain-text form of the label, for the accessible name.
         * @param {object|null} body - latest snapshot.
         * @param {(key: string, params?: object) => string} tr - translate.
         * @returns {string} label text without markup.
         */
        function labelText(body, tr) {
          if (body === null) return '';
          const session = body.session;
          const tier = body.pricing !== null && body.pricing !== undefined && body.pricing.peak === true
            ? tr('tier.peakShort')
            : tr('tier.idleShort');
          if (session === null || session === undefined || session.calls === 0) return tier;
          return cny(session.costCny) + ' · ' + tier;
        }

        /**
         * The pill and, while open, its portaled dialog.
         *
         * Every hook runs unconditionally before any branch: a hook skipped on
         * some renders changes the hook count and trips React #310.
         * @param {object} props - `{ sessionId }`.
         * @returns {object} the anchor span (with the panel portaled beside it).
         */
        function CostPill(props) {
          const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
          const store = useCostStore(sessionId);
          const seat = useStatDialog();
          // `idle | running | done | error` plus what the last recount reported.
          const [refresh, setRefresh] = React.useState({ state: 'idle', recovered: 0, sessions: 0, message: '' });
          const body = store.snapshot;
          const session = body === null ? null : body.session;
          const peak = body !== null && body.pricing !== null && body.pricing !== undefined && body.pricing.peak === true;
          const label = labelFor(body, t);
          const labelPlain = labelText(body, t);

          const panel = seat.open
            ? React.createElement('div', {
              ref: seat.panelRef,
              className: 'dac-panel' + (createPortal === null ? ' dac-panel--inline' : ' dac-panel--floating'),
              role: 'dialog',
              'aria-label': t('cost.title'),
              style: seat.pos === null ? MEASURE_STYLE : seat.pos,
            }, panelChildren(body, store.clock, t).concat([
              React.createElement('div', { className: 'dac-footer', key: 'footer' },
                React.createElement('button', {
                  type: 'button',
                  className: 'dac-action' + (refresh.state === 'running' ? ' dac-action--busy' : ''),
                  onClick: () => runReconcile(),
                  disabled: refresh.state === 'running',
                  title: t('action.refreshHint'),
                  'aria-label': t('action.refresh'),
                },
                React.createElement(RefreshMark, null),
                React.createElement('span', null, refresh.state === 'running' ? t('action.refreshing') : t('action.refresh'))),
                refresh.state === 'idle' ? null : React.createElement('span', {
                  className: 'dac-actionNote' + (refresh.state === 'error' ? ' dac-actionNote--error' : ''),
                  role: refresh.state === 'error' ? 'alert' : 'status',
                }, refresh.state === 'error'
                  ? String(refresh.message)
                  : refresh.recovered > 0
                    ? t('action.recovered').replace('{count}', String(refresh.recovered))
                    : t('action.refreshed'))),
            ]))
            : null;

          /** Recount from the logs, then refresh the snapshot so the panel shows it. */
          function runReconcile() {
            if (refresh.state === 'running') return;
            setRefresh({ state: 'running', recovered: 0, sessions: 0, message: '' });
            const scope = body !== null && typeof body.scope === 'string' ? body.scope : 'auto';
            requestReconcile(sessionId, scope === 'team' ? 'team' : scope === 'self' ? 'self' : 'tree')
              .then((report) => {
                setRefresh({
                  state: 'done',
                  recovered: typeof report.recovered === 'number' ? report.recovered : 0,
                  sessions: typeof report.scanned === 'number' ? report.scanned : 0,
                  message: '',
                });
                // A recount changes the figure, so re-read it rather than
                // waiting for the next poll (and force the tree read, so a
                // delegation that just settled shows up immediately).
                store.reread(true);
              })
              .catch((err) => {
                setRefresh({ state: 'error', recovered: 0, sessions: 0, message: String(err && err.message ? err.message : err) });
              });
          }

          return React.createElement('span', { className: 'dac-root' },
            React.createElement('span', { ref: seat.rootRef, className: 'dac-anchor' },
              React.createElement('button', {
                type: 'button',
                className: 'dac-pill' + (peak ? ' dac-pill--peak' : ''),
                'aria-haspopup': 'dialog',
                'aria-expanded': seat.open,
                // The shipped pills name the trigger with exactly its visible
                // text; dropping the tier word would hide peak/off-peak from a
                // screen reader.
                'aria-label': labelPlain === '' ? t('cost.title') : labelPlain,
                title: store.error === null ? undefined : store.error,
                onClick: () => seat.setOpen(!seat.open),
              },
              React.createElement(CostMark, null),
              label === '' ? null : React.createElement('span', { className: 'dac-label' }, label))),
            panel === null || createPortal === null ? panel : createPortal(panel, document.body));
        }

        /* ------------------------------------------------------------ *
         * Slot
         * ------------------------------------------------------------ */

        const slots = ctx.get('slots');
        if (slots === undefined) {
          console.warn('[dsh-api-cost] no slots service; cost pill not mounted');
          return;
        }
        ctx.effect(() => slots.inject('conversation.composer.dock', () => slots.register({
          name: 'conversation.composer.dock',
          id: 'api-cost',
          order: 20,
        }, CostPill)), 'dsh-api-cost: dock entry');
      },
    };
  },
});
