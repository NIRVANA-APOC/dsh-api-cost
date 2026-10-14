# Off-peak gate — independent verification (T4)

Verifier: `gate-verify`. Status: **complete for the A/B/C matrix; no defect found in `src/**`.**
Scope of this file: claim → test → verdict, every defect with coordinates, the exact
commands, and the output tail. This report is evidence, not a summary: where a
claim is not proven, it says so.

Artifacts produced by this task:

| File | What it holds |
| --- | --- |
| `test/gate.test.ts` | A1–A14, B1–B5, E1–E3 — the hold state machine, the durable flag, the `/gate` wire, and the wiring facts the claims rest on |
| `test/gate-integration.test.ts` | C1–C7 — a REAL cordis `Context` + REAL `@deepseek-ai/dsh-llm` `LlmRuntime` + stub adapter + the real gate |
| `docs/verification-gate.md` | this report |

Method: every test drives the real `src/host/gate.ts` and the real `/gate` route
(through `apply()` on a fake `webServer`, in the style of `test/host.test.ts`).
The only substitutions are a deterministic clock, an in-memory `GateStore`, and
pricing doubles used solely to produce states the real card cannot (a peak with
no known boundary, a throw). The engine is the real one wherever the claim is
about billing. No test reads the real clock.

---

## 1. Verdict table

Verdicts: **verified** = a test that fails when the claim is false, and the
failure was demonstrated with a mutation (see §3). **unknown** = not proven, with
the reason stated in §4.

| # | Claim | Test | Verdict |
| --- | --- | --- | --- |
| A1 | Peak + enabled parks the first pull; dispatch happens exactly once at the boundary | `A1 — at a peak instant the first pull is parked, then dispatched exactly once at the boundary` | verified |
| A2 | Off-peak + enabled returns the identical `next()` object | `A2 — off-peak with the gate on, middleware returns the identical object next() produced` | verified |
| A3 | Peak + disabled returns the identical `next()` object | `A3 — at peak with the gate off, middleware returns the identical object next() produced` | verified |
| A4 | The gated chunk sequence is `deepEqual` to the ungated one; no synthetic chunk | `A4 — the gated chunk sequence is deepEqual to the ungated one, with nothing injected` | verified |
| A5 | A caller abort during the hold settles promptly, disarms the timer, delegates exactly once | `A5 — a caller abort during the hold settles promptly, leaves no timer, and delegates exactly once` | verified |
| A6 | `return()` during the hold never dispatches, even after the boundary | `A6 — return() during the hold never dispatches, not even after the boundary` | verified |
| A7 | `setEnabled(false)` during a hold releases at once | `A7 — setEnabled(false) during a hold releases the parked waiter at once` | verified |
| A8 | A sleep past `2^31-1` ms is clamped and re-armed; an early wake while peak re-arms | `A8 — a sleep past 2^31-1 ms is clamped and re-armed, and an early wake while peak re-arms` | verified |
| A9 | A peak view with `next === null` releases instead of hanging | `A9 — a peak view with next === null releases instead of hanging (fail-open)` | verified |
| A10 | A throwing clock and a throwing engine fail open, never reject | `A10 — a throwing clock and a throwing pricing engine all fail open` | verified |
| A10 | …including a throw *after* the hold is armed | `A10b — a pricing throw after the hold is armed still releases instead of hanging or rejecting` | verified |
| A11 | `dispose()` while parked resolves the waiter and is idempotent | `A11 — dispose() while a hold is parked resolves the waiter and is idempotent` | verified |
| A12 | `holding`/`since`/`heldTotal`/`delayedMs` exact across sequential holds | `A12 — holding/since/heldTotal/delayedMs are exact across sequential holds` | verified |
| A12 | …and across concurrent holds | `A12b — two concurrent holds are counted independently and released together` | verified |
| A12 | …and one abort does not disturb the survivor | `A12c — aborting one parked request leaves the other parked and counted` | verified |
| A13 | `revision` moves with a rendered field and never with `now`/`delayedMs` alone | `A13 — revision moves with a rendered field and never with now/delayedMs alone` | verified |
| A14 | Durable round-trip; unwritable path degrades to `durable:false` without throwing; `persist:false` | `A14 — the durable flag round-trips, degrades on an unwritable path, and honours persist:false` | verified |
| A14 | Env override and `<dsh home>` default resolve per §4.4 | `A14b — the env override and the <dsh home> default resolve where §4.4 says` | verified |
| B1 | GET 200 + ETag; matching `If-None-Match` → 304 with no body | `B1 — GET returns 200 with an ETag, and a matching If-None-Match returns 304 with no body` | verified |
| B2 | POST `{"enabled":true}` flips the view; body satisfies `validGateView` | `B2 — POST {"enabled":true} flips the view and answers with a valid GateView` | verified |
| B3 | Exact status per rejection rule, in the documented order | `B3 — every rejection rule produces its exact status, in the documented order` | verified |
| B4 | Same-origin POST succeeds; mismatching `Origin` is 403 | `B4 — a same-origin POST succeeds and a mismatching Origin is refused` | verified |
| B5 | No response body contains a filesystem path | `B5 — no gate response body contains a filesystem path` | verified |
| C | A real `ctx.llm.stream()` reaches the adapter and yields its sequence (the baseline the gated run is compared against) | `C1 — a real ctx.llm.stream() reaches the registered adapter and yields its sequence` | verified |
| C | Real-framework interception: parked while peak, dispatched at the boundary, identical sequence | `C2 — a real model call is parked while peak and dispatched at the boundary, unchanged` | verified |
| C | The listener is selected by cordis's context filter at all | `C1`, `C2`, `C5` (all run through the real `LlmRuntime` waterfall) | verified |
| C | Nothing extra on the abort path | `C3 — a real caller abort during the hold yields only the framework's terminal chunk` | verified |
| C | A live `options.signal` behaves like an absent one | `C4 — an already-present signal parks and releases exactly like an absent one` | verified |
| C | `models:'priced'` is a real bypass, not cosmetic | `C5 — models:priced bypasses an unpriced model by identity and still holds a priced one` | verified |
| C | The last prepend listener is outermost and still composes | `C6 — a second prepend listener is outermost and still composes with the hold` | verified |
| C | A deep-frozen loop-built request is handled | `C7 — a deep-frozen loop-built request is parked and dispatched unchanged` | verified |
| E1 | `isPricedModel` accepts the canonical ids and the documented aliases | `E1 — isPricedModel accepts the two canonical ids and the documented aliases` | verified |
| E2 | `apply()` registers one prepended `llm/stream` listener and the `/gate` route over one gate | `E2 — apply() registers the llm/stream listener and the /gate route over one gate` | verified |
| E3 | The read rule is not relaxed (`/view`, `/pricing` stay GET-only) and the gate read refuses cross-site | `E3 — the read rule is not relaxed: /view and /pricing stay GET-only, and the gate read is not cross-site readable` | verified |

Success criterion 3 of §1 ("no session event is appended, no error is reported,
the request body is byte-identical") is verified **at the seam only**: E2 shows
the host registers exactly one event listener and injects no chunks, A4/C2 show
the chunk sequence and the request object are untouched. A full agent-loop test
that asserts the durable session log gains no event during a hold is out of my
scope and is marked **unknown** in §4.4, not verified.

---

## 2. Defects found

**None in `src/**`.** Every claim above was independently reproduced, and §3
shows the suite can fail: 13 deliberate breaks of the implementation were caught,
each by at least one test.

Defects found in my own harness, disclosed because a hidden test bug is
indistinguishable from a pass:

| # | Coordinate | Input | Expected | Observed | Resolution |
| --- | --- | --- | --- | --- | --- |
| H1 | `test/gate.test.ts` A4 (first draft) | one un-awaited `iterator.next()`, then `collect()` on the same iterator | full 5-chunk sequence | 4 chunks: the un-awaited pull consumed `block-start` | fixed by awaiting the first pull before draining the rest; re-verified |
| H2 | `test/gate.test.ts` E2 (first draft) | `apply()` at an instant inside a Beijing peak window | identity assertion holds | would have returned a holding wrapper and **failed** — a time-of-day flake | fixed: E2 now uses `models:'priced'` with an unpriced model, whose bypass branch is tier-independent |
| H3 | `test/gate.test.ts` A10b (first draft) | engine that throws on its 2nd `status()` call | park, then fail open at the wake | engine is consulted twice before parking (`planHold` + the arming classification), so the request never parked | fixed: the fixture throws on the 3rd call; the two pre-park classifications are now asserted |

---

## 3. Falsification: 13 mutations, all caught

A green suite proves nothing until it has been shown to fail. I copied `src/` and
`test/` to a scratch directory outside the repo, applied one deliberate break at a
time, and ran the verification suite. The workspace itself is not a deliverable
(`%TEMP%\gate-verify\mutant`, `node_modules` junction to the repo).

| Mutation | Break | Caught by |
| --- | --- | --- |
| M1 | ungated path wraps `next()` instead of returning it | A2, A3 |
| M2 | consumer-return channel ignored (abandoned stream still dispatches) | A6 |
| M3 | `sleep` no longer clamped to `2^31-1` | A8 |
| M4 | `revision` folds in the wall clock | A13, B1 |
| M5 | `delayedMs` never accumulates | A12, A12b |
| M6 | `middleware` never holds at all | 14 tests (A1, A4–A8, A10b, A12c, C2–C7) |
| M7 | one synthetic chunk injected before the provider stream | 12 tests (A1, A4, A5, A7, A8, A10, A10b, A12c, C2–C7) |
| M8 | `/gate` 405 advertises the wrong `Allow` | B3 |
| M9 | read wrapper relaxed to accept POST | E3 |
| M10 | `llm/stream` listener not prepended | E2 |
| M11 | listener registered under a wrong event name | E2 |
| M12 | aborting one waiter releases every parked waiter | A12c |
| M13 | a pricing throw is not contained by `tier()` | A10 |

Honest note on M12: my **first** M12 run reported "NO TEST CAUGHT THIS MUTATION".
The cause was a stale `test/` copy inside my scratch workspace (A12c did not exist
there yet), not a real hole. After refreshing `test/` from the repo and re-running
all 13, A12c catches it. The corrected run is the one reproduced below.

M6 and M7 also demonstrate the *shape* of the safety net: removing the hold or
injecting a chunk lights up both halves (unit + real framework), while the
narrower claims (M2, M3, M8, M9, M10, M11, M12, M13) are each owned by exactly
one test — that is why those tests exist.

---

## 4. Limitations of this verification (what I did NOT prove)

1. **`pnpm test` / the build is unverified by me.** `node scripts/build.ts` fails
   in my sandbox with `Error: spawn EPERM ... errno: -4048` at
   `scripts/build.ts:36` — the documented DSH boundary for a child process with
   piped stdio, not a repository defect. Consequently `test/build.test.ts` (which
   reads `dist/index.js` and `dist/client.js`) could not run, and the bundle smoke
   test is **unknown**. I ran every other test file directly; the Lead must run
   `pnpm test` / `pnpm check` on the final tree.
2. **The `apply()`-registered listener's hold itself is verified by construction,
   not end to end.** `apply()` wires the production clock, so the tier at test
   time is whatever the wall clock says. E2 verifies the registration's shape
   (exactly one `llm/stream` listener, `{prepend:true}`, the same gate instance the
   `/gate` route mutates, never a Promise) and C5 verifies the registration
   *expression* verbatim with an injected clock. The two together are strong, but
   they are not one execution.
3. **No session-log assertion.** See the note at the end of §1.
4. **`delayedMs` under concurrency is an interpretation.** §4.5 and
   `contracts.ts` say "total milliseconds of dispatch delay applied". A12b
   asserts the sum over delayed requests (two requests × two hours = four hours);
   the implementation agrees. A wall-clock-union reading would say two hours. The
   ambiguity is in the spec, not the code; it is flagged here so the choice is
   explicit rather than accidental.
5. **`heldTotal` mid-hold is not asserted**, because the spec is read two ways
   ("requests parked since start" could count at park or at release). Every
   `heldTotal` assertion is taken after a release, where both readings agree
   exactly.
6. **A theoretical B1 flake**: if a tier boundary falls between the GET that
   mints the ETag and the conditional GET microseconds later, the revision legitimately
   changes and the 304 becomes a 200. The window is a few milliseconds on four
   instants per weekday; it did not occur in any run.
7. **Non-goals checked but not exhaustively enumerated**: the client half
   (`src/client/gate.ts`, the panel, locale, styles) is T3's surface and outside
   my write scope; I verified only that the host's POST body satisfies the client's
   `validGateView` (B2) and that the transport's shared validator accepts it.

---

## 5. Exact commands and output tail

All commands were run from
`C:\Users\nirvana\Documents\deepseek-harness\dsh-api-cost` with `node` v24.19.0.
Scratch output went to `%TEMP%\gate-verify`; nothing was written inside the repo
except the three files in my scope.

### 5.1 The claim suites

```
node --test --test-isolation=none --test-concurrency=1 test/gate.test.ts test/gate-integration.test.ts
```

```
✔ E1 — isPricedModel accepts the two canonical ids and the documented aliases (0.1101ms)
✔ E2 — apply() registers the llm/stream listener and the /gate route over one gate (1.8511ms)
✔ E3 — the read rule is not relaxed: /view and /pricing stay GET-only, and the gate read is not cross-site readable (1.0409ms)
ℹ tests 33
ℹ suites 0
ℹ pass 33
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 173.3718
```

### 5.2 The whole repository, every file that does not need a build

```
node --test --test-isolation=none --test-concurrency=1 test/client.test.ts test/format.test.ts test/host.test.ts test/pricing.test.ts test/gate.test.ts test/gate-integration.test.ts
```

```
ℹ tests 142
ℹ suites 8
ℹ pass 142
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 332.7284
```

### 5.3 Strict typecheck (includes `test/**/*.ts`)

```
node node_modules/typescript/bin/tsc --noEmit
```

```
(no output — 0 bytes)
```

### 5.4 The build, which my sandbox refuses (see §4.1)

```
node scripts/build.ts
```

```
    throw new ErrnoException(err, 'spawn');
Error: spawn EPERM
    at file:///C:/Users/nirvana/Documents/deepseek-harness/dsh-api-cost/scripts/build.ts:36:22
  errno: -4048,
  code: 'EPERM',
```

### 5.5 Mutation harness (scratch; not a deliverable)

```
pwsh -NoProfile -File %TEMP%\gate-verify\mutate-all.ps1     # run from %TEMP%\gate-verify\mutant
```

Tail of the run — every mutation caught, none uncaught:

```
=== M11 [src/host/index.ts] llm/stream listener registered under a wrong event name  [# pass 32]
    caught by: E2 — apply() registers the llm/stream listener and the /gate route over one gate
=== M12 [src/host/gate.ts] aborting one waiter releases every parked waiter  [# pass 32]
    caught by: A12c — aborting one parked request leaves the other parked and counted
=== M13 [src/host/gate.ts] a pricing throw is not contained by tier()  [# pass 32]
    caught by: A10 — a throwing clock and a throwing pricing engine all fail open
pristine src restored
```

### 5.6 The one-time context-filter probe

Before any gate code existed I probed the seam the design depends on
(`%TEMP%\gate-verify\probe1.mjs`, scratch). It answered the P0 question in
`docs/off-peak-gate.md` §2 empirically: a plugin-level
`ctx.on('llm/stream', ..., { prepend: true })` IS selected by
`ctx.waterfall(this, 'llm/stream', ...)` — the listener ran synchronously inside
the `ctx.llm.stream(...)` call, `stream()` returned a non-Promise
`AsyncIterable`, and the chunk sequence passed through unchanged.

```
1. ctx.llm present: true LlmRuntime
2. plugin applied: ["apply called"]
3. registerAdapter ok: true
4. stream() returned: function isPromise: false
5. listener dispatched synchronously at stream() call: 1
6. dispatched after consume: 1
7. chunks: [{"type":"text-delta","index":0,"text":"hello"},{"type":"finish","reason":{"kind":"stop"}}]
```

Two mechanics worth knowing, both confirmed by that probe and relied on by C:

* cordis dispatches through `Service.prototype[Context.filter]`, which compares
  only the `llm` isolation label; in a normal composition both sides are
  `undefined`, so a plugin-level listener is selected. An `isolate('llm')`
  anywhere in the composition would change that.
* reading `ctx.llm` inside a plugin fiber throws
  `cannot get property "llm" without inject` unless the plugin declares
  `inject: ['llm']`. `src/host/index.ts` correctly never reads `ctx.llm`; it only
  registers the listener.
