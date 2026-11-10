/** One TS string: platform theme tokens, tariff-ledger panel geometry, no CSS bundle. */
export const CSS = `
/* The dual tariff, as tokens. The band keeps the theme's saturated static steps;
   the small words take a darker/lighter ink so 11-12px text clears AA contrast. */
.dac-root,.dac-panel{--dac-peak:var(--dsw-static-amber-600);--dac-offpeak:var(--dsw-static-deepseek-500);--dac-peak-ink:color-mix(in srgb,var(--dsw-static-amber-600) 70%,var(--dsw-alias-label-primary));--dac-offpeak-ink:color-mix(in srgb,var(--dsw-alias-state-business-primary) 85%,var(--dsw-alias-label-primary));--dac-quiet:color-mix(in srgb,var(--dsw-alias-label-tertiary) 82%,var(--dsw-alias-label-primary));--dac-divider:color-mix(in srgb,var(--dsw-alias-label-tertiary) 42%,transparent);font-variant-numeric:tabular-nums}
/* Only the saturated band steps need a per-theme swap: the text inks are mixed
   against label-primary, so they adapt to the theme on their own. */
body[data-ds-dark-theme] .dac-root,body[data-ds-dark-theme] .dac-panel{--dac-peak:var(--dsw-static-amber-400);--dac-offpeak:var(--dsw-static-deepseek-400);--dac-peak-ink:var(--dsw-static-amber-400)}
.dac-root{box-sizing:border-box;min-width:0;max-width:100%;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}
/* Quiet at rest: only the tier word carries a tariff colour, never the whole capsule. */
.dac-pill{box-sizing:border-box;min-width:0;max-width:100%;overflow:hidden;color:var(--dac-quiet);font:inherit;line-height:inherit;white-space:nowrap;background:none;border:0;border-radius:999px;align-items:center;gap:5px;padding:1px 8px;display:inline-flex;cursor:pointer}
.dac-pill svg{flex:none;width:14px;height:14px}
.dac-pill:hover,.dac-pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dac-pillAmount{color:var(--dsw-alias-label-secondary);font-weight:500}
.dac-pillHold{color:var(--dsw-alias-label-secondary)}
.dac-pillDivider{flex:none;width:1px;height:10px;background:var(--dac-divider)}
.dac-pillPartial{color:var(--dac-quiet);font-size:11px;line-height:1}
.dac-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
/* Tariff ink, used by the tier word, the band legend and the pill alike. */
.dac-peak{color:var(--dac-peak-ink)}
.dac-off{color:var(--dac-offpeak-ink)}
.dac-tierWord,.dac-legendWord,.dac-pillTier{font-weight:500}
.dac-panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:min(400px,calc(100vw - 24px));max-height:calc(100dvh - max(12px,var(--dsh-frame-top-clearance,0px) + 20px) - 12px);overflow-y:auto;backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:13px 16px 10px;font-size:12px;line-height:18px}
.dac-panel--floating{position:fixed}
.dac-head,.dac-footer{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dac-footer{margin-top:7px}
.dac-headTitle,.dac-meta,.dac-heroUsd{color:var(--dac-quiet);font-size:11.5px;line-height:16px}
.dac-meta{margin-top:3px;line-height:15px}
.dac-tier{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:12px;line-height:17px}
/* The little 3px tariff tick is the panel's only repeated mark (tier + band ends). */
.dac-tick{flex:none;width:3px;height:10px;border-radius:1.5px;background:var(--dac-peak)}
.dac-tick--off{background:var(--dac-offpeak)}
/* Hero money: the one brand-font moment in the panel. */
.dac-hero{display:flex;align-items:baseline;gap:8px;margin-top:8px}
.dac-heroCny{font-family:var(--dsw-font-family-brand,inherit);font-size:29px;font-weight:500;letter-spacing:-.02em;line-height:1;color:var(--dsw-alias-label-primary);white-space:nowrap}
.dac-heroSymbol{font-size:.62em;vertical-align:.45em;margin-right:1px}
/* The tariff band: money split by the two rates. The panel's only saturated block. */
.dac-band{display:flex;margin-top:10px;height:4px;border-radius:2px;overflow:hidden;background:var(--dsw-alias-border-l2)}
.dac-bandPeak{background:var(--dac-peak)}
.dac-bandOff{background:var(--dac-offpeak)}
.dac-legend{display:flex;justify-content:space-between;gap:12px;margin-top:5px;font-size:11.5px;line-height:15px}
.dac-legendGroup{display:inline-flex;align-items:center;gap:5px;min-width:0}
.dac-rule{border-top:.5px solid var(--dsw-alias-border-l2);margin-top:9px}
/* Quiet ledger body: no cards, only hairlines and rhythm. */
.dac-split,.dac-rates,.dac-roster,.dac-gate{margin-top:8px}
.dac-split{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.dac-splitLabel,.dac-noteLabel,.dac-rosterLabel{color:var(--dac-quiet);font-size:11px;line-height:15px}
.dac-splitLabel{display:block}
.dac-splitMoney{display:block;font-size:13.5px;line-height:17px;color:var(--dsw-alias-label-primary)}
.dac-note{display:flex;flex-wrap:wrap;gap:2px 8px;margin-top:8px;font-size:11px;line-height:15px}
.dac-noteLabel{flex:none}
.dac-noteValue{overflow-wrap:anywhere}
/* Coverage: the status word comes first and is never only a colour. */
.dac-covWord{flex:none}
.dac-covWord--warn{color:var(--dsw-alias-label-primary);font-weight:500}
.dac-covWord--bad{color:var(--dsw-alias-state-error-primary)}
.dac-covWhy{flex:1 1 60%;min-width:0;overflow-wrap:anywhere}
.dac-unit{color:var(--dac-quiet);font-size:11px;line-height:14px;text-align:right}
.dac-rateRow,.dac-member{display:flex;align-items:baseline;justify-content:space-between;gap:6px;font-size:11.5px;line-height:16px}
.dac-roster{display:grid;grid-template-columns:1fr 1fr;column-gap:14px}
.dac-rosterLabel{grid-column:1 / -1;margin-bottom:1px}
.dac-rosterEmpty{grid-column:1 / -1}
/* Names get a stable column so the money always lands in the same two columns. */
.dac-member{line-height:15px}
.dac-memberName{flex:none;width:88px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dac-memberMoney{flex:1;text-align:right}
/* Gate block: one 2px accent, tied to the tier it is acting in (peak while holding). */
.dac-gate{border-left:2px solid var(--dac-offpeak);padding-left:11px}
.dac-gate--hold{border-left-color:var(--dac-peak)}
.dac-gateHead{display:flex;align-items:center;justify-content:space-between;gap:10px}
.dac-gateTitle{font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-primary)}
.dac-gateControl{display:inline-flex;align-items:center;gap:4px}
.dac-gateNote{font-size:11px;color:var(--dac-quiet)}
.dac-gateScope{margin-top:1px;font-size:11.5px;line-height:15px;color:var(--dac-quiet)}
/* An inherited position is explained once, quietly, under the scope line: the
   scope above still describes what a switch flipped here would govern. */
.dac-gateFollow{margin-top:1px;font-size:11px;line-height:15px;color:var(--dac-quiet);overflow-wrap:anywhere}
.dac-gateStatus{margin-top:4px;font-size:11.5px;line-height:16px}
.dac-gateHint{font-size:11px;line-height:15px;color:var(--dac-quiet)}
.dac-statusRow{display:flex;justify-content:space-between;gap:12px}
/* The quiet second line of a hold: elapsed, the child-session share, and the
   other-conversation line wrap independently instead of forcing one row. */
.dac-gateMeta{display:flex;flex-wrap:wrap;gap:2px 12px;margin-top:1px}
.dac-statusStrong{color:var(--dsw-alias-label-primary)}
.dac-statusQuiet{color:var(--dac-quiet);font-size:11px;white-space:nowrap}
.dac-gateError,.dac-footerError{font-size:11px;line-height:15px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.dac-gateError{margin-top:4px}
.dac-footerError{flex:1;min-width:0}
/* Off-peak switch: knob position and the state word carry the state; colour reinforces. */
.dac-switch{appearance:none;font:inherit;font-size:11.5px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:none;border:0;border-radius:6px;align-items:center;gap:6px;padding:2px 4px;margin:-2px -4px -2px 0;display:inline-flex}
.dac-switch:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dac-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dac-switch:disabled{cursor:default}
.dac-switchTrack{box-sizing:border-box;position:relative;flex:none;width:30px;height:17px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 90%,transparent);transition:background-color .12s linear}
.dac-switchKnob{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:var(--dsw-specific-menu);transition:transform .12s ease}
.dac-switch--on .dac-switchTrack{background:var(--dsw-alias-brand-primary)}
.dac-switch--on .dac-switchKnob{transform:translateX(13px)}
.dac-switchWord{white-space:nowrap}
.dac-switchBadge{color:var(--dac-quiet);font-size:11px}
.dac-action{appearance:none;font:inherit;font-size:11.5px;color:var(--dac-quiet);cursor:pointer;background:none;border:0;border-radius:6px;padding:2px 6px;display:inline-flex}
.dac-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dac-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dac-action:disabled{cursor:default;opacity:.65}
.dac-action--busy{animation:dac-spin .9s linear infinite}
@keyframes dac-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.dac-switchTrack,.dac-switchKnob{transition:none}.dac-action--busy{animation:none}}
`
