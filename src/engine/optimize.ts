import { simulate, type SimConfig, type SimResult } from './sim.ts'
import type { Trace } from './traffic.ts'

export type Knobs = Pick<SimConfig, 'minContainers' | 'bufferContainers' | 'scaledownWindow' | 'targetInputs'>

export interface GridPoint {
  knobs: Knobs
  cost: number
  costPerDay: number
  p99: number
  p95: number
  coldPct: number
  pareto: boolean
}

export function gridFor(cfg: SimConfig): Knobs[] {
  const mins = [...new Set([0, 1, 2, 4, cfg.minContainers])].filter((v) => v <= cfg.maxContainers)
  const buffers = [...new Set([0, 1, 2, 4, cfg.bufferContainers])]
  // Modal accepts 2s..1200s.
  const windows = [...new Set([2, 15, 60, 180, 600, 1200, cfg.scaledownWindow])]
  const targets = cfg.maxInputs > 1 ? [...new Set([0, Math.max(1, Math.round(cfg.maxInputs * 0.6)), cfg.targetInputs])] : [cfg.targetInputs]
  const out: Knobs[] = []
  for (const minContainers of mins)
    for (const bufferContainers of buffers)
      for (const scaledownWindow of windows)
        for (const targetInputs of targets) out.push({ minContainers, bufferContainers, scaledownWindow, targetInputs })
  return out
}

/** Marks points not dominated on (cost, p99). Returns frontier sorted by cost. */
export function pareto<T extends { cost: number; p99: number; pareto?: boolean }>(pts: T[]): T[] {
  const sorted = pts.slice().sort((a, b) => a.cost - b.cost || a.p99 - b.p99)
  const front: T[] = []
  let best = Infinity
  for (const p of sorted) {
    if (p.p99 < best - 1e-9) {
      front.push(p)
      best = p.p99
    }
  }
  for (const p of pts) p.pareto = front.includes(p)
  return front
}

export function runGrid(trace: Trace, cfg: SimConfig, onProgress?: (done: number, total: number) => void): GridPoint[] {
  const grid = gridFor(cfg)
  const pts: GridPoint[] = grid.map((knobs, i) => {
    const r = simulate(trace, { ...cfg, ...knobs }, { buckets: 8 })
    onProgress?.(i + 1, grid.length)
    return { knobs, cost: r.cost, costPerDay: r.costPerDay, p99: r.p99, p95: r.p95, coldPct: r.coldPct, pareto: false }
  })
  pareto(pts)
  return pts
}

/** Cheapest frontier point meeting the p99 SLO, else the fastest one. */
export function recommend(front: GridPoint[], sloSec: number): GridPoint | null {
  if (front.length === 0) return null
  return front.find((p) => p.p99 <= sloSec) ?? front[front.length - 1]
}

// ---------- plain-English explanations ----------

export const usd = (v: number) =>
  v === 0 ? '$0' : Math.abs(v) >= 100 ? `$${v.toFixed(0)}` : Math.abs(v) >= 1 ? `$${v.toFixed(2)}` : Math.abs(v) >= 0.01 ? `$${v.toFixed(3)}` : `$${v.toFixed(4)}`

export const pct = (v: number) => (v > 0 && v < 0.1 ? '<0.1%' : `${v.toFixed(v < 10 ? 1 : 0)}%`)

export const secs = (v: number) => (v < 1 ? `${Math.round(v * 1000)} ms` : v < 120 ? `${v.toFixed(v < 10 ? 2 : 1)} s` : `${(v / 60).toFixed(1)} min`)

export interface Insight {
  change: Partial<SimConfig>
  label: string
  text: string
  coldDelta: number
  costDelta: number
  p99Delta: number
}

function describe(label: string, base: SimResult, r: SimResult): string {
  const dDay = r.costPerDay - base.costPerDay
  const money = Math.abs(dDay) < 0.005 ? 'at no extra cost' : dDay > 0 ? `for +${usd(dDay)}/day` : `and saves ${usd(-dDay)}/day`
  let cold: string
  if (r.coldStartSec < base.coldStartSec) cold = `cuts each cold start from ${secs(base.coldStartSec)} to ${secs(r.coldStartSec)}`
  else if (base.coldCount === 0 && r.coldCount === 0) cold = 'keeps cold starts at zero'
  else if (r.coldCount <= base.coldCount) {
    const pct = base.coldCount ? Math.round((1 - r.coldCount / base.coldCount) * 100) : 0
    cold = pct === 0 ? 'barely changes cold starts' : `removes ${pct}% of cold starts`
  } else cold = `adds ${r.coldCount - base.coldCount} cold-start hits`
  return `${label} ${cold} ${money} (p99 ${secs(base.p99)} → ${secs(r.p99)}).`
}

export function explain(trace: Trace, cfg: SimConfig, base: SimResult): Insight[] {
  const tries: [string, Partial<SimConfig>][] = [
    [`buffer_containers=${cfg.bufferContainers + 1}`, { bufferContainers: cfg.bufferContainers + 1 }],
    [`min_containers=${cfg.minContainers + 1}`, { minContainers: Math.min(cfg.maxContainers, cfg.minContainers + 1) }],
    cfg.scaledownWindow < 600
      ? [`scaledown_window=${Math.min(1200, Math.max(300, cfg.scaledownWindow * 4))}`, { scaledownWindow: Math.min(1200, Math.max(300, cfg.scaledownWindow * 4)) }]
      : [`scaledown_window=60`, { scaledownWindow: 60 }],
  ]
  if (!cfg.snapshot) tries.push(['enable_memory_snapshot=True', { snapshot: true }])
  if (cfg.minContainers > 0) tries.push([`min_containers=0`, { minContainers: 0 }])
  if (cfg.bufferContainers > 0) tries.push([`buffer_containers=0`, { bufferContainers: 0 }])
  return tries.map(([label, change]) => {
    const r = simulate(trace, { ...cfg, ...change }, { buckets: 8 })
    return {
      change,
      label,
      text: describe(label, base, r),
      coldDelta: r.coldPct - base.coldPct,
      costDelta: r.costPerDay - base.costPerDay,
      p99Delta: r.p99 - base.p99,
    }
  })
}

export function knobLabel(k: Knobs) {
  const parts = [`min_containers=${k.minContainers}`, `buffer_containers=${k.bufferContainers}`, `scaledown_window=${k.scaledownWindow}`]
  if (k.targetInputs > 0) parts.push(`target_inputs=${k.targetInputs}`)
  return parts.join(', ')
}

/** Plain-English verdict on moving from the current config to a grid point. */
export function explainPoint(base: SimResult, pt: GridPoint, sloSec: number): string {
  const dDay = pt.costPerDay - base.costPerDay
  const money = Math.abs(dDay) < 0.005 ? 'at the same cost' : dDay > 0 ? `for +${usd(dDay)}/day` : `while saving ${usd(-dDay)}/day`
  const baseCold = base.coldPct
  const cold =
    baseCold > 0 && pt.coldPct < baseCold
      ? `removes ${Math.round((1 - pt.coldPct / baseCold) * 100)}% of cold starts`
      : pt.coldPct > baseCold
        ? `lets cold-start hits rise from ${baseCold.toFixed(1)}% to ${pt.coldPct.toFixed(1)}%`
        : 'leaves cold starts unchanged'
  const slo = pt.p99 <= sloSec ? `meets your ${secs(sloSec)} p99 target` : `still misses your ${secs(sloSec)} p99 target, but it is the fastest option found`
  return `${knobLabel(pt.knobs)} ${slo}: p99 ${secs(base.p99)} → ${secs(pt.p99)}, ${cold} ${money}.`
}

/** One-paragraph read of a run: where the money goes and who feels cold starts. */
export function diagnose(r: SimResult): string {
  const idleShare = r.cost ? ((r.idleCost + r.bootCost) / r.cost) * 100 : 0
  const money = `${Math.round(idleShare)}% of spend (${usd(((r.idleCost + r.bootCost) / r.horizon) * 86400)}/day) pays for containers that are idle or booting.`
  if (r.coldCount === 0) return `${money} No request waited on a cold start.`
  const who = `${pct(r.coldPct)} of requests wait on a ${secs(r.coldStartSec)} cold start.`
  const blind = r.coldPct < 1 ? ' That is under 1% of traffic, so p99 hides it: those users still see the full wait.' : ''
  return `${money} ${who}${blind}`
}
