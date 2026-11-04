import { simulate, type SimConfig } from './engine/sim.ts'
import { generate, MAX_REQUESTS, parseTrace, type Trace, type TrafficSpec } from './engine/traffic.ts'
import { explain, runGrid } from './engine/optimize.ts'

export type Source = { type: 'synthetic'; spec: TrafficSpec } | { type: 'upload'; name: string; text: string }
export type Req = { id: number; op: 'sim' | 'grid'; source: Source; cfg: SimConfig } | { id: number; op: 'compare'; source: Source; cfgs: SimConfig[] }

export interface TraceInfo {
  n: number
  horizon: number
  notes: string[]
  skipped: number
  hasDurations: boolean
}

let cacheKey = ''
let cached: { trace: Trace; info: TraceInfo } | null = null

function load(source: Source) {
  const key = source.type === 'synthetic' ? JSON.stringify(source.spec) : `${source.name}:${source.text.length}:${source.text.slice(0, 200)}`
  if (key === cacheKey && cached) return cached
  if (source.type === 'synthetic') {
    const trace = generate(source.spec)
    const notes = trace.t.length >= MAX_REQUESTS ? [`Capped at ${MAX_REQUESTS.toLocaleString()} requests: lower the rate or duration to simulate the full window.`] : []
    cached = { trace, info: { n: trace.t.length, horizon: trace.horizon, notes, skipped: 0, hasDurations: true } }
  } else {
    const { trace, skipped, notes } = parseTrace(source.text)
    cached = { trace, info: { n: trace.t.length, horizon: trace.horizon, notes, skipped, hasDurations: trace.d !== null } }
  }
  cacheKey = key
  return cached
}

self.onmessage = (e: MessageEvent<Req>) => {
  const msg = e.data
  const { id, op, source } = msg
  try {
    const { trace, info } = load(source)
    if (trace.t.length === 0) throw new Error('The trace has no requests in it.')
    if (msg.op === 'compare') {
      postMessage({ id, op, results: msg.cfgs.map((c) => simulate(trace, c, { buckets: 60 })) })
    } else if (msg.op === 'sim') {
      const result = simulate(trace, msg.cfg)
      const insights = explain(trace, msg.cfg, result)
      postMessage({ id, op, result, insights, info })
    } else {
      let last = 0
      const points = runGrid(trace, msg.cfg, (done, total) => {
        const now = performance.now()
        if (now - last > 80 || done === total) {
          last = now
          postMessage({ id, op: 'progress', done, total })
        }
      })
      postMessage({ id, op, points })
    }
  } catch (err) {
    postMessage({ id, op: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
