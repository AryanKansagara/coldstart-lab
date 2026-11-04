import { test } from 'node:test'
import assert from 'node:assert/strict'
import { simulate, coldStartSec, percentile, sanitizeCfg, SNAPSHOT_SPEEDUP, type SimConfig } from './sim.ts'
import { generate, parseTrace, rng, sanitizeSpec, MAX_REQUESTS, type Trace } from './traffic.ts'
import { pareto, runGrid, recommend, explain, explainPoint, diagnose } from './optimize.ts'
import { containerPricePerSec, GPU_PRICE_PER_SEC } from './pricing.ts'
import { encodeState, decodeState } from './share.ts'
import { DEFAULT_CFG } from './presets.ts'

const cfg = (o: Partial<SimConfig> = {}): SimConfig => ({
  ...DEFAULT_CFG,
  gpu: 'T4',
  cpuCores: 0,
  memoryGiB: 0,
  bootSec: 1,
  imageSec: 4,
  modelSec: 5,
  serviceMean: 1,
  scaledownWindow: 60,
  ...o,
})
const tr = (t: number[], horizon = 1000, d: number[] | null = null): Trace => ({ t, d, horizon })

test('single request from zero pays the full cold start', () => {
  const r = simulate(tr([0]), cfg())
  assert.equal(r.coldCount, 1)
  assert.equal(r.p50, 10 + 1)
  assert.equal(r.containersStarted, 1)
})

test('warm container is reused inside scaledown_window, then reaped', () => {
  const r = simulate(tr([0, 30]), cfg(), { detail: true })
  assert.equal(r.coldCount, 1)
  assert.equal(r.containersStarted, 1)
  // Second request is served warm: latency == service time.
  assert.equal(r.detail!.done[1] - 30, 1)
  // Container lives from 0 until 60s after its last request finished (31 + 60).
  assert.equal(r.detail!.containers[0].end, 91)
})

test('request after scaledown_window expires hits a new cold start', () => {
  const r = simulate(tr([0, 200]), cfg())
  assert.equal(r.coldCount, 2)
  assert.equal(r.containersStarted, 2)
})

test('min_containers keeps warm capacity and bills the whole window', () => {
  const r = simulate(tr([0, 500], 1000), cfg({ minContainers: 1 }))
  assert.equal(r.coldCount, 0)
  const price = containerPricePerSec('T4', 1, 0, 0)
  assert.ok(Math.abs(r.cost - 1000 * price) < 1e-9)
  assert.ok(r.idleCost > r.busyCost)
})

test('buffer_containers absorbs the second request of a burst', () => {
  const t = [0, 15, 15.5]
  const without = simulate(tr(t), cfg({ serviceMean: 20 }))
  const withBuf = simulate(tr(t), cfg({ serviceMean: 20, bufferContainers: 1 }))
  assert.ok(withBuf.coldCount < without.coldCount, `${withBuf.coldCount} < ${without.coldCount}`)
})

test('max_containers caps concurrency and requests queue', () => {
  const r = simulate(tr([0, 0, 0, 0]), cfg({ maxContainers: 1, bootSec: 0, imageSec: 0, modelSec: 0 }))
  assert.equal(r.peakContainers, 1)
  assert.equal(r.p99, 4)
  assert.ok(r.queuedPct > 70)
})

test('@modal.concurrent max_inputs lets one container serve many', () => {
  const t = Array.from({ length: 10 }, (_, i) => 20 + i * 0.01)
  const r = simulate(tr(t), cfg({ minContainers: 1, maxInputs: 10, maxContainers: 5 }))
  assert.equal(r.coldCount, 0)
  assert.equal(r.peakContainers, 1)
})

test('target_inputs scales out earlier than max_inputs', () => {
  const t = Array.from({ length: 10 }, (_, i) => 20 + i * 0.01)
  const hi = simulate(tr(t), cfg({ minContainers: 1, maxInputs: 10, targetInputs: 0 }))
  const lo = simulate(tr(t), cfg({ minContainers: 1, maxInputs: 10, targetInputs: 4 }))
  assert.ok(lo.peakContainers > hi.peakContainers)
})

test('memory snapshot shortens cold start by the modeled speedup', () => {
  const c = cfg({ snapshot: true })
  assert.equal(coldStartSec(c), 1 + 9 / SNAPSHOT_SPEEDUP)
  assert.ok(simulate(tr([0]), c).p99 < simulate(tr([0]), cfg()).p99)
})

test('cost buckets add up and price table covers requested GPUs', () => {
  const trace = generate({ kind: 'bursty', rate: 0.2, hours: 1, seed: 1, serviceMean: 2, serviceCv: 0.5 })
  const r = simulate(trace, cfg({ bufferContainers: 1 }))
  assert.ok(Math.abs(r.busyCost + r.idleCost + r.bootCost - r.cost) < 1e-9)
  for (const g of ['T4', 'L4', 'A10G', 'L40S', 'A100-80GB', 'H100', 'H200', 'B200']) assert.ok((GPU_PRICE_PER_SEC as Record<string, number>)[g] > 0)
})

test('generators are seeded, sorted and hit their mean rate', () => {
  for (const kind of ['poisson', 'diurnal', 'bursty', 'spike'] as const) {
    const spec = { kind, rate: 2, hours: 24, seed: 9, serviceMean: 1, serviceCv: 0.3 }
    const a = generate(spec)
    assert.deepEqual(a.t.slice(0, 50), generate(spec).t.slice(0, 50))
    for (let i = 1; i < a.t.length; i++) assert.ok(a.t[i] >= a.t[i - 1])
    const rate = a.t.length / a.horizon
    assert.ok(rate > 1.6 && rate < 2.4, `${kind} rate ${rate}`)
  }
  assert.notEqual(rng(1)(), rng(2)())
})

test('parses CSV with ISO timestamps and latency_ms', () => {
  const csv = 'timestamp,latency_ms,status\n2025-01-01T00:00:10Z,1500,200\n2025-01-01T00:00:00Z,500,200\nbad,1,1\n'
  const { trace, skipped } = parseTrace(csv)
  assert.deepEqual(trace.t, [0, 10])
  assert.deepEqual(trace.d, [0.5, 1.5])
  assert.equal(skipped, 1)
})

test('parses JSONL with epoch milliseconds and headerless CSV', () => {
  const jl = '{"ts":1700000000000,"duration":2}\n{"ts":1700000003000,"duration":4}\n'
  const a = parseTrace(jl)
  assert.deepEqual(a.trace.t, [0, 3])
  assert.deepEqual(a.trace.d, [2, 4])
  const b = parseTrace('5\n1\n3\n')
  assert.deepEqual(b.trace.t, [0, 2, 4])
  assert.equal(b.trace.d, null)
  assert.throws(() => parseTrace('  \n'))
})

test('pareto frontier keeps only non-dominated points', () => {
  const pts: { cost: number; p99: number; pareto?: boolean }[] = [
    { cost: 1, p99: 10 },
    { cost: 2, p99: 5 },
    { cost: 3, p99: 6 },
    { cost: 4, p99: 1 },
  ]
  assert.deepEqual(pareto(pts).map((p) => p.cost), [1, 2, 4])
  assert.equal(pts[2].pareto, false)
})

test('grid search finds a cheaper-or-faster config and explains it', () => {
  const trace = generate({ kind: 'bursty', rate: 0.1, hours: 2, seed: 5, serviceMean: 2, serviceCv: 0.3 })
  const c = cfg()
  const pts = runGrid(trace, c)
  const front = pts.filter((p) => p.pareto).sort((a, b) => a.cost - b.cost)
  assert.ok(front.length >= 2)
  const rec = recommend(front, 3)!
  assert.ok(rec.p99 <= 3 || rec === front[front.length - 1])
  const base = simulate(trace, c)
  const ins = explain(trace, c, base)
  const buf = ins.find((i) => i.label.startsWith('buffer_containers'))!
  assert.ok(buf.coldDelta < 0 && buf.costDelta > 0)
  assert.match(buf.text, /removes \d+% of cold starts for \+\$/)
  assert.match(ins.find((i) => i.label.startsWith('enable_memory_snapshot'))!.text, /cuts each cold start from 10\.0 s to 2\.80 s/)
})

test('share state round-trips through the URL hash', async () => {
  const s = { cfg: DEFAULT_CFG, slo: 5 }
  const h = await encodeState(s)
  assert.match(h, /^[A-Za-z0-9_-]+$/)
  assert.deepEqual(await decodeState(h), s)
  assert.equal(await decodeState('#garbage!!'), null)
})

test('percentile uses nearest-rank', () => {
  const xs = Array.from({ length: 100 }, (_, i) => i + 1)
  assert.equal(percentile(xs, 0.5), 50)
  assert.equal(percentile(xs, 0.99), 99)
})

test('sanitizeCfg forces hostile shared-URL values into valid Modal ranges', () => {
  const c = sanitizeCfg({ gpu: 'constructor' as never, scaledownWindow: 1, minContainers: 99, maxContainers: 3, targetInputs: 50, maxInputs: 4, bootSec: Number.NaN }, DEFAULT_CFG)
  assert.equal(c.gpu, DEFAULT_CFG.gpu)
  assert.equal(c.scaledownWindow, 2)
  assert.equal(c.minContainers, 3)
  assert.equal(c.targetInputs, 4)
  assert.equal(c.bootSec, DEFAULT_CFG.bootSec)
  assert.equal(sanitizeSpec({ kind: 'x' as never, hours: 1e9 }, { kind: 'spike', rate: 1, hours: 1, seed: 1, serviceMean: 1, serviceCv: 0 }).hours, 168)
})

test('needed containers track demand and stay below alive in steady state', () => {
  const trace = generate({ kind: 'poisson', rate: 0.2, hours: 1, seed: 2, serviceMean: 2, serviceCv: 0 })
  const tl = simulate(trace, cfg({ minContainers: 3, serviceMean: 2 })).timeline
  const mean = tl.needed.reduce((a, b) => a + b, 0) / tl.needed.length
  assert.ok(Math.abs(mean - 0.4) < 0.1, `utilisation ${mean}`)
})

test('huge logs parse without blowing the call stack', () => {
  const big = Array.from({ length: 200_000 }, (_, i) => String(i)).join('\n')
  assert.equal(parseTrace(big).trace.t.length, 200_000)
  assert.ok(MAX_REQUESTS >= 200_000)
})

test('plain-English verdicts cover the p99 blind spot and SLO outcome', () => {
  const t = Array.from({ length: 500 }, (_, i) => i * 2)
  const base = simulate(tr(t, 1000), cfg({ scaledownWindow: 1200 }))
  assert.match(diagnose(base), /p99 hides it/)
  const line = explainPoint(base, { knobs: { minContainers: 1, bufferContainers: 0, scaledownWindow: 60, targetInputs: 0 }, cost: 1, costPerDay: base.costPerDay + 5, p99: 1, p95: 1, coldPct: 0, pareto: true }, 2)
  assert.match(line, /min_containers=1.*meets your 2\.00 s p99 target.*removes 100% of cold starts for \+\$5/)
})
