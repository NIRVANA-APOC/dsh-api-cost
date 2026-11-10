# Off-peak gate — independent verification (T4)

Verifier: `gate-verify`. Status: **v2.1.0 process-global run complete for the
A/B/C matrix; no defect found in `src/**`. v2.2.0 per-session revision: claim
suite updated and extended, see the addendum in §6. v2.3.0 conversation-tree
revision: scope re-expressed as one session and its delegation subtree, claim
suite extended with A20–A26 / C9–C10, see the addendum in §7.**
Scope of this file: claim → test → verdict, every defect with coordinates, the exact
commands, and the output tail. This report is evidence, not a summary: where a
claim is not proven, it says so.

**§1–§5 are the historical v2.1.0 report.** They describe the process-global gate
that shipped in v2.1.0; their wording ("the flag", "every parked request") is
**superseded** by the per-session contract in §6 and by the conversation-tree
contract in §7 (and by `docs/off-peak-gate.md` §4/§5). They are kept because they
are the record of the run that established the design; §6 and §7 are the current
claim matrices.

Artifacts produced by this task:

| File | What it holds |
| --- | --- |
| `test/gate.test.ts` | A1–A26, B1–B5, E1–E3 — the hold state machine, the durable store, the conversation-tree scope (A20–A26), the session-keyed `/gate` wire, and the wiring facts the claims rest on |
| `test/gate-integration.test.ts` | C1–C10 — a REAL cordis `Context` + REAL `@deepseek-ai/dsh-llm` `LlmRuntime` + stub adapter + the real gate, including the unrelated-conversation C8 claim and the delegation-tree C9/C10 claims |
| `docs/verification-gate.md` | this report, with the v2.2.0 addendum in §6 and the v2.3.0 addendum in §7 |

Method: every test drives the real `src/host/gate.ts` and the real `/gate` route
(through `apply()` on a fake `webServer`, in the style of `test/host.test.ts`).
The only substitutions are a deterministic clock, an in-memory `GateStore`, and
pricing doubles used solely to produce states the real card cannot (a peak with
no known boundary, a throw). The engine is the real one wherever the claim is
about billing. No test reads the real clock.

---

## 1. Verdict table (v2.1.0 process-global run — superseded in scope by §6)

Verdicts: **verified** = a test that fails when the claim is false, and the
failure was demonstrated with a mutation (see §3). **unknown** = not proven, with
the reason stated in §4.

> Historical note: the v2.1.0 gate was one process-wide switch. Every claim in
> this table was re-expressed for an explicit session argument in the v2.2.0
> revision, and the per-session matrix in §6 is authoritative; the rows below are
> the original wording, not the current contract.

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

---

## 6. Addendum — v2.2.0 per-session gate

Superseding scope: `GateView` is schemaVersion 3; the switch, the hold registry,
the counters, the durable file and both HTTP methods are **session-keyed**. Every
v2.1.0 claim was re-expressed for an explicit session argument (`S = 'session-a'`,
`T = 'session-b'` in `test/gate.test.ts`), the claims that only exist once two
sessions can disagree are A15–A18 / C8, and A19 covers the bounded-state budget.
Nothing was deleted or weakened: each old claim keeps its assertion set, now
driven through `gate.view(S)`, `gate.setEnabled(S, …)`, `gate.wait(S, …)` and
`middleware({ sessionId: S })`.

### 6.1 Added and changed claims

| # | Claim | Test | Verdict |
| --- | --- | --- | --- |
| A15 | Enabling one session parks only that session; another session's middleware returns the identical `next()` object while the first holds, and a session-less call is never gated | `A15 — enabling one session parks only that session; another session and a session-less call stay identical` | verified |
| A16 | Two sessions hold independently, counters/windows/revisions isolated; `setEnabled(A,false)` releases only A's holders, B stays parked and counted | `A16 — two sessions hold independently; counters are isolated and switching one off releases only its holders` | verified |
| A17 | Per-session durability round-trips independently; a legacy v1 file is ignored and upgraded; an unwritable path degrades without throwing; the file keeps at most 512 sessions evicting the oldest `changedAt` first | `A17 — per-session durability: choices round-trip independently, a legacy v1 file is ignored, an unwritable path degrades, and the file keeps at most 512 sessions` | verified |
| A18 | GET without a session is 400 `INVALID_SESSION`; one session per read (unknown/duplicate query key is 400); each session has its own ETag; POST flips only its named session; malformed session id is `INVALID_SESSION`, missing key is `INVALID_BODY` | `A18 — the gate read is per-session: a missing session is a 400, each session has its own ETag, and a POST flips only its named session` | verified |
| A19 | In-memory session state is bounded at 1024 records: inherited records are evicted before an explicit choice, and under real pressure the oldest-touched explicit record goes; the rebuilt record reports the inherited default again | `A19 — in-memory session state is bounded: an inherited record is evicted before an explicit choice, and the oldest-touched record goes under real pressure` | verified |
| A1–A14 | The v2.1.0 hold/fail-open/durable claims, re-expressed with a session argument (same assertions, plus session-scoped views) | `A1`…`A14b` | verified |
| A13 | …and `revision` now also folds `sessionId` (two sessions never share an ETag) | `A13`, `A18`, `B1` | verified |
| A14 | Durable test now asserts the v2 file shape (`{"version":2,"sessions":{…}}`), the stored `changedAt` restoring, and the per-session inherited default (`changedAt:null, durable:false`) | `A14` | verified |
| B1–B5 | The v2.1.0 wire claims, re-expressed with `?session=<id>` reads and `{"session":…,"enabled":…}` writes; the guard order is unchanged | `B1`…`B5` | verified |
| E2 | `apply()` still registers exactly one prepended `llm/stream` listener and the `/gate` route over one gate; a session-less call bypasses by identity, and flipping one session off is visible to the listener while another session still inherits the configured default | `E2 — apply() registers the llm/stream listener and the /gate route over one per-session gate` | verified |
| E3 | `/view` and `/pricing` stay GET-only; the cross-site gate read (with a session) is still refused | `E3` | verified |
| C1–C7 | The real-framework claims, with a real `GenerateOptions.sessionId` threaded through every call; C1/C2 also assert the adapter receives the stamped session id | `C1`…`C7` | verified |
| C8 | Two concurrent real `ctx.llm.stream()` calls with different session ids: only the enabled session parks; the other reaches the adapter while the first is still parked, and only the enabled one moves to the boundary | `C8 — two concurrent real calls with different sessions: only the enabled session parks, the other dispatches while it waits` | verified |

### 6.2 Historical clauses explicitly superseded

| v2.1.0 clause | Superseded by |
| --- | --- |
| "the [one] stored flag", `GateStore.read()` / `write(enabled)` | §4 `read(sessionId)` / `write(sessionId, enabled)`; A15–A17 |
| `GateView` schemaVersion 2 without `sessionId`/`otherHolding`, `changedAt: number` | v3 with `sessionId`, nullable `changedAt`, `otherHolding`; A18, B1 |
| `revision` without a session component, so one ETag validated every read | `revision` folds `sessionId`; A13, A18, B1 |
| "`setEnabled(false)` releases the parked waiter" (all of them) | releases only that session's holders; A7, A16 |
| `GET /gate` with no parameters and `POST {"enabled":…}` | `?session=<id>` and `{"session":<id>,"enabled":…}`; A18, B1–B4 |
| v1 file `{"version":1,"enabled":…}` preferred over `config.enabled` | v1 files are ignored (unattributable), v2 written; A14, A17 |
| "The gate is per process" (limitation) | per session; per-process runtime state only, durable state per session; `docs/off-peak-gate.md` §8 |

### 6.3 Commands and verdict (this revision)

```
node --test --test-isolation=none --test-concurrency=1 test/gate.test.ts test/gate-integration.test.ts
```

```
ℹ tests 39
ℹ suites 0
ℹ pass 39
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 383.646472
```

(Typecheck is covered by the repository-wide `pnpm typecheck`; the claim suites
above import the production modules directly, so a type or interface mismatch fails
the run rather than the build step. No test reads the real clock and no test sleeps
in real time; the only real timer is the per-assertion `withDeadline` guard whose
job is to turn a hang into a failure.)

### 6.4 Limitations of this addendum

1. The v2.1.0 mutation matrix (§3) was not re-run for v2.2.0; the claim suites
   themselves are the regression net, and the Lead runs `pnpm test`/`pnpm check`
   on the final tree (which now also requires `pnpm build` before the suites that
   read `dist/`).
2. The 512-session durable bound is asserted end-to-end by A17; the
   1024-session in-memory bound is asserted by A19 (an explicit choice survives
   inherited pressure first, then the oldest-touched record goes). The eviction
   order was found by writing A19: the first implementation could evict the very
   record it had just created before `setEnabled` marked it explicit, which made
   `view()` silently lose a switch under pressure. The fix prepares the choice
   before the record joins the bounded map; A19 is the regression test.
   The independent v2.3 verifier suite (`test/gate-tree.test.ts`, V12–V19) also
   passes 8/8 on the final tree, with an 11-mutation falsification run (subtree
   counters, ancestor walk, `otherHolding`, release scope, revision folds, link
   learning, cache bounds, `session/created` teaching) caught by named tests.
3. The client half (session-keyed `GateStore`) is T2's surface; this suite only
   asserts that the host's GET/POST bodies satisfy the shared `validGateView`.

### 6.5 Independent verifier artifact (v2.2.0; updated in place for v4)

A second, claim-first suite was written by an independent verifier against the
frozen contract rather than against the implementation: `test/gate-sessions.test.ts`
(19 tests, V1–V11b, self-contained doubles, deterministic hand-drained clock). It
is glob-captured by the repository command
`node --test test/*.test.ts`, so it is part of every full run, not an optional
extra. For v2.3 the verifier updated it in place to the v4 view shape: the claims
are now framed as the **root-session half** of the tree contract (two unrelated
root conversations never affect each other), with `source`/`inheritedFrom`/
`ownHolding` asserted throughout. On the final tree it reports 19/19 pass, and a
9-mutation falsification pass against it was caught by named tests.

Falsification was re-run on that suite against a scratch copy of the tree (never
the repository): 15 deliberate breaks, 14 caught by at least one V test —
per-session enable bypass, release-all on disable, `otherHolding` pinned to zero,
global counters, the durable file written as v1, the 512 cap removed, `revision`
without `sessionId`, `revision` folding the wall clock, GET without a session
accepted, POST ignoring the body session, `view()` writing the store, the
in-memory cap removed, a disabled session still parking, and `wait()` checking
`explicit` instead of `enabled`. The fifteenth (removing `planHold`'s outer
`catch`) is an equivalent mutant: the inner `tryNow()`/`tier()` catches and the
middleware's own boundary catch make it unreachable; the reachable compound
variant, with both fail-open layers removed, is caught by V9a.

Known limitation restated, not a defect: the 1024-record in-memory cap can evict
an explicit non-durable switch (`persist:false`) if one process touches more than
1024 sessions. The cap is a memory bound, the durable file is the record of a
user's choice, and both are documented in `docs/off-peak-gate.md` §8.

---

## 7. Addendum — v2.3.0 conversation-tree gate

Superseding scope: `GateView` is schemaVersion 4 and a switch now governs **the
session it was flipped in and that session's delegation subtree**, while an
unrelated conversation keeps its own position. `enabled` is the *effective*
position, `source` says where it came from (`self` / `inherited` / `default`),
`inheritedFrom` names the nearest explicitly-switched ancestor, `ownHolding` is the
session's own parked count, and `holding`/`since`/`releaseAt`/`heldTotal`/`delayedMs`
aggregate over the tracked subtree with `otherHolding` counting requests parked
outside it. Delegation links are live runtime state (`session/created` plus a
synchronous `parentOf` fallback); the version-2 durable file still stores explicit
per-session choices only. §4 and §5 of `docs/off-peak-gate.md` are the current
contract; the v2.2.0 contract is its Appendix B.

Every v2.2.0 claim (A1–A19, B1–B5, E1–E3, C1–C8) is kept green by the same
assertions, re-expressed where the new fields require it (for example E2 now expects
the one `session/created` link listener alongside the one prepended `llm/stream`
listener). Nothing was deleted or weakened. The tree-specific claims are:

### 7.1 Added and changed claims

| # | Claim | Test | Verdict |
| --- | --- | --- | --- |
| A20 | A parent's switch parks a child and a grandchild learned through `observeSession`; an unrelated root's middleware returns the identical `next()` object and dispatches at the peak instant; the parent's view aggregates the whole subtree | `A20 — a parent switch parks its child and grandchild, while an unrelated root returns the identical next()` | verified |
| A21 | Enabling one root parks only its tree: an unrelated root and its child bypass the gate by identity and dispatch at the peak instant while the enabled tree stays parked | `A21 — enabling a root parks only its tree: an unrelated tree and its child dispatch immediately` | verified |
| A22 | Nearest explicit choice wins: a child's explicit OFF overrides a parent ON and the grandchild inherits the child; a child explicit ON overrides a parent OFF; a grandchild's `inheritedFrom` moves to the nearest explicit ancestor; an explicit OFF ancestor overrides the configured default ON; `source`/`inheritedFrom` are exact for the self/inherited/default cases | `A22 — the nearest explicit choice wins; view.source and view.inheritedFrom are exact` | verified |
| A23 | Disabling a parent releases its own holders and every inheriting descendant's, but an explicit-ON child (and its subtree) stays parked, counted and timer-armed; an unrelated session is untouched | `A23 — disabling a parent releases only its inheriting descendants; an explicit-ON child stays parked and counted` | verified |
| A24 | Subtree counters are exact across a three-session tree: `holding`/`ownHolding`/`since`/`releaseAt`/`heldTotal`/`delayedMs` aggregate `self + tracked descendants`, `otherHolding` excludes the whole subtree, and `revision` moves only with rendered fields (a clock move alone never moves it) | `A24 — a view aggregates its subtree counters and the revision moves only with rendered changes` | verified |
| A25 | The live synchronous `parentOf` fallback resolves a tree with no announcement; `observeSession` overrides a resolver guess and re-parents a child out of its old subtree; cycles and self-links terminate as roots; the parent-link cache is bounded (an old link is re-resolved, a recent one is not) | `A25 — the live parentOf fallback resolves a tree, observeSession overrides it, cycles end as roots, and the link cache is bounded` | verified |
| A26 | `apply()` registers exactly one `session/created` listener (and one prepended `llm/stream` listener); a delivered `session/created` event makes the tree resolve through the real gate/route; a hostile or null announcement cannot throw and cannot veto creation | `A26 — apply() registers exactly one session/created listener, and an event makes the tree resolve` | verified |
| A17b | The version-2 durable file stores explicit per-session choices only — never parent links; a fresh gate on the same store keeps the choice but has no tree until the live links are announced, and announcing writes nothing | `A17b — the durable file stores explicit choices only; a restart rebuilds the tree from live links` | verified |
| B1–B5 | The wire claims are unchanged: the route is still addressed by one `?session=<id>`, the mutation body is still exactly `{session, enabled}`, the guard order is unchanged, the response satisfies the schemaVersion-4 `validGateView` and carries a per-session ETag | `B1`…`B5`, A18 | verified |
| E2 | `apply()` registers exactly two listeners: one prepended `llm/stream` interception point and the one `session/created` delegation-link listener; the route and the listener still share one gate | `E2 — apply() registers the llm/stream listener, the one session/created link listener and the /gate route over one per-session gate` | verified |
| C9 | A real parent switch parks the real `ctx.llm.stream()` calls of its child and grandchild through the real LLM waterfall, while a sibling root conversation reaches the adapter at the peak instant; the whole tree dispatches at the boundary and the sibling does not | `C9 — a real parent switch parks its child and grandchild through the real waterfall, while a sibling root dispatches` | verified |
| C10 | Disabling a real parent mid-hold releases its inheriting child immediately (inside peak) but leaves an explicitly enabled grandchild parked until the boundary, still counted under the parent's view | `C10 — disabling a parent mid-hold releases its inheriting child at once but not an explicitly enabled grandchild` | verified |

### 7.2 Historical clauses explicitly superseded

| v2.2.0 clause | Superseded by |
| --- | --- |
| Success criterion 7: "The scope is exactly one session… a delegated subagent is a session of its own and carries its own switch." | scope is one conversation tree; a subagent inherits its nearest explicit ancestor unless switched by hand; A20–A23, C9 |
| `GateView` schemaVersion 3; `enabled` is the session's own stored choice; no `source`/`inheritedFrom`/`ownHolding`; counters are that one session's; `otherHolding` = every other session | v4: effective `enabled`, `source`/`inheritedFrom`, `ownHolding`, subtree-scoped counters, `otherHolding` = parked outside this subtree; A20, A24 |
| Decision rule `stored choice ?? config.gate.enabled` per session | walk self → parent → … (cycle-safe, max depth 64), nearest explicit choice wins, else the configured default; A22, A25 |
| `setEnabled(S, false)` releases only S's own holders | releases S's own holders and the inheriting descendants'; an explicit-ON descendant (and its subtree) keeps holding; A23, C10 |
| "enabling session A can never park session B's calls" (siblings only) | unchanged for unrelated conversations, but A's **descendants** now inherit A; A20 vs A21/A23 |
| The gate has no delegation knowledge; `OffPeakGate` has no `observeSession`, `CreateGateOptions` no `parentOf`; `apply()` registers one listener | live parent links via the one `session/created` listener + synchronous `parentOf` fallback; links bounded, never persisted; A25, A26, E2 |
| A subagent "inherits `config.gate.enabled` until it is switched itself" | it inherits its nearest explicitly-switched ancestor; only the absence of any explicit choice falls back to `config.gate.enabled`; A20, A22 |
| `GateStore`/version-2 durable file/`/gate` wire scope | **not superseded**: the durable file still stores explicit per-session choices only (no parent links), the file format and 512-session cap are unchanged, and the wire guard order is unchanged (only the serialized view grows the v4 fields); A14, A17, A18, B1–B5 |

### 7.3 Commands and verdict (this revision)

```
node --test --test-isolation=none --test-concurrency=1 test/gate.test.ts test/gate-integration.test.ts
```

```
ℹ tests 48
ℹ suites 0
ℹ pass 48
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 435.558271
```

```
pnpm typecheck
```

```
$ tsc --noEmit
(no diagnostics)
```

No test reads the real clock and no test sleeps in real time; the injected clock is
hand-drained and the only real timer is the per-assertion `withDeadline` guard whose
job is to turn a hang into a failure. The tree claims use the same deterministic
clock/store/pricing doubles as the per-session claims, and A26 drives the real
`apply()` on a fake `webServer`/`ctx` in the style of the E claims.

### 7.4 Limitations of this addendum

1. The v2.1.0 mutation matrix (§3) was not re-run for v2.3.0; the claim suites are
   the regression net and the Lead runs the complete `pnpm check` on the final tree
   (which requires `pnpm build` before the suites that read `dist/`).
2. The host half's claims A20–A26 / C9–C10 are the evidence recorded in §7.1. An
   independent claim-first suite for this revision (`test/gate-tree.test.ts`,
   V12–V19) is produced by the verification task against the frozen contract; its
   results are reported separately by the verifier and are not restated here.
3. Delegation links are live-only by design. A process that has not observed a
   `session/created` (and cannot resolve the link through `ctx.sessions` /
   `ctx.agents`) treats the session as a root; this is the documented v2.3.0
   limitation, not a test gap.
4. The `delayedMs` interpretation from §4.4 is unchanged: it is the summed dispatch
   delay of delayed requests, now aggregated over the subtree (A24 asserts the sum).
5. The client half (`src/client/gate.ts`, the panel, locale, styles, transport) is
   T2/T3's surface; this suite asserts that the host's GET/POST bodies satisfy the
   shared schemaVersion-4 `validGateView` (B1, B2) and that the tree fields render
   consistently (A20–A26), not the panel's behaviour.
