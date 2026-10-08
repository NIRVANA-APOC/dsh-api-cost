/** One TS string: platform theme tokens, inherited stat-pill geometry, no CSS bundle. */
export const CSS = `
.dac-root { box-sizing: border-box; min-width: 0; max-width: 100%; font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px); line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px)); display: inline-flex; }
.dac-anchor { min-width: 0; display: inline-flex; }
.dac-pill { box-sizing: border-box; corner-shape: round; max-width: 100%; color: var(--dsw-alias-label-tertiary); font: inherit; font-variant-numeric: tabular-nums; line-height: inherit; white-space: nowrap; background: none; border: none; border-radius: 999px; align-items: center; gap: 6px; padding: 1px 8px; display: inline-flex; cursor: pointer; }
.dac-pill svg { flex: none; width: 14px; height: 14px; }
.dac-pill:hover, .dac-pill[aria-expanded='true'] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.dac-pill--peak { color: var(--dsw-alias-state-warn-primary); }
.dac-label { text-overflow: ellipsis; min-width: 0; overflow: hidden; }
.dac-sep { color: var(--dsw-alias-separator-primary); margin: 0 6px; }
.dac-panel { z-index: 1100; box-sizing: border-box; border-radius: var(--dsw-radius-lg); background: var(--dsw-specific-menu); width: max-content; min-width: min(300px, 100vw - 24px); max-width: min(440px, 100vw - 24px); max-height: calc(100dvh - max(12px, var(--dsh-frame-top-clearance, 0px) + 20px) - 12px); overflow-y: auto; backdrop-filter: var(--dsw-menu-backdrop-filter); --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); box-shadow: var(--dsw-elevation-prominent); color: var(--dsw-alias-label-secondary); cursor: default; border: 0; padding: 16px; font-size: 12px; line-height: 18px; }
.dac-panel--floating { position: fixed; }
.dac-title { color: var(--dsw-alias-label-primary); justify-content: space-between; gap: 16px; margin-bottom: 8px; font-weight: 500; display: flex; }
.dac-titleLabel { align-items: center; gap: 6px; min-width: 0; display: inline-flex; }
.dac-titleLabel svg { flex: none; width: 14px; height: 14px; }
.dac-titleValue { font-variant-numeric: tabular-nums; }
.dac-rule { border-top: 0.5px solid var(--dsw-alias-border-l2); margin-bottom: 10px; }
.dac-details { color: var(--dsw-alias-label-tertiary); grid-template-columns: minmax(76px, auto) minmax(0, 1fr); gap: 6px 16px; margin: 0; display: grid; }
.dac-details dt, .dac-details dd { min-width: 0; margin: 0; }
.dac-details dd { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; text-align: right; }
.dac-details dd.dac-wrap { overflow-wrap: anywhere; }
.dac-details .dac-section { grid-column: 1 / -1; color: var(--dsw-alias-label-tertiary); text-align: left; margin-top: 6px; }
.dac-roster { display: grid; gap: 4px; }
.dac-footer { justify-content: space-between; align-items: center; gap: 12px; margin-top: 12px; display: flex; }
.dac-action { appearance: none; font: inherit; font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer; background: none; border: 0; border-radius: var(--dsw-radius-sm, 6px); align-items: center; gap: 4px; padding: 2px 6px; display: inline-flex; }
.dac-action:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dac-action:focus-visible, .dac-pill:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dac-action:disabled { cursor: default; opacity: 0.65; }
.dac-action svg { flex: none; width: 13px; height: 13px; }
.dac-action--busy svg { animation: dac-spin 900ms linear infinite; }
.dac-actionNote { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.dac-actionNote--error { color: var(--dsw-alias-state-error-primary); }
@keyframes dac-spin { to { transform: rotate(360deg); } }
`
