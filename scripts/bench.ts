/**
 * Lightweight-adherence gate: bounded state, artifact size, completeness and
 * throughput. Size, state and completeness budgets are exact and hard.
 *
 * Timing budgets are MACHINE-RELATIVE: the recorded 1.0.0 baseline was measured
 * on one workstation, so a shared CI runner cannot be held to its absolute
 * milliseconds without flaking on runner speed alone. A fixed reference workload
 * measured in this same process calibrates the transfer, and the gate then fails
 * only on a real multiple-of-baseline regression.
 */
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createPricingEngine } from '../src/pricing/index.ts'
import { createCostProjection } from '../src/host/projection.ts'
import { CostQueries } from '../src/host/query.ts'
import { completeCoverage, zeroTotals } from '../src/host/projection.ts'
import type { LedgerView } from '../src/shared/contracts.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const baseline = JSON.parse(readFileSync(join(root, 'docs/baseline.json'), 'utf8')) as {
  artifacts: { client: { gzipBytes: number }; host: { gzipBytes: number }; pricing: { gzipBytes: number } }
  priceUsage100000Ms: number[]
  calibration: { referenceMs: number }
}
const STATE_BUDGET_BYTES = 32 * 1024
/** Allowed overshoot of the calibrated baseline before the gate fails. */
const TIMING_TOLERANCE = 1.15
const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!

/* ---- machine calibration ----------------------------------------------- */
/**
 * A fixed arithmetic workload in the same shape as the pricing hot path:
 * integer mixing plus BigInt multiply/divide. Its runtime moves with the
 * machine and the Node build, so the recorded baseline transfers.
 */
let calibrationSink = 0
const referenceWork = (): number => {
  const start = performance.now()
  let mixed = 12345
  let accumulator = 0n
  for (let index = 0; index < 200_000; index += 1) {
    mixed = (mixed * 1103515245 + 12345) % 2147483648
    accumulator = (accumulator + BigInt(mixed & 65535) * 1_000_000n) / 3n
  }
  const elapsed = performance.now() - start
  calibrationSink = Number(accumulator & 65_535n) + mixed
  return elapsed
}
referenceWork()
const referenceMs = median([referenceWork(), referenceWork(), referenceWork()])
const recordedReferenceMs = baseline.calibration.referenceMs
const floor = Number(process.env.BENCH_SCALE_FLOOR ?? '0')
const machineScale = Math.max(1, referenceMs / recordedReferenceMs, Number.isFinite(floor) ? floor : 0)
console.log(`calibration: ${referenceMs.toFixed(1)} ms reference vs ${recordedReferenceMs} ms recorded ⇒ machine scale ${machineScale.toFixed(2)}x (sink ${calibrationSink})`)

/* ---- pricing throughput ------------------------------------------------ */
const engine = createPricingEngine()
const usage = { inputTokens: 459, cacheReadTokens: 10496, outputTokens: 294 }
const at = Date.parse('2026-09-30T10:00:00+08:00')
for (let i = 0; i < 10000; i += 1) engine.price(usage, 'deepseek-flash', at)
const samples: number[] = []
for (let run = 0; run < 5; run += 1) {
  const start = performance.now()
  for (let i = 0; i < 100000; i += 1) engine.price(usage, 'deepseek-flash', at)
  samples.push(performance.now() - start)
}
const priceMs = median(samples)
const baselinePrice = median(baseline.priceUsage100000Ms)
const priceBudget = baselinePrice * machineScale * TIMING_TOLERANCE
check('price-100k', priceMs <= priceBudget, `${priceMs.toFixed(1)} ms vs ${priceBudget.toFixed(1)} ms budget (1.0.0 on this machine: ${(baselinePrice * machineScale).toFixed(1)} ms)`)

/* ---- projection fold throughput and bounded state ---------------------- */
const projection = createCostProjection(engine)
const header = { version: 4, id: 'session-bench', createdAt: at, isSeeded: false } as never
let state = projection.init(header, 0 as never)
const events = 100000
const foldStart = performance.now()
for (let seq = 0; seq < events; seq += 1) {
  state = projection.apply(state, {
    type: 'assistant/message', seq, time: at + seq * 1000,
    data: { turn: 1, step: seq, message: { source: { provider: 'deepseek-account', model: 'deepseek-flash' } }, stream: [], usage: { inputTokens: 459, cacheReadTokens: 10496, outputTokens: 294 } },
  } as never)
}
const foldMs = performance.now() - foldStart
const stateBytes = Buffer.byteLength(JSON.stringify(state))
check('fold-100k', foldMs <= 15000, `${foldMs.toFixed(0)} ms for ${events} settlements`)
check('state-bound', stateBytes <= STATE_BUDGET_BYTES, `${stateBytes} B <= ${STATE_BUDGET_BYTES} B`)
check('fold-accuracy', state.view.totals.calls === events, `${state.view.totals.calls} priced calls recorded`)
const deduped = projection.apply(state, { type: 'turn/end', seq: events + 1, time: at, data: { turn: 1, reason: { kind: 'completed' } } } as never)
check('unrelated-event-identity', deduped === state, 'an ignored event reuses the state reference')

/* ---- cross-session aggregation over a large historical tree ------------ */
const ledger = (id: string): LedgerView => ({
  revision: 'rev-' + id,
  totals: { calls: 1, attempts: 1, unpricedCalls: 0, money: { cny: '0.001', usd: '0.0001' },
    tokens: { cacheHit: '0', cacheMiss: '1000', output: '10', reasoning: '0', total: '1010' },
    periods: { peak: { cny: '0.001', usd: '0.0001' }, offPeak: { cny: '0', usd: '0' } } },
  byModel: [], recent: [], coverage: completeCoverage(),
})
const children = Array.from({ length: 70 }, (_, index) => 'child-' + index)
let reads = 0
const queries = new CostQueries({
  async read(id) {
    reads += 1
    return {
      header: { id: id as never, ...(id === 'root' ? {} : { parentSession: 'root' as never }) },
      ledger: ledger(id),
      catalog: id === 'root' ? children.map(child => ({ id: child as never, createdAt: at, mode: 'one-shot' as const })) : [],
      team: undefined,
    }
  },
})
const queryStart = performance.now()
const first = await queries.view({ sessionId: 'root', detail: 'summary' })
const coldMs = performance.now() - queryStart
const readsAfterCold = reads
const warmStart = performance.now()
const warm = await queries.view({ sessionId: 'root', detail: 'summary' })
const warmMs = performance.now() - warmStart
check('tree-completeness', first.sessionCount === 71 && first.total.calls === 71, `${first.sessionCount} sessions / ${first.total.calls} calls`)
check('tree-cache', warm.revision === first.revision && reads === readsAfterCold, `${readsAfterCold} reads cold, ${reads} after a warm read`)
check('tree-cold-latency', coldMs <= 1500, `${coldMs.toFixed(1)} ms cold over 71 sessions`)
check('tree-warm-latency', warmMs <= 5, `${warmMs.toFixed(2)} ms warm`)
check('query-cache-bound', queries.stats.cached <= 64, `${queries.stats.cached} cached views`)
queries.dispose()

/* ---- artifact weight --------------------------------------------------- */
const weight = (path: string): { raw: number; gzip: number } => { const bytes = readFileSync(join(root, path)); return { raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length } }
const client = weight('dist/client.js'), host = weight('dist/index.js')
check('client-budget', client.gzip <= 10240, `${client.gzip} B gzip (${client.raw} B raw) vs legacy ${baseline.artifacts.client.gzipBytes} B`)
check('host-budget', host.gzip <= 20480, `${host.gzip} B gzip (${host.raw} B raw) vs legacy ${baseline.artifacts.host.gzipBytes + baseline.artifacts.pricing.gzipBytes} B`)

console.log('\n' + JSON.stringify({ priceMs100k: Number(priceMs.toFixed(1)), foldMs100k: Number(foldMs.toFixed(0)), stateBytes, coldTreeMs: Number(coldMs.toFixed(1)), warmTreeMs: Number(warmMs.toFixed(2)), clientGzip: client.gzip, hostGzip: host.gzip, failures }, null, 2))
if (failures.length) { console.error('Benchmark budgets failed: ' + failures.join(', ')); process.exitCode = 1 }
