import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { knobLabel, secs, usd, type GridPoint } from './engine/optimize.ts'
import type { SimConfig, SimResult, Timeline } from './engine/sim.ts'

function useWidth(initial = 800) {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(initial)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth || initial)
    const ro = new ResizeObserver(() => setW(el.clientWidth || initial))
    ro.observe(el)
    return () => ro.disconnect()
  }, [initial])
  return [ref, w] as const
}

function niceTicks(max: number, n = 4) {
  if (max <= 0) return [0]
  const raw = max / n
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const out: number[] = []
  for (let v = 0; v <= max + step * 1e-6; v += step) out.push(Number(v.toFixed(6)))
  return out
}

function logTicks(lo: number, hi: number) {
  const all: number[] = []
  for (let e = -3; e <= 5; e++) for (const m of [1, 2, 5]) all.push(m * 10 ** e)
  const inside = all.filter((v) => v >= lo && v <= hi)
  return inside.length > 6 ? inside.filter((_, i) => i % 2 === 0) : inside
}

const fmtN = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : v >= 10 || Number.isInteger(v) ? v.toFixed(0) : v.toFixed(v < 1 ? 2 : 1))

export function fmtClock(sec: number, horizon: number) {
  if (horizon <= 7200) {
    const m = Math.floor(sec / 60)
    return `${m}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
  }
  const h = Math.floor(sec / 3600)
  return `${h}h${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`
}

export function Legend({ items }: { items: { label: string; color: string; shape?: 'line' | 'tick' | 'block' }[] }) {
  return (
    <ul className="legend">
      {items.map((i) => (
        <li key={i.label}>
          <i className={`swatch ${i.shape ?? 'block'}`} style={{ background: i.color }} />
          {i.label}
        </li>
      ))}
    </ul>
  )
}

function Tip({ x, y, w, children }: { x: number; y: number; w: number; children: ReactNode }) {
  const left = Math.min(x + 12, w - 190)
  return (
    <div className="tip" style={{ left: Math.max(0, left), top: Math.max(0, y - 8) }}>
      {children}
    </div>
  )
}

/** Sweeps a playhead over the run: containers vs demand vs load vs cold hits, replayed. */
export function TimelineChart({ tl, horizon, autoplayKey }: { tl: Timeline; horizon: number; autoplayKey: number }) {
  const [ref, W] = useWidth()
  const [play, setPlay] = useState<number | null>(null)
  const [cursor, setCursor] = useState<number | null>(null)
  const raf = useRef(0)
  const n = tl.alive.length
  const M = { l: 40, r: 12 }
  const iw = Math.max(10, W - M.l - M.r)
  const topH = 170
  const stripY = topH + 14
  const lowY = stripY + 26
  const lowH = 60
  const H = lowY + lowH + 24

  const stop = () => {
    cancelAnimationFrame(raf.current)
    setPlay(null)
  }
  const start = (ms: number) => {
    cancelAnimationFrame(raf.current)
    const t0 = performance.now()
    const tick = () => {
      const u = (performance.now() - t0) / ms
      if (u >= 1) return setPlay(null)
      setPlay(u)
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
  }
  useEffect(() => {
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) start(3200)
    return () => cancelAnimationFrame(raf.current)
    // Replay only when a new trace loads, not on every knob nudge.
  }, [autoplayKey]) // eslint-disable-line

  const { paths, yTop, yLow, topMax, lowMax } = useMemo(() => {
    const topMax = Math.max(1, ...tl.alive, ...tl.needed)
    const lowMax = Math.max(0.01, ...tl.load)
    const x = (i: number) => M.l + (iw * (i + 0.5)) / n
    const yTop = (v: number) => 8 + (topH - 8) * (1 - v / topMax)
    const yLow = (v: number) => lowY + lowH * (1 - v / lowMax)
    const line = (a: number[], y: (v: number) => number) => a.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('')
    const area = (a: number[], y: (v: number) => number, base: number) => `${line(a, y)}L${x(n - 1).toFixed(1)} ${base}L${x(0).toFixed(1)} ${base}Z`
    return {
      yTop,
      yLow,
      topMax,
      lowMax,
      paths: {
        alive: line(tl.alive, yTop),
        aliveArea: area(tl.alive, yTop, topH),
        needed: area(tl.needed, yTop, topH),
        booting: area(tl.booting, yTop, topH),
        load: area(tl.load, yLow, lowY + lowH),
      },
    }
  }, [tl, iw, n, lowY, M.l])

  const coldPeak = Math.max(1, ...tl.cold)
  const clipW = play === null ? iw + 2 : iw * play
  const phX = M.l + clipW
  const idx = cursor ?? (play !== null ? Math.min(n - 1, Math.floor(play * n)) : null)
  const clipId = `tl-clip-${autoplayKey}`

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const i = Math.floor(((e.clientX - r.left - M.l) / iw) * n)
    setCursor(i >= 0 && i < n ? i : null)
  }
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const step = e.key === 'ArrowLeft' ? -1 : 1
    setCursor((c) => Math.min(n - 1, Math.max(0, (c ?? Math.floor(n / 2)) + step)))
  }
  const xTicks = W < 520 ? 4 : 8

  return (
    <div className="chart" ref={ref}>
      <div className="chart-toolbar">
        <Legend
          items={[
            { label: 'Containers alive', color: 'var(--viz-alive)', shape: 'line' },
            { label: 'Containers needed (in flight ÷ target)', color: 'var(--viz-load)' },
            { label: 'Booting', color: 'var(--viz-cold)' },
            { label: 'Cold-start hits', color: 'var(--viz-cold)', shape: 'tick' },
          ]}
        />
        <button className="btn btn-ghost btn-xs" onClick={() => (play === null ? start(7000) : stop())} aria-label={play === null ? 'Replay timeline' : 'Stop replay'}>
          {play === null ? '▶ Replay' : '■ Stop'}
        </button>
      </div>
      <svg
        width={W}
        height={H}
        role="img"
        tabIndex={0}
        aria-label={`Timeline over ${fmtClock(horizon, horizon)}. Peak ${Math.ceil(topMax)} containers, peak load ${fmtN(lowMax)} requests per second. Use left and right arrows to scrub.`}
        onPointerMove={onMove}
        onPointerLeave={() => setCursor(null)}
        onKeyDown={onKey}
        onBlur={() => setCursor(null)}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={M.l} y={0} width={clipW} height={H} />
          </clipPath>
        </defs>
        {niceTicks(topMax, 4).map((v) => (
          <g key={v}>
            <line x1={M.l} x2={W - M.r} y1={yTop(v)} y2={yTop(v)} className="grid" />
            <text x={M.l - 8} y={yTop(v) + 3} className="tick" textAnchor="end">
              {fmtN(v)}
            </text>
          </g>
        ))}
        <text x={M.l} y={lowY - 5} className="tick">
          LOAD, REQ/S (peak {fmtN(lowMax)})
        </text>
        <text x={M.l - 8} y={stripY + 8} className="tick" textAnchor="end">
          cold
        </text>
        <line x1={M.l} x2={W - M.r} y1={lowY + lowH} y2={lowY + lowH} className="axis" />
        <g clipPath={`url(#${clipId})`}>
          <path d={paths.aliveArea} fill="var(--viz-alive)" opacity=".1" />
          <path d={paths.needed} fill="var(--viz-load)" opacity=".42" />
          <path d={paths.booting} fill="var(--viz-cold)" opacity=".75" />
          <path d={paths.alive} fill="none" stroke="var(--viz-alive)" strokeWidth="2" strokeLinejoin="round" />
          <path d={paths.load} fill="var(--viz-load)" opacity=".7" />
          {tl.cold.map((v, i) =>
            v ? <rect key={i} x={M.l + (iw * i) / n} y={stripY + 8 - (6 * v) / coldPeak - 2} width={Math.max(1.5, iw / n - 1)} height={(6 * v) / coldPeak + 3} rx={1} fill="var(--viz-cold)" /> : null,
          )}
        </g>
        {niceTicks(horizon, xTicks)
          .filter((v) => v < horizon * 0.98)
          .map((v) => (
            <text key={v} x={M.l + (iw * v) / horizon} y={H - 8} className="tick" textAnchor="middle">
              {fmtClock(v, horizon)}
            </text>
          ))}
        {play !== null && <line x1={phX} x2={phX} y1={0} y2={lowY + lowH} className="playhead" />}
        {cursor !== null && <line x1={M.l + (iw * (cursor + 0.5)) / n} x2={M.l + (iw * (cursor + 0.5)) / n} y1={0} y2={lowY + lowH} className="crosshair" />}
      </svg>
      {idx !== null && (
        <Tip x={M.l + (iw * (idx + 0.5)) / n} y={8} w={W}>
          <b>t = {fmtClock((idx + 0.5) * tl.bucketSec, horizon)}</b>
          <span>
            alive <em>{tl.alive[idx].toFixed(1)}</em>
          </span>
          <span>
            needed <em>{tl.needed[idx].toFixed(1)}</em>
          </span>
          <span>
            load <em>{tl.load[idx].toFixed(2)} req/s</em>
          </span>
          <span>
            cold hits <em>{tl.cold[idx]}</em>
          </span>
          {tl.queue[idx] > 0 && (
            <span>
              peak queue <em>{tl.queue[idx]}</em>
            </span>
          )}
        </Tip>
      )}
    </div>
  )
}

export function LatencyHistogram({ r }: { r: SimResult }) {
  const [ref, W] = useWidth(500)
  const [hover, setHover] = useState<number | null>(null)
  const H = 210
  const M = { l: 44, r: 12, t: 38, b: 28 }
  const iw = Math.max(10, W - M.l - M.r)
  const ih = H - M.t - M.b
  const { edges, counts, coldCounts } = r.hist
  const lo = edges[0]
  const hi = edges[edges.length - 1]
  const x = (v: number) => M.l + (iw * Math.log(Math.max(v, lo) / lo)) / Math.log(hi / lo)
  const peak = Math.max(1, ...counts)
  const y = (v: number) => M.t + ih * (1 - v / peak)
  const marks = [
    ['p50', r.p50],
    ['p95', r.p95],
    ['p99', r.p99],
  ] as const
  // Stagger labels that would collide.
  const labelled = marks.map(([l, v], i) => ({ l, v, row: i > 0 && x(v) - x(marks[i - 1][1]) < 34 ? i : 0 }))
  return (
    <div className="chart" ref={ref}>
      <div className="chart-toolbar">
        <Legend
          items={[
            { label: 'Served warm', color: 'var(--viz-alive)' },
            { label: 'Waited on a cold start', color: 'var(--viz-cold)' },
          ]}
        />
      </div>
      <svg width={W} height={H} role="img" aria-label={`Latency histogram on a log scale. p50 ${secs(r.p50)}, p95 ${secs(r.p95)}, p99 ${secs(r.p99)}.`} onPointerLeave={() => setHover(null)}>
        {niceTicks(peak, 3).map((v) => (
          <g key={v}>
            <line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} className="grid" />
            <text x={M.l - 8} y={y(v) + 3} className="tick" textAnchor="end">
              {fmtN(v)}
            </text>
          </g>
        ))}
        {counts.map((c, i) => {
          const x0 = x(edges[i]) + 1
          const bw = Math.max(1, x(edges[i + 1]) - x(edges[i]) - 2)
          const warm = c - coldCounts[i]
          const hWarm = (warm / peak) * ih
          const hCold = (coldCounts[i] / peak) * ih
          return (
            <g key={i} onPointerEnter={() => setHover(i)}>
              <rect x={x0 - 1} y={M.t} width={bw + 2} height={ih} fill="transparent" />
              {warm > 0 && <rect x={x0} y={M.t + ih - Math.max(1, hWarm)} width={bw} height={Math.max(1, hWarm)} rx={1.5} fill="var(--viz-alive)" opacity={hover === null || hover === i ? 1 : 0.5} />}
              {coldCounts[i] > 0 && <rect x={x0} y={M.t + ih - hWarm - Math.max(2, hCold) - (warm > 0 ? 2 : 0)} width={bw} height={Math.max(2, hCold)} rx={1.5} fill="var(--viz-cold)" opacity={hover === null || hover === i ? 1 : 0.5} />}
            </g>
          )
        })}
        {labelled.map(({ l, v, row }) => (
          <g key={l}>
            <line x1={x(v)} x2={x(v)} y1={M.t - 2} y2={M.t + ih} className="marker" />
            <text x={Math.min(W - 26, x(v) + 3)} y={M.t - 6 - row * 11} className="tick strong">
              {l}
            </text>
          </g>
        ))}
        {logTicks(lo, hi).map((v) => (
          <text key={v} x={x(v)} y={H - 10} className="tick" textAnchor="middle">
            {v < 1 ? `${Math.round(v * 1000)}ms` : v < 120 ? `${v}s` : `${(v / 60).toFixed(0)}m`}
          </text>
        ))}
        <line x1={M.l} x2={W - M.r} y1={M.t + ih} y2={M.t + ih} className="axis" />
      </svg>
      {hover !== null && (
        <Tip x={x(edges[hover])} y={M.t} w={W}>
          <b>
            {secs(edges[hover])} – {secs(edges[hover + 1])}
          </b>
          <span>
            warm <em>{counts[hover] - coldCounts[hover]}</em>
          </span>
          <span>
            cold <em>{coldCounts[hover]}</em>
          </span>
        </Tip>
      )}
    </div>
  )
}

export function ParetoChart({
  points,
  current,
  cfg,
  rec,
  slo,
  onPick,
}: {
  points: GridPoint[]
  current: SimResult
  cfg: SimConfig
  rec: GridPoint | null
  slo: number
  onPick: (p: GridPoint) => void
}) {
  const [ref, W] = useWidth()
  const [hover, setHover] = useState<GridPoint | null>(null)
  const H = 340
  const M = { l: 72, r: 18, t: 16, b: 40 }
  const iw = Math.max(10, W - M.l - M.r)
  const ih = H - M.t - M.b
  const maxX = Math.max(current.costPerDay, ...points.map((p) => p.costPerDay)) * 1.04
  const ps = points.map((p) => p.p99).concat(current.p99, slo)
  const loY = Math.min(...ps) * 0.85
  const hiY = Math.max(...ps) * 1.15
  const x = (v: number) => M.l + (iw * v) / Math.max(1e-9, maxX)
  const y = (v: number) => M.t + ih * (1 - Math.log(v / loY) / Math.log(hiY / loY))
  const front = useMemo(() => points.filter((p) => p.pareto).sort((a, b) => a.cost - b.cost), [points])
  const step = front.map((p, i) => (i ? `L${x(p.costPerDay).toFixed(1)} ${y(front[i - 1].p99).toFixed(1)}L${x(p.costPerDay).toFixed(1)} ${y(p.p99).toFixed(1)}` : `M${x(p.costPerDay).toFixed(1)} ${y(p.p99).toFixed(1)}`)).join('')
  const same = (p: GridPoint) => p.knobs.minContainers === cfg.minContainers && p.knobs.bufferContainers === cfg.bufferContainers && p.knobs.scaledownWindow === cfg.scaledownWindow && p.knobs.targetInputs === cfg.targetInputs
  const others = points.filter((p) => !p.pareto)
  const sloY = y(slo)
  return (
    <div className="chart" ref={ref}>
      <div className="chart-toolbar">
        <Legend
          items={[
            { label: 'Pareto frontier (click to apply)', color: 'var(--viz-alive)', shape: 'line' },
            { label: 'Dominated config', color: 'var(--muted)' },
            { label: 'Your current config', color: 'var(--viz-cold)' },
            { label: 'p99 target', color: 'var(--viz-queue)', shape: 'line' },
          ]}
        />
      </div>
      <svg width={W} height={H} role="group" aria-label="Cost per day against p99 latency for every configuration tried. Frontier points are buttons." onPointerLeave={() => setHover(null)}>
        {niceTicks(maxX, W < 520 ? 3 : 6).map((v) => (
          <g key={v}>
            <line x1={x(v)} x2={x(v)} y1={M.t} y2={M.t + ih} className="grid" />
            <text x={x(v)} y={H - 22} className="tick" textAnchor="middle">
              {usd(v)}
            </text>
          </g>
        ))}
        {logTicks(loY, hiY).map((v) => (
          <g key={v}>
            <line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} className="grid" />
            <text x={M.l - 8} y={y(v) + 3} className="tick" textAnchor="end">
              {secs(v)}
            </text>
          </g>
        ))}
        <text x={M.l + iw / 2} y={H - 5} className="tick" textAnchor="middle">
          COST PER DAY
        </text>
        <text transform={`translate(11 ${M.t + ih / 2}) rotate(-90)`} className="tick" textAnchor="middle">
          P99 LATENCY (LOG)
        </text>
        <line x1={M.l} x2={W - M.r} y1={sloY} y2={sloY} stroke="var(--viz-queue)" strokeWidth="1.5" strokeDasharray="5 4" />
        {others.map((p, i) => (
          <circle key={i} cx={x(p.costPerDay)} cy={y(p.p99)} r={hover === p ? 5 : 3} className="pt-dim" onPointerEnter={() => setHover(p)} onClick={() => onPick(p)} />
        ))}
        <path d={step} fill="none" stroke="var(--viz-alive)" strokeWidth="2" />
        {front.map((p, i) => (
          <g
            key={i}
            role="button"
            tabIndex={0}
            className="pt-front"
            aria-label={`${knobLabel(p.knobs)}: ${usd(p.costPerDay)} per day, p99 ${secs(p.p99)}. Apply.`}
            onPointerEnter={() => setHover(p)}
            onFocus={() => setHover(p)}
            onBlur={() => setHover(null)}
            onClick={() => onPick(p)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onPick(p)
              }
            }}
          >
            <circle cx={x(p.costPerDay)} cy={y(p.p99)} r={14} fill="transparent" />
            <circle className="dot" cx={x(p.costPerDay)} cy={y(p.p99)} r={hover === p ? 7 : 5} fill="var(--viz-alive)" stroke="var(--surface)" strokeWidth="2" />
            {same(p) && <circle cx={x(p.costPerDay)} cy={y(p.p99)} r={10} fill="none" stroke="var(--text)" strokeWidth="1.5" />}
          </g>
        ))}
        {rec && (
          <g pointerEvents="none">
            <circle cx={x(rec.costPerDay)} cy={y(rec.p99)} r={10} fill="none" stroke="var(--accent-strong)" strokeWidth="2" className="rec-ring" />
            <text x={Math.min(W - 90, x(rec.costPerDay) + 14)} y={y(rec.p99) - 12} className="tick strong">
              RECOMMENDED
            </text>
          </g>
        )}
        <rect x={x(current.costPerDay) - 5} y={y(current.p99) - 5} width={10} height={10} rx={2} transform={`rotate(45 ${x(current.costPerDay)} ${y(current.p99)})`} fill="var(--viz-cold)" stroke="var(--surface)" strokeWidth="2" pointerEvents="none" />
      </svg>
      {hover && (
        <Tip x={x(hover.costPerDay)} y={y(hover.p99) + 10} w={W}>
          <b>{usd(hover.costPerDay)}/day</b>
          <span>
            p99 <em>{secs(hover.p99)}</em>
          </span>
          <span>
            cold <em>{hover.coldPct.toFixed(1)}%</em>
          </span>
          <span>
            min <em>{hover.knobs.minContainers}</em>
          </span>
          <span>
            buffer <em>{hover.knobs.bufferContainers}</em>
          </span>
          <span>
            window <em>{hover.knobs.scaledownWindow}s</em>
          </span>
          {hover.knobs.targetInputs > 0 && (
            <span>
              target <em>{hover.knobs.targetInputs}</em>
            </span>
          )}
        </Tip>
      )}
    </div>
  )
}

export function Spark({ data, needed }: { data: number[]; needed: number[] }) {
  const W = 160
  const H = 34
  const peak = Math.max(1, ...data, ...needed)
  const pts = (a: number[]) => a.map((v, i) => `${((i / Math.max(1, a.length - 1)) * W).toFixed(1)},${(H - 2 - (v / peak) * (H - 4)).toFixed(1)}`).join(' ')
  return (
    <svg className="spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden>
      <polyline points={`0,${H} ${pts(needed)} ${W},${H}`} fill="var(--viz-load)" opacity=".4" />
      <polyline points={pts(data)} fill="none" stroke="var(--viz-alive)" strokeWidth="1.5" />
    </svg>
  )
}
