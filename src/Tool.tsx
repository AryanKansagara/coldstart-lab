import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { LatencyHistogram, ParetoChart, Spark, TimelineChart, fmtClock } from './Charts.tsx'
import { diagnose, explainPoint, knobLabel, pareto, pct, recommend, secs, usd, type GridPoint, type Insight } from './engine/optimize.ts'
import { DEFAULT_CFG, DEFAULT_TRAFFIC, PRESETS, SAMPLE_TRAFFIC } from './engine/presets.ts'
import { containerPricePerSec, GPUS, GPU_PRICE_PER_SEC, PRICES_AS_OF, PRICES_SOURCE, type Gpu } from './engine/pricing.ts'
import { decodeState, encodeState } from './engine/share.ts'
import { coldStartSec, sanitizeCfg, SNAPSHOT_SPEEDUP, type SimConfig, type SimResult } from './engine/sim.ts'
import { sanitizeSpec, type TrafficKind, type TrafficSpec } from './engine/traffic.ts'
import type { Source, TraceInfo } from './worker.ts'

type Upload = { name: string; text: string }
type Scenario = { name: string; cfg: SimConfig }
interface Saved {
  cfg: SimConfig
  spec: TrafficSpec
  slo: number
  tab: 'synthetic' | 'upload'
  upload: Upload | null
  scenarios: Scenario[]
}

const STORE = 'coldstart-lab:v1'
const MAX_SHARED_TRACE = 16_000
const MAX_STORED_TRACE = 2_000_000
const DEFAULT_SLO = 15

function clean(raw: Partial<Saved> | null): Saved {
  const r = raw ?? {}
  const upload = r.upload && typeof r.upload.text === 'string' && typeof r.upload.name === 'string' ? r.upload : null
  return {
    cfg: sanitizeCfg(r.cfg, DEFAULT_CFG),
    spec: sanitizeSpec(r.spec, DEFAULT_TRAFFIC),
    slo: typeof r.slo === 'number' && r.slo > 0 ? r.slo : DEFAULT_SLO,
    tab: r.tab === 'upload' && upload ? 'upload' : 'synthetic',
    upload,
    scenarios: Array.isArray(r.scenarios) ? r.scenarios.slice(0, 4).map((s, i) => ({ name: String(s?.name ?? `Scenario ${i + 1}`).slice(0, 40), cfg: sanitizeCfg(s?.cfg, DEFAULT_CFG) })) : [],
  }
}

function initial(): Saved {
  const q = new URLSearchParams(location.search).get('sample')
  const sample = SAMPLE_TRAFFIC.find((s) => s.id === q)
  if (sample) return { ...clean(null), spec: sample.spec, cfg: { ...DEFAULT_CFG, ...PRESETS.find((p) => p.id === sample.preset)?.cfg, serviceMean: sample.spec.serviceMean } }
  try {
    return clean(JSON.parse(localStorage.getItem(STORE) ?? 'null'))
  } catch {
    return clean(null)
  }
}

let nextId = 1
function call<T>(worker: Worker, msg: object, onProgress?: (done: number, total: number) => void): Promise<T> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const on = (e: MessageEvent) => {
      if (e.data.id !== id) return
      if (e.data.op === 'progress') return onProgress?.(e.data.done, e.data.total)
      worker.removeEventListener('message', on)
      if (e.data.op === 'error') reject(new Error(e.data.message))
      else resolve(e.data as T)
    }
    worker.addEventListener('message', on)
    worker.postMessage({ ...msg, id })
  })
}
const newWorker = () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })

function NumField({ label, hint, value, onChange, min = 0, max, step = 1, suffix, disabled }: { label: ReactNode; hint?: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; suffix?: string; disabled?: boolean }) {
  const [text, setText] = useState(String(value))
  useEffect(() => {
    if (Number(text) !== value) setText(String(value))
    // eslint-disable-next-line
  }, [value])
  const commit = (s: string) => {
    setText(s)
    const v = Number(s)
    if (s.trim() !== '' && Number.isFinite(v) && v >= min && (max === undefined || v <= max)) onChange(v)
  }
  return (
    <label className="field" title={hint}>
      <span className="field-label">{label}</span>
      <span className="field-input">
        <input type="number" inputMode="decimal" value={text} min={min} max={max} step={step} disabled={disabled} onChange={(e) => commit(e.target.value)} onBlur={() => setText(String(value))} />
        {suffix && <i>{suffix}</i>}
      </span>
    </label>
  )
}

function Panel({ title, aside, children, className = '', id }: { title: string; aside?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section className={`panel ${className}`} id={id}>
      <header className="panel-head">
        <h2>{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  )
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className={`kpi ${tone ?? ''}`}>
      <span className="kpi-label">{label}</span>
      <b className="kpi-value">{value}</b>
      {sub && <span className="kpi-sub">{sub}</span>}
    </div>
  )
}

const MODAL_GPU: Record<Gpu, string> = { T4: 'T4', L4: 'L4', A10G: 'A10', L40S: 'L40S', 'A100-40GB': 'A100-40GB', 'A100-80GB': 'A100-80GB', 'RTX-PRO-6000': 'RTX-PRO-6000', H100: 'H100', H200: 'H200', B200: 'B200', B300: 'B300' }

export function modalSnippet(c: SimConfig) {
  const lines = [`gpu="${MODAL_GPU[c.gpu]}${c.gpuCount > 1 ? `:${c.gpuCount}` : ''}"`, `cpu=${c.cpuCores}`, `memory=${Math.round(c.memoryGiB * 1024)}`]
  if (c.minContainers) lines.push(`min_containers=${c.minContainers}`)
  lines.push(`max_containers=${c.maxContainers}`)
  if (c.bufferContainers) lines.push(`buffer_containers=${c.bufferContainers}`)
  lines.push(`scaledown_window=${c.scaledownWindow}`)
  if (c.snapshot) lines.push('enable_memory_snapshot=True', 'experimental_options={"enable_gpu_snapshot": True}')
  const conc = c.maxInputs > 1 ? `\n@modal.concurrent(max_inputs=${c.maxInputs}${c.targetInputs > 0 ? `, target_inputs=${c.targetInputs}` : ''})` : ''
  return `@app.cls(\n${lines.map((l) => `    ${l},`).join('\n')}\n)${conc}\nclass Model:\n    ...`
}

const EXAMPLE_LOG = () => {
  // A realistic export shape: ISO timestamp, status, latency in ms. Clustered like real sessions.
  const rows = ['timestamp,status,latency_ms']
  let t = Date.UTC(2026, 9, 12, 14, 0, 0)
  for (let s = 0; s < 40; s++) {
    t += 40_000 + (s * 7919) % 200_000
    for (let k = 0; k < 2 + (s * 13) % 7; k++) {
      t += 400 + (k * s * 311) % 2600
      rows.push(`${new Date(t).toISOString()},200,${2100 + (k * s * 577) % 2600}`)
    }
  }
  return rows.join('\n')
}

export default function Tool() {
  const [state, setState] = useState<Saved>(initial)
  const { cfg, spec, slo, tab, upload, scenarios } = state
  const patch = (p: Partial<Saved>) => setState((s) => ({ ...s, ...p }))
  const set = (p: Partial<SimConfig>) => setState((s) => ({ ...s, cfg: sanitizeCfg({ ...s.cfg, ...p }, s.cfg) }))
  const setSpec = (p: Partial<TrafficSpec>) => setState((s) => ({ ...s, spec: sanitizeSpec({ ...s.spec, ...p }, s.spec) }))

  // Shared links beat local state.
  const [hydrated, setHydrated] = useState(!location.hash.startsWith('#s='))
  useEffect(() => {
    if (hydrated) return
    decodeState<Partial<Saved>>(location.hash).then((d) => {
      if (d) setState(clean(d))
      setHydrated(true)
    })
    // eslint-disable-next-line
  }, [])

  const source: Source = useMemo(() => (tab === 'upload' && upload ? { type: 'upload', ...upload } : { type: 'synthetic', spec }), [tab, upload, spec])
  const traceKey = source.type === 'synthetic' ? JSON.stringify(spec) : `${source.name}:${source.text.length}`

  const worker = useRef<Worker | null>(null)
  const [out, setOut] = useState<{ result: SimResult; insights: Insight[]; info: TraceInfo } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [replayKey, setReplayKey] = useState(0)
  const latest = useRef(0)
  const inflight = useRef<Promise<unknown>>(Promise.resolve())
  const lastTrace = useRef('')

  useEffect(() => {
    const w = newWorker()
    worker.current = w
    return () => w.terminate()
  }, [])

  useEffect(() => {
    if (!hydrated) return
    const id = ++latest.current
    setBusy(true)
    const h = setTimeout(async () => {
      await inflight.current.catch(() => {})
      // Coalesce: while a run was in flight only the newest request is worth doing.
      if (id !== latest.current || !worker.current) return
      const p = call<{ result: SimResult; insights: Insight[]; info: TraceInfo }>(worker.current, { op: 'sim', source, cfg })
      inflight.current = p
      try {
        const m = await p
        if (id !== latest.current) return
        setOut(m)
        setError(null)
        if (lastTrace.current !== traceKey) {
          lastTrace.current = traceKey
          setReplayKey((k) => k + 1)
        }
      } catch (e) {
        if (id === latest.current) setError((e as Error).message)
      } finally {
        if (id === latest.current) setBusy(false)
      }
    }, 120)
    return () => clearTimeout(h)
    // eslint-disable-next-line
  }, [source, cfg, hydrated])

  // Persist + keep the URL shareable.
  const [shareNote, setShareNote] = useState<string | null>(null)
  useEffect(() => {
    if (!hydrated) return
    const h = setTimeout(async () => {
      try {
        localStorage.setItem(STORE, JSON.stringify({ ...state, upload: state.upload && state.upload.text.length <= MAX_STORED_TRACE ? state.upload : null, tab: state.upload && state.upload.text.length <= MAX_STORED_TRACE ? state.tab : 'synthetic' }))
      } catch {
        /* Storage full: the session still works, it just will not survive a reload. */
      }
      const embed = state.upload && state.upload.text.length <= MAX_SHARED_TRACE
      const enc = await encodeState({ ...state, upload: embed ? state.upload : null, tab: embed ? state.tab : 'synthetic' })
      history.replaceState(null, '', `/app#s=${enc}`)
    }, 400)
    return () => clearTimeout(h)
  }, [state, hydrated])

  const share = async () => {
    await navigator.clipboard?.writeText(location.href).catch(() => {})
    const dropped = tab === 'upload' && upload && upload.text.length > MAX_SHARED_TRACE
    setShareNote(dropped ? 'Link copied. Your log is too big for a URL, so it carries the settings only.' : 'Link copied.')
    setTimeout(() => setShareNote(null), 3500)
  }

  // ---- Optimizer: own worker so the main sim stays responsive and it can be cancelled.
  const gridWorker = useRef<Worker | null>(null)
  const [grid, setGrid] = useState<{ points: GridPoint[]; key: string } | null>(null)
  const [progress, setProgress] = useState<[number, number] | null>(null)
  const [gridErr, setGridErr] = useState<string | null>(null)
  const { minContainers: _a, bufferContainers: _b, scaledownWindow: _c, targetInputs: _d, ...fixedCfg } = cfg
  const gridKey = traceKey + JSON.stringify(fixedCfg)
  const stale = !!grid && grid.key !== gridKey

  const runOptimizer = async () => {
    gridWorker.current?.terminate()
    const w = newWorker()
    gridWorker.current = w
    setProgress([0, 1])
    setGridErr(null)
    try {
      const m = await call<{ points: GridPoint[] }>(w, { op: 'grid', source, cfg }, (d, t) => setProgress([d, t]))
      if (gridWorker.current === w) {
        pareto(m.points)
        setGrid({ points: m.points, key: gridKey })
      }
    } catch (e) {
      if (gridWorker.current === w) setGridErr((e as Error).message)
    } finally {
      if (gridWorker.current === w) {
        setProgress(null)
        w.terminate()
        gridWorker.current = null
      }
    }
  }
  const cancelOptimizer = () => {
    gridWorker.current?.terminate()
    gridWorker.current = null
    setProgress(null)
  }
  useEffect(() => () => gridWorker.current?.terminate(), [])

  const front = useMemo(() => (grid ? grid.points.filter((p) => p.pareto).sort((a, b) => a.cost - b.cost) : []), [grid])
  const rec = useMemo(() => recommend(front, slo), [front, slo])
  const applyPoint = (p: GridPoint) => set(p.knobs)
  const onRec = !!rec && rec.knobs.minContainers === cfg.minContainers && rec.knobs.bufferContainers === cfg.bufferContainers && rec.knobs.scaledownWindow === cfg.scaledownWindow && rec.knobs.targetInputs === cfg.targetInputs

  // ---- Scenarios are re-simulated against whatever trace is loaded, so they never go stale.
  const [scenRes, setScenRes] = useState<SimResult[]>([])
  useEffect(() => {
    if (!hydrated || !scenarios.length || !worker.current) return setScenRes([])
    let live = true
    call<{ results: SimResult[] }>(worker.current, { op: 'compare', source, cfgs: scenarios.map((s) => s.cfg) })
      .then((m) => live && setScenRes(m.results))
      .catch(() => {})
    return () => {
      live = false
    }
    // eslint-disable-next-line
  }, [scenarios, source, hydrated])
  const saveScenario = () => {
    const name = `${knobLabelShort(cfg)}`
    patch({ scenarios: [...scenarios.slice(-3), { name, cfg }] })
  }

  // ---- Input
  const [dragging, setDragging] = useState(false)
  const [uploadErr, setUploadErr] = useState<string | null>(null)
  const [paste, setPaste] = useState('')
  const useText = (name: string, text: string) => {
    if (!text.trim()) return setUploadErr('That file looks empty.')
    setUploadErr(null)
    patch({ upload: { name, text }, tab: 'upload' })
  }
  const readFile = async (f: File | undefined) => {
    if (!f) return
    if (f.size > 120_000_000) return setUploadErr('That file is over 120 MB. Trim it to a representative window first.')
    useText(f.name, await f.text())
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    readFile(e.dataTransfer.files[0])
  }

  const r = out?.result
  const cold = coldStartSec(cfg)
  const coldParts = [
    ['boot', cfg.bootSec],
    ['image', cfg.snapshot ? cfg.imageSec / SNAPSHOT_SPEEDUP : cfg.imageSec],
    ['model', cfg.snapshot ? cfg.modelSec / SNAPSHOT_SPEEDUP : cfg.modelSec],
  ] as const
  const pricePerHour = containerPricePerSec(cfg.gpu, cfg.gpuCount, cfg.cpuCores, cfg.memoryGiB) * 3600
  const usesTraceDurations = out?.info.hasDurations && tab === 'upload'
  const [copied, setCopied] = useState(false)
  const snippet = modalSnippet(cfg)

  return (
    <div className="lab">
      <aside className="lab-side" aria-label="Simulation inputs">
        <Panel title="Traffic">
          <div className="seg" role="tablist" aria-label="Traffic source">
            <button role="tab" aria-selected={tab === 'synthetic'} className={tab === 'synthetic' ? 'on' : ''} onClick={() => patch({ tab: 'synthetic' })}>
              Generate
            </button>
            <button role="tab" aria-selected={tab === 'upload'} className={tab === 'upload' ? 'on' : ''} onClick={() => patch({ tab: 'upload' })}>
              Your logs
            </button>
          </div>
          {tab === 'synthetic' ? (
            <>
              <div className="sample-list">
                {SAMPLE_TRAFFIC.map((s) => (
                  <button
                    key={s.id}
                    className={`chip ${JSON.stringify(s.spec) === JSON.stringify(spec) ? 'on' : ''}`}
                    onClick={() => setState((st) => ({ ...st, spec: s.spec, cfg: sanitizeCfg({ ...st.cfg, ...PRESETS.find((p) => p.id === s.preset)?.cfg, serviceMean: s.spec.serviceMean }, st.cfg) }))}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
              <div className="seg seg-sm" role="group" aria-label="Traffic shape">
                {(['bursty', 'diurnal', 'poisson', 'spike'] as TrafficKind[]).map((k) => (
                  <button key={k} aria-pressed={spec.kind === k} className={spec.kind === k ? 'on' : ''} onClick={() => setSpec({ kind: k })}>
                    {k}
                  </button>
                ))}
              </div>
              <div className="fields">
                <NumField label="mean rate" value={spec.rate} min={0.001} max={200} step={0.05} suffix="req/s" onChange={(rate) => setSpec({ rate })} />
                <NumField label="window" value={spec.hours} min={0.05} max={168} step={1} suffix="hours" onChange={(hours) => setSpec({ hours })} />
                <NumField label="seed" value={spec.seed} max={2147483648} onChange={(seed) => setSpec({ seed })} />
                <NumField label="duration spread" hint="Coefficient of variation of service time" value={spec.serviceCv} max={5} step={0.1} suffix="cv" onChange={(serviceCv) => setSpec({ serviceCv })} />
              </div>
            </>
          ) : (
            <>
              <label className={`drop ${dragging ? 'over' : ''}`} onDragOver={(e) => (e.preventDefault(), setDragging(true))} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
                <input type="file" accept=".csv,.tsv,.jsonl,.ndjson,.log,.txt,text/*" onChange={(e) => readFile(e.target.files?.[0])} />
                <b>{upload ? upload.name : 'Drop a request log'}</b>
                <span>CSV or JSONL with a timestamp and optional duration/latency. Stays in your browser.</span>
              </label>
              <textarea
                className="paste"
                rows={4}
                placeholder={'timestamp,latency_ms\n2026-10-12T14:00:03Z,2310\n{"ts":1760277603,"duration":2.3}'}
                aria-label="Paste a request log"
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
              />
              <div className="row">
                <button className="btn btn-ghost btn-xs" disabled={!paste.trim()} onClick={() => (useText('pasted log', paste), setPaste(''))}>
                  Use pasted log
                </button>
                <button className="btn btn-ghost btn-xs" onClick={() => useText('example-export.csv', EXAMPLE_LOG())}>
                  Load an example
                </button>
              </div>
              {uploadErr && <p className="note bad" role="alert">{uploadErr}</p>}
              {!upload && <p className="note">Nothing loaded yet: results below still show the generated traffic.</p>}
              {upload && out && (
                <p className="note mono">
                  {out.info.n.toLocaleString()} requests over {fmtClock(out.info.horizon, out.info.horizon)}
                  {out.info.skipped > 0 && ` · ${out.info.skipped} rows skipped`}
                  {out.info.notes.map((n) => (
                    <span key={n}>
                      <br />
                      {n}
                    </span>
                  ))}
                </p>
              )}
            </>
          )}
          {tab === 'synthetic' && out?.info.notes.map((n) => <p className="note" key={n}>{n}</p>)}
        </Panel>

        <Panel title="Workload" aside={<a className="micro" href={PRICES_SOURCE} target="_blank" rel="noreferrer">prices {PRICES_AS_OF} ↗</a>}>
          <label className="field wide">
            <span className="field-label">preset</span>
            <select value="" onChange={(e) => {
              const p = PRESETS.find((x) => x.id === e.target.value)
              if (p) setState((st) => ({ ...st, cfg: sanitizeCfg({ ...st.cfg, ...p.cfg }, st.cfg), spec: sanitizeSpec({ ...st.spec, serviceMean: p.cfg.serviceMean }, st.spec) }))
            }}>
              <option value="">Load a preset…</option>
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}: {p.blurb}
                </option>
              ))}
            </select>
          </label>
          <div className="fields">
            <label className="field">
              <span className="field-label">gpu</span>
              <select value={cfg.gpu} onChange={(e) => set({ gpu: e.target.value as Gpu })}>
                {GPUS.map((g) => (
                  <option key={g} value={g}>
                    {g} · ${(GPU_PRICE_PER_SEC[g] * 3600).toFixed(2)}/h
                  </option>
                ))}
              </select>
            </label>
            <NumField label="gpu count" value={cfg.gpuCount} min={1} max={8} onChange={(gpuCount) => set({ gpuCount })} />
            <NumField label="cpu" value={cfg.cpuCores} min={0.125} max={256} step={0.5} suffix="cores" onChange={(cpuCores) => set({ cpuCores })} />
            <NumField label="memory" value={cfg.memoryGiB} max={2048} suffix="GiB" onChange={(memoryGiB) => set({ memoryGiB })} />
            <NumField
              label="service time"
              hint={usesTraceDurations ? 'Using per-request durations from your log' : 'Mean time to process one input'}
              value={tab === 'synthetic' ? spec.serviceMean : cfg.serviceMean}
              min={0.001}
              max={3600}
              step={0.5}
              suffix="s"
              disabled={usesTraceDurations}
              onChange={(serviceMean) => setState((st) => ({ ...st, cfg: { ...st.cfg, serviceMean }, spec: { ...st.spec, serviceMean } }))}
            />
          </div>
          <h3 className="sub">Cold start</h3>
          <div className="fields three">
            <NumField label="boot" value={cfg.bootSec} max={3600} step={0.5} suffix="s" onChange={(bootSec) => set({ bootSec })} />
            <NumField label="image" value={cfg.imageSec} max={3600} suffix="s" onChange={(imageSec) => set({ imageSec })} />
            <NumField label="model" value={cfg.modelSec} max={3600} suffix="s" onChange={(modelSec) => set({ modelSec })} />
          </div>
          <div className="coldbar" aria-hidden>
            {coldParts.map(([k, v]) => (
              <span key={k} className={`cb-${k}`} style={{ flexGrow: Math.max(0.05, v) }} title={`${k}: ${v.toFixed(1)}s`} />
            ))}
          </div>
          <label className="switch">
            <input type="checkbox" checked={cfg.snapshot} onChange={(e) => set({ snapshot: e.target.checked })} />
            <i aria-hidden />
            <span>
              Memory snapshot <small>image + model ÷ 5 (Modal cites 3-10x)</small>
            </span>
          </label>
          <p className="readout mono">
            cold start <b>{secs(cold)}</b> · {usd(pricePerHour)}/h per container
          </p>
        </Panel>

        <Panel title="Autoscaler">
          <div className="fields">
            <NumField label="min_containers" hint="Kept warm even when the Function is inactive" value={cfg.minContainers} max={cfg.maxContainers} onChange={(minContainers) => set({ minContainers })} />
            <NumField label="max_containers" hint="Hard upper limit; excess inputs queue" value={cfg.maxContainers} min={1} max={2000} onChange={(maxContainers) => set({ maxContainers })} />
            <NumField label="buffer_containers" hint="Extra idle containers while the Function is active" value={cfg.bufferContainers} max={500} onChange={(bufferContainers) => set({ bufferContainers })} />
            <NumField label="scaledown_window" hint="Max idle seconds. Modal accepts 2 to 1200." value={cfg.scaledownWindow} min={2} max={1200} step={5} suffix="s" onChange={(scaledownWindow) => set({ scaledownWindow })} />
          </div>
          <input className="range" type="range" min={2} max={1200} step={1} value={cfg.scaledownWindow} aria-label="scaledown_window in seconds" onChange={(e) => set({ scaledownWindow: Number(e.target.value) })} />
          <h3 className="sub mono">@modal.concurrent</h3>
          <div className="fields">
            <NumField label="max_inputs" hint="Per-container hard limit" value={cfg.maxInputs} min={1} max={1000} onChange={(maxInputs) => set({ maxInputs })} />
            <NumField label="target_inputs" hint="Autoscaler aims here, bursts to max_inputs. 0 = same as max." value={cfg.targetInputs} max={cfg.maxInputs} onChange={(targetInputs) => set({ targetInputs })} />
          </div>
        </Panel>
      </aside>

      <div className="lab-main">
        <div className="lab-top">
          <div>
            <h1>Autoscaler replay</h1>
            <p className="dim mono">
              <span className={`status ${busy ? 'on' : ''}`} aria-hidden />
              {busy ? 'simulating in worker…' : r ? `${r.n.toLocaleString()} requests · ${fmtClock(r.horizon, r.horizon)} window · ${r.containersStarted} cold boots` : 'waiting for first run'}
            </p>
          </div>
          <div className="row">
            <span aria-live="polite" className="micro">{shareNote}</span>
            <button className="btn btn-ghost btn-sm" onClick={saveScenario} disabled={!r}>
              Save scenario
            </button>
            <button className="btn btn-primary btn-sm" onClick={share}>
              Copy share link
            </button>
          </div>
        </div>

        {error && (
          <div className="alert" role="alert">
            <b>That trace could not be simulated.</b> {error}
          </div>
        )}

        {!r && !error && <div className="skeleton" aria-busy="true">Spinning up the first simulation…</div>}

        {r && (
          <>
            <p className="diagnosis">{diagnose(r)}</p>
            <div className="kpis">
              <Kpi label="p50" value={secs(r.p50)} />
              <Kpi label="p95" value={secs(r.p95)} />
              <Kpi label="p99" value={secs(r.p99)} tone={r.p99 <= slo ? 'good' : 'bad'} sub={`target ${secs(slo)}`} />
              <Kpi label="cold-start hits" value={pct(r.coldPct)} sub={`${r.coldCount.toLocaleString()} requests`} />
              <Kpi label="queue time" value={secs(r.queueMean)} sub={`mean · p99 ${secs(r.queueP99)}`} />
              <Kpi label="total cost" value={usd(r.cost)} sub={`${usd(r.costPerDay)}/day`} />
              <Kpi label="per 1k requests" value={usd(r.costPer1k)} />
              <Kpi label="idle cost" value={usd(r.idleCost)} sub={`+ ${usd(r.bootCost)} booting`} />
            </div>

            <Panel title="Timeline">
              <TimelineChart tl={r.timeline} horizon={r.horizon} autoplayKey={replayKey} />
            </Panel>

            <div className="two">
              <Panel title="Latency distribution">
                <LatencyHistogram r={r} />
              </Panel>
              <Panel title="What moves the needle">
                <ul className="insights">
                  {out!.insights.map((i) => (
                    <li key={i.label}>
                      <button onClick={() => set(i.change)} title={`Apply ${i.label}`}>
                        <span>{i.text}</span>
                        <i aria-hidden>Apply →</i>
                      </button>
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>

            <Panel
              title="Optimizer"
              id="optimizer"
              aside={
                <div className="row">
                  <NumField label="p99 target" value={slo} min={0.01} max={3600} step={1} suffix="s" onChange={(v) => patch({ slo: v })} />
                  {progress ? (
                    <button className="btn btn-ghost btn-sm" onClick={cancelOptimizer}>
                      Cancel
                    </button>
                  ) : (
                    <button className="btn btn-primary btn-sm" onClick={runOptimizer}>
                      {grid ? 'Re-run grid' : 'Run grid search'}
                    </button>
                  )}
                </div>
              }
            >
              {progress && (
                <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress[1]} aria-valuenow={progress[0]}>
                  <i style={{ width: `${(progress[0] / progress[1]) * 100}%` }} />
                  <span className="mono">
                    {progress[0]} / {progress[1]} configs
                  </span>
                </div>
              )}
              {gridErr && <p className="note bad" role="alert">{gridErr}</p>}
              {!grid && !progress && (
                <div className="empty">
                  <p>
                    Replays this trace through every combination of <code>min_containers</code>, <code>buffer_containers</code>, <code>scaledown_window</code>
                    {cfg.maxInputs > 1 && (
                      <>
                        {' '}
                        and <code>target_inputs</code>
                      </>
                    )}
                    , then plots cost against p99 so you can pick a point on the frontier.
                  </p>
                </div>
              )}
              {grid && (
                <>
                  {stale && <p className="note warn">Workload or traffic changed since this search ran. Re-run it to refresh the frontier.</p>}
                  {rec && !stale && (
                    <div className="rec">
                      <div>
                        <span className="rec-tag mono">Recommendation</span>
                        <p>{onRec ? `You are on it: ${knobLabel(rec.knobs)} is the cheapest config found that ${rec.p99 <= slo ? `meets your ${secs(slo)} p99 target` : `gets closest to your ${secs(slo)} p99 target`}, at ${usd(rec.costPerDay)}/day.` : explainPoint(r, rec, slo)}</p>
                      </div>
                      {!onRec && (
                        <button className="btn btn-primary btn-sm" onClick={() => applyPoint(rec)}>
                          Apply
                        </button>
                      )}
                    </div>
                  )}
                  {!stale && <><ParetoChart points={grid.points} current={r} cfg={cfg} rec={rec} slo={slo} onPick={applyPoint} />
                  <details className="table-view">
                    <summary>Frontier as a table ({front.length})</summary>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Config</th>
                            <th>$/day</th>
                            <th>p99</th>
                            <th>p95</th>
                            <th>Cold</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {front.map((p) => (
                            <tr key={knobLabel(p.knobs)}>
                              <td className="mono">{knobLabel(p.knobs)}</td>
                              <td>{usd(p.costPerDay)}</td>
                              <td>{secs(p.p99)}</td>
                              <td>{secs(p.p95)}</td>
                              <td>{p.coldPct.toFixed(1)}%</td>
                              <td>
                                <button className="btn btn-ghost btn-xs" onClick={() => applyPoint(p)}>
                                  Apply
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details></>}
                </>
              )}
            </Panel>

            <Panel title="Scenarios" aside={<span className="micro">re-simulated against the loaded trace</span>}>
              {scenarios.length === 0 ? (
                <div className="empty">
                  <p>Save up to four configs and compare them side by side on the same traffic.</p>
                  <button className="btn btn-ghost btn-sm" onClick={saveScenario}>
                    Save the current config
                  </button>
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="compare">
                    <thead>
                      <tr>
                        <th scope="col">Metric</th>
                        <th scope="col">Current</th>
                        {scenarios.map((s, i) => (
                          <th scope="col" key={i}>
                            <input
                              className="scen-name"
                              value={s.name}
                              maxLength={40}
                              aria-label={`Scenario ${i + 1} name`}
                              onChange={(e) => patch({ scenarios: scenarios.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}
                            />
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {COMPARE_ROWS.map(([label, get, fmt]) => {
                        const all = [r, ...scenRes]
                        const best = Math.min(...all.map(get))
                        return (
                          <tr key={label}>
                            <th scope="row">{label}</th>
                            {all.map((x, i) => (
                              <td key={i} className={get(x) === best && all.length > 1 ? 'best' : ''}>
                                {fmt(get(x))}
                              </td>
                            ))}
                          </tr>
                        )
                      })}
                      <tr>
                        <th scope="row">Containers vs needed</th>
                        {[r, ...scenRes].map((x, i) => (
                          <td key={i}>
                            <Spark data={resample(x.timeline.alive)} needed={resample(x.timeline.needed)} />
                          </td>
                        ))}
                      </tr>
                      <tr>
                        <th scope="row" />
                        <td />
                        {scenarios.map((s, i) => (
                          <td key={i}>
                            <div className="row">
                              <button className="btn btn-ghost btn-xs" onClick={() => patch({ cfg: s.cfg })}>
                                Apply
                              </button>
                              <button className="btn btn-ghost btn-xs" aria-label={`Remove ${s.name}`} onClick={() => patch({ scenarios: scenarios.filter((_, j) => j !== i) })}>
                                Remove
                              </button>
                            </div>
                          </td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            <div className="two">
              <Panel
                title="Paste into your App"
                aside={
                  <button
                    className="btn btn-ghost btn-xs"
                    onClick={() => {
                      navigator.clipboard?.writeText(snippet).then(() => {
                        setCopied(true)
                        setTimeout(() => setCopied(false), 1800)
                      })
                    }}
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                }
              >
                <pre className="code">
                  <code>{snippet}</code>
                </pre>
              </Panel>
              <Panel title="What this model assumes">
                <ul className="assume">
                  <li>Containers bill from boot start to shutdown. Boot time counts as spend, not idle.</li>
                  <li>
                    An idle container lives the full <code>scaledown_window</code>. Modal may reap sooner when substantially overprovisioned, so idle cost here is an upper bound.
                  </li>
                  <li>Concurrency does not slow an input down. For GPU batching, raise service time to the loaded value.</li>
                  <li>A cold-start hit means the input was served by a container that had not finished booting when it arrived. Preemption and capacity delays are not modeled.</li>
                </ul>
              </Panel>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const knobLabelShort = (c: SimConfig) => `min ${c.minContainers} · buf ${c.bufferContainers} · ${c.scaledownWindow}s${c.snapshot ? ' · snap' : ''}`

const COMPARE_ROWS: [string, (r: SimResult) => number, (v: number) => string][] = [
  ['p50', (r) => r.p50, secs],
  ['p95', (r) => r.p95, secs],
  ['p99', (r) => r.p99, secs],
  ['Cold-start hits', (r) => r.coldPct, pct],
  ['Mean queue time', (r) => r.queueMean, secs],
  ['Cost per day', (r) => r.costPerDay, usd],
  ['Per 1k requests', (r) => r.costPer1k, usd],
  ['Idle cost', (r) => r.idleCost, usd],
]

function resample(a: number[], n = 60) {
  if (a.length <= n) return a
  const f = a.length / n
  return Array.from({ length: n }, (_, i) => a[Math.floor(i * f)])
}
