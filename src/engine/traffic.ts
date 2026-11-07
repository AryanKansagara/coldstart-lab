export interface Trace {
  /** Arrival times in seconds from trace start, sorted ascending. */
  t: number[]
  /** Per-request service time in seconds, or null to use the configured default. */
  d: number[] | null
  /** Simulated window length in seconds. */
  horizon: number
}

export type TrafficKind = 'poisson' | 'diurnal' | 'bursty' | 'spike'

export interface TrafficSpec {
  kind: TrafficKind
  /** Mean requests per second. */
  rate: number
  hours: number
  seed: number
  /** Mean service time in seconds and its coefficient of variation. */
  serviceMean: number
  serviceCv: number
}

export const MAX_REQUESTS = 400_000

/** mulberry32: tiny, fast, seedable. */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const exp = (r: () => number, rate: number) => -Math.log(1 - r()) / rate

function gauss(r: () => number) {
  return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())
}

export function lognormal(r: () => number, mean: number, cv: number) {
  if (cv <= 0) return mean
  const s2 = Math.log(1 + cv * cv)
  return Math.exp(Math.log(mean) - s2 / 2 + Math.sqrt(s2) * gauss(r))
}

/** Rate multiplier over time for each traffic shape (mean ~1 over a day / the window). */
export function rateShape(kind: TrafficKind, t: number, horizon: number): number {
  if (kind === 'diurnal') return 1 + 0.85 * Math.sin((2 * Math.PI * t) / 86400 - Math.PI / 2)
  if (kind === 'spike') {
    const f = t / horizon
    return f > 0.4 && f < 0.43 ? 12 : 0.67
  }
  return 1
}

export function generate(spec: TrafficSpec): Trace {
  const r = rng(spec.seed)
  const horizon = Math.max(60, spec.hours * 3600)
  const rate = Math.max(1e-4, spec.rate)
  const t: number[] = []
  if (spec.kind === 'bursty') {
    // Sessions arrive as Poisson; each session fires a geometric burst of quick follow-ups.
    const burst = 8
    let s = 0
    while ((s += exp(r, rate / burst)) < horizon && t.length < MAX_REQUESTS) {
      let x = s
      do {
        t.push(x)
        x += exp(r, 2)
      } while (r() > 1 / burst && x < horizon && t.length < MAX_REQUESTS)
    }
    t.sort((a, b) => a - b)
  } else {
    // Thinning (Lewis-Shedler) against the peak rate.
    const peak = rate * (spec.kind === 'diurnal' ? 1.85 : spec.kind === 'spike' ? 12 : 1)
    let x = 0
    while ((x += exp(r, peak)) < horizon && t.length < MAX_REQUESTS) {
      if (r() * peak <= rate * rateShape(spec.kind, x, horizon)) t.push(x)
    }
  }
  const d = t.map(() => lognormal(r, spec.serviceMean, spec.serviceCv))
  // Capped runs end where the requests ran out, so the idle tail is not billed as if it were real.
  return { t, d, horizon: t.length >= MAX_REQUESTS ? Math.max(60, t[t.length - 1] + 1) : horizon }
}

export function sanitizeSpec(raw: Partial<TrafficSpec> | null | undefined, base: TrafficSpec): TrafficSpec {
  const c = raw ?? {}
  const num = (v: unknown, lo: number, hi: number, f: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : f)
  return {
    kind: c.kind === 'poisson' || c.kind === 'diurnal' || c.kind === 'bursty' || c.kind === 'spike' ? c.kind : base.kind,
    rate: num(c.rate, 0.001, 200, base.rate),
    hours: num(c.hours, 1 / 60, 168, base.hours),
    seed: Math.round(num(c.seed, 0, 2 ** 31, base.seed)),
    serviceMean: num(c.serviceMean, 0.001, 3600, base.serviceMean),
    serviceCv: num(c.serviceCv, 0, 5, base.serviceCv),
  }
}

// ---------- parsing user logs ----------

const TIME_KEYS = ['timestamp', 'time', 'ts', 'start', 'start_time', 'started_at', 'created_at', 'arrival', 'enqueued_at', 'date']
const DUR_KEYS = ['duration', 'latency', 'execution_time', 'exec_time', 'runtime', 'elapsed', 'duration_ms', 'latency_ms', 'duration_s', 'execution_ms']

export interface ParseResult {
  trace: Trace
  skipped: number
  notes: string[]
}

function toSeconds(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const s = v.trim().replace(/^"|"$/g, '')
  if (s === '') return null
  if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s)) return Number(s)
  const ms = Date.parse(s)
  return Number.isNaN(ms) ? null : ms / 1000
}

function pickKey(keys: string[], wanted: string[]) {
  const lower = keys.map((k) => k.toLowerCase().trim())
  for (const w of wanted) {
    const i = lower.indexOf(w)
    if (i >= 0) return keys[i]
  }
  for (const w of wanted) {
    const i = lower.findIndex((k) => k.includes(w))
    if (i >= 0) return keys[i]
  }
  return null
}

function splitCsvLine(line: string, sep: string) {
  // Handles quoted fields without embedded separators/newlines; enough for log exports.
  return line.split(sep).map((c) => c.trim().replace(/^"|"$/g, ''))
}

export function parseTrace(text: string): ParseResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length === 0) throw new Error('The log is empty.')
  const rows: Record<string, unknown>[] = []
  let skipped = 0
  const notes: string[] = []

  if (lines[0].trim().startsWith('{')) {
    for (const l of lines) {
      try {
        rows.push(JSON.parse(l))
      } catch {
        skipped++
      }
    }
  } else {
    const sep = lines[0].includes('\t') ? '\t' : lines[0].includes(';') && !lines[0].includes(',') ? ';' : ','
    const first = splitCsvLine(lines[0], sep)
    const hasHeader = first.some((c) => toSeconds(c) === null)
    const header = hasHeader ? first : first.map((_, i) => (i === 0 ? 'timestamp' : i === 1 ? 'duration' : `c${i}`))
    for (const l of lines.slice(hasHeader ? 1 : 0)) {
      const cells = splitCsvLine(l, sep)
      rows.push(Object.fromEntries(header.map((h, i) => [h, cells[i]])))
    }
  }
  if (rows.length === 0) throw new Error('No parseable rows found.')

  const keys = Object.keys(rows[0])
  const tk = pickKey(keys, TIME_KEYS) ?? keys[0]
  const dk = pickKey(keys, DUR_KEYS)
  const pairs: [number, number | null][] = []
  for (const row of rows) {
    const ts = toSeconds(row[tk])
    if (ts === null) {
      skipped++
      continue
    }
    const dv = dk ? toSeconds(row[dk]) : null
    pairs.push([ts, dv !== null && dv >= 0 ? dv : null])
  }
  if (pairs.length === 0) throw new Error(`Could not read any timestamps from column "${tk}".`)

  // Epoch milliseconds / microseconds -> seconds.
  const maxTs = pairs.reduce((m, p) => Math.max(m, p[0]), -Infinity)
  const tsScale = maxTs > 1e14 ? 1e-6 : maxTs > 1e11 ? 1e-3 : 1
  if (tsScale !== 1) notes.push(`Timestamps look like epoch ${tsScale === 1e-3 ? 'milliseconds' : 'microseconds'}.`)

  let dScale = 1
  const ds = pairs.map((p) => p[1]).filter((x): x is number => x !== null)
  if (dk) {
    const name = dk.toLowerCase()
    const med = ds.slice().sort((a, b) => a - b)[ds.length >> 1] ?? 0
    if (/ms|millis/.test(name) || (!/(_s|sec)/.test(name) && med > 100)) {
      dScale = 1e-3
      notes.push(`Durations in "${dk}" read as milliseconds.`)
    } else notes.push(`Durations in "${dk}" read as seconds.`)
  } else notes.push('No duration column: using the configured service time.')

  pairs.sort((a, b) => a[0] - b[0])
  const t0 = pairs[0][0] * tsScale
  const capped = pairs.slice(0, MAX_REQUESTS)
  if (capped.length < pairs.length) notes.push(`Trimmed to the first ${MAX_REQUESTS.toLocaleString()} requests.`)
  const t = capped.map((p) => p[0] * tsScale - t0)
  const haveD = ds.length > capped.length * 0.5
  const fallback = ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : 1
  const d = haveD ? capped.map((p) => (p[1] ?? fallback) * dScale) : null
  const horizon = Math.max(60, t[t.length - 1] + 1)
  return { trace: { t, d, horizon }, skipped, notes }
}
