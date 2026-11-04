import { useEffect, useMemo, useRef, useState } from 'react'
import { simulate, type SimConfig } from './engine/sim.ts'
import { generate } from './engine/traffic.ts'
import { DEFAULT_CFG } from './engine/presets.ts'
import { containerPricePerSec } from './engine/pricing.ts'
import { secs, usd } from './engine/optimize.ts'

const SPEED = 6 // simulated seconds per wall second
const FLY = 1.4 // simulated seconds a request takes to travel on screen
const SLOTS = 10

const trace = generate({ kind: 'bursty', rate: 0.55, hours: 4 / 60, seed: 17, serviceMean: 4, serviceCv: 0.45 })

function readColors() {
  const s = getComputedStyle(document.documentElement)
  const v = (n: string) => s.getPropertyValue(n).trim()
  return {
    accent: v('--accent'),
    lime: v('--lime'),
    accentDim: v('--accent-dim'),
    cold: v('--viz-cold'),
    queue: v('--viz-queue'),
    load: v('--viz-load'),
    text: v('--text'),
    text2: v('--text-2'),
    muted: v('--muted'),
    line: v('--line'),
    surface: v('--surface'),
  }
}

type Knob = { buffer: number; min: number; window: number; snapshot: boolean }

export default function HeroSim() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [knob, setKnob] = useState<Knob>({ buffer: 0, min: 0, window: 20, snapshot: false })
  const cfg: SimConfig = useMemo(
    () => ({
      ...DEFAULT_CFG,
      maxContainers: SLOTS,
      minContainers: knob.min,
      bufferContainers: knob.buffer,
      scaledownWindow: knob.window,
      snapshot: knob.snapshot,
      bootSec: 1,
      imageSec: 5,
      modelSec: 10,
    }),
    [knob],
  )
  const run = useMemo(() => {
    const r = simulate(trace, cfg, { detail: true, buckets: 160 })
    const d = r.detail!
    // Stable on-screen slot per container: first free slot when it starts.
    const slotEnd = new Array<number>(SLOTS).fill(-1)
    const slot = d.containers.map((c) => {
      let k = slotEnd.findIndex((e) => e <= c.start)
      if (k < 0) k = 0
      slotEnd[k] = c.end + 1.5
      return k
    })
    const reqs: number[][] = d.containers.map(() => [])
    for (let i = 0; i < trace.t.length; i++) if (d.container[i] >= 0) reqs[d.container[i]].push(i)
    return { r, d, slot, reqs, price: containerPricePerSec(cfg.gpu, cfg.gpuCount, cfg.cpuCores, cfg.memoryGiB) }
  }, [cfg])
  const runRef = useRef(run)
  runRef.current = run
  const windowRef = useRef(knob.window)
  windowRef.current = knob.window
  const [hud, setHud] = useState({ t: 0, alive: 0, cold: 0, cost: 0, queued: 0 })

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    let colors = readColors()
    let mode = document.documentElement.dataset.themeMode
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf = 0
    let lastHud = 0
    const t0 = performance.now()
    const H = trace.horizon

    const resize = () => {
      const dpr = Math.min(2, devicePixelRatio || 1)
      canvas.width = canvas.clientWidth * dpr
      canvas.height = canvas.clientHeight * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    resize()

    const rr = (x: number, y: number, w: number, h: number, r: number) => {
      ctx.beginPath()
      ctx.roundRect(x, y, w, h, r)
    }

    const draw = (s: number) => {
      if (document.documentElement.dataset.themeMode !== mode) {
        mode = document.documentElement.dataset.themeMode
        colors = readColors()
      }
      const { d, slot, reqs, r, price } = runRef.current
      const W = canvas.clientWidth
      const Hh = canvas.clientHeight
      ctx.clearRect(0, 0, W, Hh)
      const narrow = W < 640
      const chartH = narrow ? 64 : 84
      const top = 16
      const areaH = Hh - chartH - top - 18
      const gateX = narrow ? W * 0.22 : W * 0.26
      const cols = narrow ? 2 : 5
      const rows = Math.ceil(SLOTS / cols)
      const gx0 = gateX + (narrow ? 22 : 56)
      const gap = 10
      const bw = (W - gx0 - 16 - gap * (cols - 1)) / cols
      const bh = Math.min(92, (areaH - gap * (rows - 1)) / rows)
      const gy0 = top + (areaH - (bh * rows + gap * (rows - 1))) / 2
      const slotXY = (k: number) => [gx0 + (k % cols) * (bw + gap), gy0 + Math.floor(k / cols) * (bh + gap)] as const
      const laneY = top + areaH / 2
      ctx.font = '500 10px "DM Mono", ui-monospace, monospace'
      ctx.textBaseline = 'middle'

      // Lane + gate
      ctx.strokeStyle = colors.line
      ctx.setLineDash([2, 4])
      ctx.beginPath()
      ctx.moveTo(8, laneY)
      ctx.lineTo(gateX, laneY)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = colors.muted
      ctx.fillText('INPUTS →', 8, top + 4)
      ctx.fillText('QUEUE', gateX - 34, top + 4)
      ctx.fillText('CONTAINERS', gx0, top + 4)

      // Containers
      const aliveNow: number[] = []
      for (let c = 0; c < d.containers.length; c++) {
        const k = d.containers[c]
        if (s < k.start || s > k.end + 1.5) continue
        const [x, y] = slotXY(slot[c])
        const fade = s > k.end ? 1 - (s - k.end) / 1.5 : Math.min(1, (s - k.start) / 0.6)
        ctx.globalAlpha = Math.max(0, fade)
        if (s <= k.end) aliveNow.push(c)
        if (s < k.ready) {
          const p = (s - k.start) / Math.max(0.001, k.ready - k.start)
          rr(x, y, bw, bh, 8)
          ctx.fillStyle = colors.surface
          ctx.fill()
          ctx.setLineDash([4, 4])
          ctx.lineDashOffset = -s * 8
          ctx.strokeStyle = colors.cold
          ctx.stroke()
          ctx.setLineDash([])
          ctx.save()
          rr(x, y, bw, bh, 8)
          ctx.clip()
          ctx.fillStyle = colors.cold
          ctx.globalAlpha *= 0.16
          ctx.fillRect(x, y + bh * (1 - p), bw, bh * p)
          ctx.restore()
          ctx.globalAlpha = Math.max(0, fade)
          // spinner
          ctx.strokeStyle = colors.cold
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.arc(x + bw - 16, y + 16, 6, s * 4, s * 4 + 4)
          ctx.stroke()
          ctx.lineWidth = 1
          ctx.fillStyle = colors.cold
          ctx.fillText('COLD START', x + 10, y + 16)
          ctx.fillStyle = colors.text2
          ctx.fillText(`${(k.ready - s).toFixed(1)}s`, x + 10, y + bh - 14)
        } else {
          let load = 0
          let lastDone = k.ready
          for (const i of reqs[c]) {
            if (d.dispatch[i] <= s && s < d.done[i]) load++
            if (d.done[i] <= s && d.done[i] > lastDone) lastDone = d.done[i]
          }
          rr(x, y, bw, bh, 8)
          if (load > 0) {
            const pulse = 0.75 + 0.25 * Math.sin(s * 3 + c)
            ctx.fillStyle = colors.lime
            ctx.globalAlpha = Math.max(0, fade) * pulse
            ctx.shadowColor = colors.lime
            ctx.shadowBlur = 18
            ctx.fill()
            ctx.shadowBlur = 0
            ctx.globalAlpha = Math.max(0, fade)
            ctx.fillStyle = '#040804'
            ctx.fillText('BUSY', x + 10, y + 16)
            ctx.fillText(`${load} input${load > 1 ? 's' : ''}`, x + 10, y + bh - 14)
          } else {
            ctx.fillStyle = colors.surface
            ctx.fill()
            ctx.strokeStyle = colors.accentDim
            ctx.stroke()
            ctx.fillStyle = colors.accent
            ctx.fillText('WARM · IDLE', x + 10, y + 16)
            // scaledown_window draining
            const left = Math.max(0, 1 - (s - lastDone) / Math.max(1, windowRef.current))
            ctx.fillStyle = colors.line
            ctx.fillRect(x + 10, y + bh - 14, bw - 20, 3)
            ctx.fillStyle = colors.accentDim
            ctx.fillRect(x + 10, y + bh - 14, (bw - 20) * left, 3)
          }
        }
        ctx.globalAlpha = 1
      }
      // Empty slots
      for (let k = 0; k < SLOTS; k++) {
        if (aliveNow.some((c) => slot[c] === k)) continue
        const [x, y] = slotXY(k)
        rr(x + 0.5, y + 0.5, bw - 1, bh - 1, 8)
        ctx.strokeStyle = colors.line
        ctx.setLineDash([1, 5])
        ctx.stroke()
        ctx.setLineDash([])
      }

      // Requests
      let qIdx = 0
      let queued = 0
      for (let i = 0; i < trace.t.length; i++) {
        const a = trace.t[i]
        if (a > s) break
        const disp = d.dispatch[i]
        const c = d.container[i]
        if (s > disp + FLY) continue
        const isCold = d.cold[i] === 1
        let px: number
        let py: number
        const [cx, cy] = slotXY(slot[c])
        const tx = cx + bw / 2
        const ty = cy + bh / 2
        const ease = (u: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, u)), 3)
        if (disp - a < 1e-6) {
          const u = ease((s - a) / FLY)
          px = 8 + (tx - 8) * u
          py = laneY + (ty - laneY) * u * u
        } else if (s < disp) {
          queued++
          const qx = gateX - 10 - (qIdx % 6) * 9
          const qy = laneY + Math.floor(qIdx / 6) * 9
          qIdx++
          const u = ease((s - a) / FLY)
          px = 8 + (qx - 8) * u
          py = laneY + (qy - laneY) * u
        } else {
          const u = ease((s - disp) / FLY)
          px = gateX - 10 + (tx - gateX + 10) * u
          py = laneY + (ty - laneY) * u
        }
        ctx.beginPath()
        ctx.arc(px, py, 3.2, 0, Math.PI * 2)
        ctx.fillStyle = isCold || s < disp ? colors.cold : colors.accent
        ctx.fill()
      }

      // Mini timeline
      const tl = r.timeline
      const cy0 = Hh - chartH - 6
      const n = tl.alive.length
      const maxA = Math.max(2, ...tl.alive, ...tl.needed)
      ctx.strokeStyle = colors.line
      ctx.beginPath()
      ctx.moveTo(8, cy0 + chartH)
      ctx.lineTo(W - 8, cy0 + chartH)
      ctx.stroke()
      const X = (i: number) => 8 + ((W - 16) * i) / (n - 1)
      const Y = (v: number) => cy0 + chartH - (v / maxA) * (chartH - 14)
      ctx.fillStyle = colors.load
      for (let i = 0; i < n; i++) {
        const h = (tl.needed[i] * (chartH - 14)) / maxA
        ctx.globalAlpha = 0.35
        ctx.fillRect(X(i) - 1, cy0 + chartH - h, Math.max(1.5, (W - 16) / n - 1), h)
      }
      ctx.globalAlpha = 1
      ctx.strokeStyle = colors.accent
      ctx.lineWidth = 1.6
      ctx.beginPath()
      tl.alive.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))))
      ctx.stroke()
      ctx.lineWidth = 1
      tl.cold.forEach((v, i) => {
        if (!v) return
        ctx.fillStyle = colors.cold
        ctx.beginPath()
        ctx.arc(X(i), cy0 + chartH - 3, 2.5, 0, Math.PI * 2)
        ctx.fill()
      })
      const ph = 8 + ((W - 16) * s) / H
      ctx.strokeStyle = colors.text
      ctx.globalAlpha = 0.6
      ctx.beginPath()
      ctx.moveTo(ph, cy0 + 4)
      ctx.lineTo(ph, cy0 + chartH)
      ctx.stroke()
      ctx.globalAlpha = 1
      let lx = 8
      for (const [label, color] of [['CONTAINERS ALIVE', colors.accent], ['IN FLIGHT', colors.load], ['COLD HIT', colors.cold]] as const) {
        ctx.fillStyle = color
        ctx.fillRect(lx, cy0 - 2, 8, 8)
        ctx.fillStyle = colors.muted
        ctx.fillText(label, lx + 12, cy0 + 2)
        lx += 24 + ctx.measureText(label).width
      }

      const now = performance.now()
      if (now - lastHud > 200) {
        lastHud = now
        let cost = 0
        for (const k of d.containers) cost += Math.max(0, Math.min(s, k.end) - k.start)
        let coldSoFar = 0
        for (let i = 0; i < trace.t.length && trace.t[i] <= s; i++) coldSoFar += d.cold[i]
        setHud({ t: s, alive: aliveNow.length, cold: coldSoFar, cost: cost * price, queued })
      }
    }

    const loop = () => {
      const s = (((performance.now() - t0) / 1000) * SPEED) % H
      draw(s)
      raf = requestAnimationFrame(loop)
    }
    if (reduced) draw(H * 0.42)
    else raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  const chip = <K extends keyof Knob>(k: K, v: Knob[K], label: string) => (
    <button key={label} className={`chip ${knob[k] === v ? 'on' : ''}`} aria-pressed={knob[k] === v} onClick={() => setKnob((p) => ({ ...p, [k]: v }))}>
      {label}
    </button>
  )

  return (
    <div className="stage">
      <div className="stage-bar">
        <div className="stage-dots" aria-hidden>
          <i />
          <i />
          <i />
        </div>
        <span className="mono dim">live replay · A10G · cold start {secs(run.r.coldStartSec)} · {trace.t.length} requests</span>
        <span className="mono stage-clock">t={hud.t.toFixed(0).padStart(3, '0')}s</span>
      </div>
      <canvas ref={canvasRef} className="stage-canvas" role="img" aria-label="Animated simulation: requests arrive and Modal containers cold start, serve, idle and scale down." />
      <div className="stage-controls">
        <div className="knob">
          <span className="mono">buffer_containers</span>
          <div className="chips">{[0, 1, 2].map((v) => chip('buffer', v, String(v)))}</div>
        </div>
        <div className="knob">
          <span className="mono">min_containers</span>
          <div className="chips">{[0, 1, 2].map((v) => chip('min', v, String(v)))}</div>
        </div>
        <div className="knob">
          <span className="mono">scaledown_window</span>
          <div className="chips">{[5, 20, 120].map((v) => chip('window', v, `${v}s`))}</div>
        </div>
        <div className="knob">
          <span className="mono">memory snapshot</span>
          <div className="chips">
            {chip('snapshot', false, 'off')}
            {chip('snapshot', true, 'on')}
          </div>
        </div>
      </div>
      <div className="stage-stats">
        <div>
          <b>{run.r.coldPct.toFixed(1)}%</b>
          <span>requests hit a cold start</span>
        </div>
        <div>
          <b>{secs(run.r.p99)}</b>
          <span>p99 latency</span>
        </div>
        <div>
          <b>{usd(run.r.costPerDay)}</b>
          <span>per day at this rate</span>
        </div>
        <div>
          <b>
            {hud.alive}
            <small> / {hud.queued} queued</small>
          </b>
          <span>containers alive now</span>
        </div>
      </div>
    </div>
  )
}
