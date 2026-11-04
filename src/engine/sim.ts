import { containerPricePerSec, GPU_PRICE_PER_SEC, type Gpu } from './pricing.ts'
import type { Trace } from './traffic.ts'

export interface SimConfig {
  gpu: Gpu
  gpuCount: number
  cpuCores: number
  memoryGiB: number
  /** Modal autoscaler knobs (@app.function / @app.cls). */
  minContainers: number
  maxContainers: number
  bufferContainers: number
  scaledownWindow: number
  /** @modal.concurrent(max_inputs, target_inputs). target 0 = same as max. */
  maxInputs: number
  targetInputs: number
  /** Cold start = container boot + image load + model load (seconds). */
  bootSec: number
  imageSec: number
  modelSec: number
  snapshot: boolean
  /** Used when the trace carries no per-request durations. */
  serviceMean: number
}

/** Memory snapshots restore instead of re-initialising; Modal cites 3-10x faster starts. */
export const SNAPSHOT_SPEEDUP = 5

export function coldStartSec(c: SimConfig) {
  return c.bootSec + (c.imageSec + c.modelSec) / (c.snapshot ? SNAPSHOT_SPEEDUP : 1)
}

const num = (v: unknown, lo: number, hi: number, fallback: number) => {
  const x = typeof v === 'number' ? v : Number.NaN
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback
}

/** Coerces untrusted config (shared URLs, localStorage, half-typed inputs) into Modal's valid ranges. */
export function sanitizeCfg(raw: Partial<SimConfig> | null | undefined, base: SimConfig): SimConfig {
  const c = raw ?? {}
  const int = (v: unknown, lo: number, hi: number, f: number) => Math.round(num(v, lo, hi, f))
  const maxContainers = int(c.maxContainers, 1, 2000, base.maxContainers)
  const maxInputs = int(c.maxInputs, 1, 1000, base.maxInputs)
  return {
    gpu: c.gpu && Object.hasOwn(GPU_PRICE_PER_SEC, c.gpu) ? c.gpu : base.gpu,
    gpuCount: int(c.gpuCount, 1, 8, base.gpuCount),
    cpuCores: num(c.cpuCores, 0.125, 256, base.cpuCores),
    memoryGiB: num(c.memoryGiB, 0, 2048, base.memoryGiB),
    minContainers: int(c.minContainers, 0, maxContainers, base.minContainers),
    maxContainers,
    bufferContainers: int(c.bufferContainers, 0, 500, base.bufferContainers),
    scaledownWindow: num(c.scaledownWindow, 2, 1200, base.scaledownWindow),
    maxInputs,
    targetInputs: int(c.targetInputs, 0, maxInputs, base.targetInputs),
    bootSec: num(c.bootSec, 0, 3600, base.bootSec),
    imageSec: num(c.imageSec, 0, 3600, base.imageSec),
    modelSec: num(c.modelSec, 0, 3600, base.modelSec),
    snapshot: typeof c.snapshot === 'boolean' ? c.snapshot : base.snapshot,
    serviceMean: num(c.serviceMean, 0.001, 3600, base.serviceMean),
  }
}

export function targetOf(c: SimConfig) {
  return c.targetInputs > 0 ? Math.min(c.targetInputs, c.maxInputs) : c.maxInputs
}

export interface Timeline {
  bucketSec: number
  /** Arrivals per second. */
  load: number[]
  /** Time-averaged containers alive (booting + warm). */
  alive: number[]
  /** Inputs in flight or queued, divided by target_inputs: the containers demand actually needs. */
  needed: number[]
  /** Time-averaged containers still booting. */
  booting: number[]
  /** Requests that waited on a cold container. */
  cold: number[]
  /** Peak queue depth. */
  queue: number[]
}

export interface SimResult {
  n: number
  p50: number
  p95: number
  p99: number
  mean: number
  coldCount: number
  coldPct: number
  queuedPct: number
  queueMean: number
  queueP99: number
  cost: number
  busyCost: number
  idleCost: number
  bootCost: number
  costPer1k: number
  costPerDay: number
  horizon: number
  containersStarted: number
  peakContainers: number
  coldStartSec: number
  timeline: Timeline
  hist: { edges: number[]; counts: number[]; coldCounts: number[] }
  /** Present when `detail` is requested: for replaying the run visually. */
  detail?: {
    containers: { start: number; ready: number; end: number }[]
    container: Int32Array
    dispatch: Float64Array
    done: Float64Array
    cold: Uint8Array
  }
}

interface Box {
  id: number
  start: number
  ready: number
  end: number
  warm: boolean
  load: number
  idleSince: number
  busySince: number
  busy: number
}

// Event kinds; lower value wins ties so capacity frees before new work is placed.
const DONE = 0
const READY = 1
const IDLE = 2

class Heap {
  t: number[] = []
  k: number[] = []
  c: number[] = []
  x: number[] = []
  get size() {
    return this.t.length
  }
  private less(i: number, j: number) {
    return this.t[i] < this.t[j] || (this.t[i] === this.t[j] && this.k[i] < this.k[j])
  }
  private swap(i: number, j: number) {
    const { t, k, c, x } = this
    let v = t[i]; t[i] = t[j]; t[j] = v
    v = k[i]; k[i] = k[j]; k[j] = v
    v = c[i]; c[i] = c[j]; c[j] = v
    v = x[i]; x[i] = x[j]; x[j] = v
  }
  push(t: number, k: number, c: number, x: number) {
    this.t.push(t), this.k.push(k), this.c.push(c), this.x.push(x)
    let i = this.t.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!this.less(i, p)) break
      this.swap(i, p)
      i = p
    }
  }
  pop(): [number, number, number, number] {
    const top: [number, number, number, number] = [this.t[0], this.k[0], this.c[0], this.x[0]]
    const last = this.t.length - 1
    this.swap(0, last)
    this.t.pop(), this.k.pop(), this.c.pop(), this.x.pop()
    let i = 0
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let m = i
      if (l < last && this.less(l, m)) m = l
      if (r < last && this.less(r, m)) m = r
      if (m === i) break
      this.swap(i, m)
      i = m
    }
    return top
  }
}

export function percentile(sorted: ArrayLike<number>, q: number) {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[i]
}

export function simulate(trace: Trace, cfg: SimConfig, opts: { buckets?: number; detail?: boolean } = {}): SimResult {
  const n = trace.t.length
  const maxIn = Math.max(1, Math.floor(cfg.maxInputs))
  const target = Math.max(1, Math.floor(targetOf(cfg)))
  const maxC = Math.max(1, Math.floor(cfg.maxContainers))
  const minC = Math.min(maxC, Math.max(0, Math.floor(cfg.minContainers)))
  const buffer = Math.max(0, Math.floor(cfg.bufferContainers))
  const window = Math.max(0, cfg.scaledownWindow)
  const cold = coldStartSec(cfg)
  const dur = (i: number) => (trace.d ? trace.d[i] : cfg.serviceMean)

  const boxes: Box[] = []
  let alive: Box[] = []
  const queue: number[] = []
  let qHead = 0
  let inflight = 0
  const heap = new Heap()

  const dispatchT = new Float64Array(n)
  const doneT = new Float64Array(n)
  const coldHit = new Uint8Array(n)
  const assigned = new Int32Array(n).fill(-1)

  const B = opts.buckets ?? 240
  const bucketSec = trace.horizon / B
  const bucketOf = (t: number) => Math.min(B - 1, Math.max(0, Math.floor(t / bucketSec)))
  const qPeak = new Array<number>(B).fill(0)

  const spawn = (now: number, warm: boolean) => {
    const b: Box = { id: boxes.length, start: now, ready: warm ? now : now + cold, end: Infinity, warm, load: 0, idleSince: now, busySince: 0, busy: 0 }
    boxes.push(b)
    alive.push(b)
    if (warm) heap.push(now + window, IDLE, b.id, now)
    else heap.push(b.ready, READY, b.id, 0)
  }

  const assign = (i: number, b: Box, now: number, isCold: boolean) => {
    if (b.load === 0) b.busySince = now
    b.load++
    inflight++
    assigned[i] = b.id
    dispatchT[i] = now
    coldHit[i] = isCold ? 1 : 0
    doneT[i] = now + dur(i)
    heap.push(doneT[i], DONE, b.id, i)
  }

  const pick = (): Box | null => {
    // Pack containers up to target_inputs; burst toward max_inputs only when all are at target.
    let packed: Box | null = null
    let burst: Box | null = null
    for (const b of alive) {
      if (!b.warm) continue
      if (b.load < target && (!packed || b.load > packed.load)) packed = b
      else if (b.load < maxIn && (!burst || b.load < burst.load)) burst = b
    }
    return packed ?? burst
  }

  const reconcile = (now: number) => {
    const demand = inflight + (queue.length - qHead)
    let desired = demand > 0 ? Math.ceil(demand / target) + buffer : 0
    desired = Math.min(maxC, Math.max(minC, desired))
    if (alive.length < desired) {
      for (let k = alive.length; k < desired; k++) spawn(now, false)
    } else if (alive.length > desired) {
      // Only containers idle for the full scaledown_window are reclaimed.
      const expired = alive.filter((b) => b.warm && b.load === 0 && b.idleSince + window <= now + 1e-9).sort((a, b) => a.idleSince - b.idleSince)
      const kill = new Set(expired.slice(0, alive.length - desired))
      if (kill.size) {
        for (const b of kill) b.end = now
        alive = alive.filter((b) => !kill.has(b))
      }
    }
  }

  for (let k = 0; k < minC; k++) spawn(0, true)

  let next = 0
  let now = 0
  let peak = alive.length
  while (next < n || heap.size > 0) {
    const takeArrival = next < n && (heap.size === 0 || trace.t[next] < heap.t[0])
    if (takeArrival) {
      const i = next++
      now = trace.t[i]
      const b = pick()
      if (b) assign(i, b, now, false)
      else {
        queue.push(i)
        const bi = bucketOf(now)
        qPeak[bi] = Math.max(qPeak[bi], queue.length - qHead)
      }
    } else {
      const [t, kind, cid, x] = heap.pop()
      now = t
      const b = boxes[cid]
      if (kind === DONE) {
        b.load--
        inflight--
        if (qHead < queue.length) assign(queue[qHead++], b, now, false)
        else if (b.load === 0) {
          b.busy += now - b.busySince
          b.idleSince = now
          heap.push(now + window, IDLE, b.id, now)
        }
      } else if (kind === READY) {
        b.warm = true
        b.idleSince = now
        while (qHead < queue.length && b.load < maxIn) assign(queue[qHead++], b, now, true)
        if (b.load === 0) heap.push(now + window, IDLE, b.id, now)
      } else if (kind === IDLE) {
        if (b.end !== Infinity || b.load > 0 || b.idleSince !== x) continue
      }
    }
    reconcile(now)
    if (alive.length > peak) peak = alive.length
    if (qHead > 4096 && qHead * 2 > queue.length) {
      queue.splice(0, qHead)
      qHead = 0
    }
  }

  // Close the books: anything still alive (min_containers) is billed to the end of the window.
  let lastDone = 0
  for (let i = 0; i < n; i++) if (doneT[i] > lastDone) lastDone = doneT[i]
  const end = Math.max(trace.horizon, lastDone)
  for (const b of boxes) {
    if (b.end === Infinity || b.end > end) b.end = end
    if (b.load > 0) b.busy += b.end - b.busySince
  }

  const price = containerPricePerSec(cfg.gpu, cfg.gpuCount, cfg.cpuCores, cfg.memoryGiB)
  let billed = 0
  let boot = 0
  let busy = 0
  for (const b of boxes) {
    billed += b.end - b.start
    boot += Math.min(b.end, b.ready) - b.start
    busy += b.busy
  }
  const idle = Math.max(0, billed - boot - busy)

  const lat = new Float64Array(n)
  const qt = new Float64Array(n)
  let coldCount = 0
  let queued = 0
  let sum = 0
  let qSum = 0
  for (let i = 0; i < n; i++) {
    qt[i] = dispatchT[i] - trace.t[i]
    lat[i] = doneT[i] - trace.t[i]
    sum += lat[i]
    qSum += qt[i]
    coldCount += coldHit[i]
    if (qt[i] > 1e-9) queued++
  }

  // Timeline
  const load = new Array<number>(B).fill(0)
  const coldB = new Array<number>(B).fill(0)
  for (let i = 0; i < n; i++) {
    const bi = bucketOf(trace.t[i])
    load[bi]++
    if (coldHit[i]) coldB[bi]++
  }
  const aliveB = new Array<number>(B).fill(0)
  const bootB = new Array<number>(B).fill(0)
  const addSpan = (arr: number[], a: number, z: number) => {
    a = Math.max(0, a)
    z = Math.min(trace.horizon, z)
    if (z <= a) return
    const i0 = bucketOf(a)
    const i1 = bucketOf(z - 1e-9)
    for (let i = i0; i <= i1; i++) {
      const lo = Math.max(a, i * bucketSec)
      const hi = Math.min(z, (i + 1) * bucketSec)
      arr[i] += (hi - lo) / bucketSec
    }
  }
  const neededB = new Array<number>(B).fill(0)
  for (let i = 0; i < n; i++) addSpan(neededB, trace.t[i], doneT[i])
  for (const b of boxes) {
    addSpan(aliveB, b.start, b.end)
    addSpan(bootB, b.start, Math.min(b.end, b.ready))
  }

  // Latency histogram on log bins
  const sorted = lat.slice().sort()
  const lo = Math.max(0.005, (sorted[0] ?? 0.01) * 0.9)
  const hi = Math.max(lo * 10, (sorted[n - 1] ?? 1) * 1.05)
  const NB = 36
  const edges = Array.from({ length: NB + 1 }, (_, i) => lo * Math.pow(hi / lo, i / NB))
  const counts = new Array<number>(NB).fill(0)
  const coldCounts = new Array<number>(NB).fill(0)
  const logSpan = Math.log(hi / lo)
  for (let i = 0; i < n; i++) {
    const bi = Math.min(NB - 1, Math.max(0, Math.floor((Math.log(Math.max(lat[i], lo) / lo) / logSpan) * NB)))
    counts[bi]++
    if (coldHit[i]) coldCounts[bi]++
  }

  const cost = billed * price
  const sortedQ = qt.slice().sort()
  return {
    n,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    mean: n ? sum / n : 0,
    coldCount,
    coldPct: n ? (coldCount / n) * 100 : 0,
    queuedPct: n ? (queued / n) * 100 : 0,
    queueMean: n ? qSum / n : 0,
    queueP99: percentile(sortedQ, 0.99),
    cost,
    busyCost: busy * price,
    idleCost: idle * price,
    bootCost: boot * price,
    costPer1k: n ? (cost / n) * 1000 : 0,
    costPerDay: (cost / end) * 86400,
    horizon: end,
    containersStarted: boxes.length - minC,
    peakContainers: peak,
    coldStartSec: cold,
    timeline: { bucketSec, load: load.map((v) => v / bucketSec), alive: aliveB, needed: neededB.map((v) => v / target), booting: bootB, cold: coldB, queue: qPeak },
    hist: { edges, counts, coldCounts },
    detail: opts.detail
      ? { containers: boxes.map((b) => ({ start: b.start, ready: b.ready, end: b.end })), container: assigned, dispatch: dispatchT, done: doneT, cold: coldHit }
      : undefined,
  }
}
