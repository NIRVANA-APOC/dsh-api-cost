# Limitations

`dsh-api-cost` is an estimate, not a provider bill: it prices reported token counts
at the published DeepSeek rates and cannot see grants, discounts, retry billing or
third-party routing. The lists below are the complete set of things it deliberately
does not promise — first for the estimate itself, then for the Avoid-peak switch.

## What it does not promise

- **It is an estimate, not a bill.** Only published rates and reported token
  counts are used; grants, discounts, retry billing and third-party routing are
  invisible here.
- **Only official DeepSeek models are priced.** An unknown id is recorded as
  `unknown-model` with zero money rather than guessed.
- **A settlement is billed at its settlement time.** A call that crosses a
  boundary is not split proportionally, because the official documentation defines
  no such split.
- **Unreadable sessions are reported, not guessed**: they appear as
  `session-unavailable` with `coverage.status = partial`, and a traversal that
  exceeds the 400-session budget is marked `scope-truncated`.
- **A malformed usage report is never billed.** The call is counted as an attempt
  and flagged `invalid-usage` or `missing-usage`, but it adds no money and no
  tokens, so a total never contains spend that no priced call explains.
- **The Pro routing caveat is a rate-card note, not a coverage gap.** This
  repository records that official billing for `deepseek-v4-pro` after 2026-09-14
  12:00 +08:00 is disputed (whether those requests are served — and billed — as
  Flash, or keep the Pro column). The plugin cannot verify the provider's policy,
  so it prices the published Pro column and says so. That note appears **only when
  the scope actually priced that model**; other card caveats (missing holiday
  data, calls predating the card) always show, because they shape the rates and
  period on display.
- **Fork semantics are explicit**: a forked child's own figure excludes the
  inherited prefix, so ancestors are not billed twice when you look at a branch.

## And about the Avoid-peak switch specifically

- **It holds calls; it does not split them.** A request that is already in flight
  when peak begins is unaffected, and a call that starts off-peak but settles in
  peak is still billed at peak, because the settlement instant decides the rate and
  it cannot be known before dispatch.
- **A hold can be long.** A weekday window is up to four hours (09:00–12:00,
  14:00–18:00), so the session will look idle while the pill explains why. Nothing
  is lost: the request is sent unchanged the moment the window closes, and pressing
  stop releases it at once.
- **The switch is per conversation tree; the process is the boundary.** Two DSH
  processes hold their own parked requests. Manual choices are stored per session
  id in one state file, so sessions of the same profile share the file while the
  in-flight holds never leave the process that created them.
- **Unrelated conversations are untouched; a child session can override.** A
  tree's switch never reaches another conversation, and a subagent follows its
  parent by default while a manual choice of its own wins for its own subtree.
- **Delegation lineage is runtime state, never persisted.** In a fresh process the
  conversation tree is rebuilt as sessions get announced or looked up; a session
  the plugin has not observed yet is treated as a root and follows only its
  own/default choice, so switching a parent covers an already-existing child only
  once that link is observable.
- **Its durable state is a file, not a database.**
  `<dsh home>/state/dsh-api-cost/gate.json`, written atomically as a versioned map
  of manual per-session choices (bounded to 512 stored sessions, the oldest changed
  one evicted first when full). Memory is bounded too: at most 1024 session records
  and 4096 parent links, so under extreme pressure an inactive record or link can
  be evicted — a manual choice comes back from the durable file, and a link is
  re-learned from live sessions. If the file cannot be read or written, the
  switches still work for the current run and the panel reports the position as not
  durable rather than failing. A version-1 file written by the process-global
  design is ignored, never guessed at.
- **Failures fail open.** The gate is built so that it cannot break a model call:
  an unreadable clock, an unreadable tier or a timer that will not arm all release
  the request immediately. The failure mode of this feature is "you paid peak
  prices", never "your session stopped".

## See also

- [off-peak-gate.md](./off-peak-gate.md) — the gate's frozen interface and the
  reasoning behind each clause.
- [verification-gate.md](./verification-gate.md) — the claim-by-claim verification
  record, including the falsification runs.
- [configuration.md](./configuration.md) — the `gate.*` keys referenced above.
- [dsh-api-cost README](../README.md) — install, usage and the rate card.
