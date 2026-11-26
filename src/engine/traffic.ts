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

const TIME_KEYS = ['timestamp', 'time', 'ts', 'start', 'start_time', 'started_at', 'created_at', 'arrival', 'enqueued_at', 'date', 'epoch', 'offset', 't', 'tsms', 'when', 'unix', 'received_at', 'logged_at', 'updated_at', 'started', 'created', 'arrived', 'requested_at', 'submitted_at', 'invoked_at']
// Names that contain a time word but hold a duration or something else.
const NOT_TIME_RE =
  /(^|_)((execution|exec|response|processing|service|wait|queue|inference|total|cold|warm|up|down|life|handling|compute|cpu|gpu)_?time|(cold|warm)_?start|run_?time|time_?(taken|out|zone|spent))|sentiment/
const END_KEYS = ['end_timestamp', 'end_time', 'ended_at', 'finished_at', 'completed_at', 'end_ts']
const DUR_KEYS = ['duration', 'latency', 'execution_time', 'exec_time', 'runtime', 'elapsed', 'duration_ms', 'latency_ms', 'duration_s', 'execution_ms']
const IN_TOK_KEYS = ['contexttokens', 'prompt_tokens', 'input_tokens', 'context_tokens']
const OUT_TOK_KEYS = ['generatedtokens', 'completion_tokens', 'output_tokens', 'generated_tokens']
const FUNC_KEYS = ['func', 'function', 'function_name', 'func_id', 'endpoint']

/** Assumed LLM serving speed when a log has token counts but no durations (one request on a batched 8B-class server). */
export const PREFILL_TOK_PER_SEC = 10_000
export const DECODE_TOK_PER_SEC = 60
export const LLM_OVERHEAD_SEC = 0.05

export interface ParseResult {
  trace: Trace
  skipped: number
  notes: string[]
}

// ISO-like date-times, with a space or T and any number of fraction digits (Azure exports use 7).
const ISO_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:[.,](\d+))?\s*(Z|[+-]\d{2}:?\d{2}| ?UTC)?$/i

const MONTHS = 'jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?'
// What Date.parse may be trusted with: it also turns "Product 1" and "A-1" into dates.
const DATE_RE = new RegExp(`^(\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}/\\d{1,2}/\\d{2,4}|\\d{1,2}[-.]\\d{1,2}[-.]\\d{4})(?![\\d./-])|\\b(${MONTHS})\\b.*\\d{4}|\\d{4}.*\\b(${MONTHS})\\b|\\d[ -](${MONTHS})[ -]\\d{2}`, 'i')

function toSeconds(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (s === '') return null
  if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s)) return Number.isFinite(Number(s)) ? Number(s) : null
  const m = ISO_RE.exec(s)
  if (m) {
    const zone = !m[4] ? '' : /utc/i.test(m[4]) ? 'Z' : m[4].length === 5 ? `${m[4].slice(0, 3)}:${m[4].slice(3)}` : m[4]
    const base = Date.parse(`${m[1]}T${m[2].length === 5 ? `${m[2]}:00` : m[2]}${zone}`)
    return Number.isNaN(base) ? null : base / 1000 + (m[3] ? Number(`0.${m[3]}`) : 0)
  }
  if (!DATE_RE.test(s)) return null
  const ms = Date.parse(s)
  return Number.isNaN(ms) ? null : ms / 1000
}

/** A date without a time of day, in any layout toSeconds() reads. */
const isBareDate = (v: unknown) => typeof v === 'string' && DATE_RE.test(v.trim()) && !/\d:\d/.test(v)

/** True when `v` is the start of a time written like `like`, missing its time of day, seconds or zone: it would read as another moment. */
function isCutTime(v: unknown, like: unknown) {
  if (typeof v !== 'string' || typeof like !== 'string' || !/\d:\d{2}/.test(like) || !DATE_RE.test(like.trim())) return false
  if (!/\d:\d{2}/.test(v)) return true
  if (/\d:\d{2}:\d{2}/.test(like) && !/\d:\d{2}:\d{2}/.test(v)) return true
  const zone = (s: string) => s.trim().replace(/^.*?\d:\d{2}(:\d{2}([.,]\d+)?)?/, '').trim().replace(/\d/g, '9')
  const [a, b] = [zone(v), zone(like)]
  return a.length < b.length && b.startsWith(a)
}

function pickKey(keys: string[], wanted: string[], exclude: string[] = []) {
  const lower = keys.map((k) => k.toLowerCase().trim())
  for (const w of wanted) {
    const i = lower.indexOf(w)
    if (i >= 0 && !exclude.includes(lower[i])) return keys[i]
  }
  for (const w of wanted) {
    const i = lower.findIndex((k) => k.includes(w) && !exclude.includes(k))
    if (i >= 0) return keys[i]
  }
  return null
}

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && /^(|-+|n\/?a|null|none|nan)$/i.test(v.trim()))

/** A plain, non-negative number, or null. Durations and token counts must not go through the date parser. */
function toAmount(v: unknown): number | null {
  if (isBlank(v)) return null
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^[+]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(v.trim()) ? Number(v) : Number.NaN
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** Unit named by a duration column, as a factor to seconds, or null when the name says nothing. */
function unitOf(key: string): [number, string] | null {
  const n = `_${snake(key).replace(/[^a-z0-9µμ]+/g, '_')}_`
  if (/_(ns|nsecs?|nanos)_|nanosec|(duration|latency|time|elapsed)_?(ns|nano)/.test(n)) return [1e-9, 'nanoseconds']
  if (/_(us|usecs?|µs|μs|micros)_|microsec|(duration|latency|time|elapsed)_?(us_|µs|μs|micro)/.test(n)) return [1e-6, 'microseconds']
  if (/ms|millis/.test(n)) return [1e-3, 'milliseconds']
  if (/_s|sec/.test(key.toLowerCase())) return [1, 'seconds']
  return null
}

const snake = (k: string) => k.trim().replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[\s.-]+/g, '_').toLowerCase()

/** The arrival (or completion) column, or null when nothing in the file says when requests happened. */
function pickTime(keys: string[], rows: Record<string, unknown>[], durationKey: string | null): { key: string; isEnd: boolean } | null {
  const names = keys.map(snake)
  const at = (test: (n: string) => boolean) => names.findIndex((n, i) => keys[i] !== durationKey && !NOT_TIME_RE.test(n) && test(n))
  // "send_time" and "backend_timestamp" are not end times.
  const isEndName = (n: string) => END_KEYS.some((w) => n === w || `_${n}`.includes(`_${w}`))
  const end = [...END_KEYS.map((w) => at((n) => n === w)), at(isEndName)].find((i) => i >= 0) ?? -1
  const tries = [
    ...TIME_KEYS.map((w) => (n: string) => n === w),
    // Short words hide inside others ("attempts", "restarts", "update_count"), so they must stand alone.
    ...TIME_KEYS.map((w) => (n: string) => (w === 'time' || w === 'timestamp' ? n.includes(w) : w !== 't' && `_${n}_`.includes(`_${w}_`))),
  ]
  for (const test of tries) {
    const i = at((n) => !isEndName(n) && test(n))
    if (i >= 0) return { key: keys[i], isEnd: false }
  }
  if (end >= 0) return { key: keys[end], isEnd: true }
  // Unknown names: take the first column that can only be a time (a date, or a clock-sized number that is not an id).
  const sample = rows.slice(0, 50)
  const isClock = (v: unknown) => {
    const s = toSeconds(v)
    if (s === null) return false
    if (typeof v === 'string' && !/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v.trim())) return true
    return [1, 1e3, 1e6, 1e9].some((k) => s >= 1.2e9 * k && s < 2.2e9 * k)
  }
  const i = keys.findIndex((k, j) => k !== durationKey && !/(^|_)id$/.test(names[j]) && sample.filter((r) => isClock(r[k])).length * 2 > sample.length)
  return i >= 0 ? { key: keys[i], isEnd: false } : null
}

/** RFC 4180-style split of one line: quoted fields may hold separators and doubled quotes. */
export function splitCsvLine(line: string, sep: string) {
  if (!line.includes('"')) return line.split(sep).map((c) => c.trim())
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++
      else if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === sep) out.push(cur.trim()), (cur = '')
    else cur += ch
  }
  out.push(cur.trim())
  return out
}

export function parseTrace(text: string): ParseResult {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length === 0) throw new Error('The log is empty.')
  let rows: Record<string, unknown>[] = []
  let lastCell: string | null = null
  let skipped = 0
  const notes: string[] = []

  if (lines[0].trim().startsWith('{')) {
    for (const l of lines) {
      try {
        const row: unknown = JSON.parse(l)
        if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row as Record<string, unknown>)
        else skipped++
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
      lastCell = header[cells.length - 1] ?? null
      rows.push(Object.fromEntries(header.map((h, i) => [h, cells[i]])))
    }
  }
  if (rows.length === 0) throw new Error('No parseable rows found.')
  const lastRow = rows[rows.length - 1]

  const keys = Object.keys(rows[0])
  // Each Modal Function autoscales on its own, so a multi-function log is narrowed to its busiest function.
  const fk = pickKey(keys, FUNC_KEYS)
  if (fk) {
    const appKey = keys.find((k) => k.toLowerCase().trim() === 'app')
    const id = (r: Record<string, unknown>) => `${appKey ? r[appKey] : ''}/${r[fk]}`
    const counts = new Map<string, number>()
    for (const r of rows) counts.set(id(r), (counts.get(id(r)) ?? 0) + 1)
    if (counts.size > 1) {
      let best = ''
      let bestN = -1
      for (const [k, n] of counts) if (n > bestN) (best = k), (bestN = n)
      notes.push(`${counts.size} functions in this log: kept the busiest (${bestN.toLocaleString()} of ${rows.length.toLocaleString()} rows), since each function scales on its own.`)
      rows = rows.filter((r) => id(r) === best)
    }
  }

  // JSON lines may add fields later on; those are only consulted when the first line names no duration or token count.
  const allKeys = () => [...new Set(rows.flatMap((r) => Object.keys(r)))]
  const findKeys = (ks: string[]) => {
    const d = pickKey(ks, DUR_KEYS)
    return { dk: d, ik: d ? null : pickKey(ks, IN_TOK_KEYS), ok: d ? null : pickKey(ks, OUT_TOK_KEYS) }
  }
  const first = findKeys(keys)
  const { dk, ik, ok } = first.dk || first.ok ? first : findKeys(allKeys())
  const time = pickTime(keys, rows, dk)
  if (!time) throw new Error(`No time column found (columns: ${keys.slice(0, 8).join(', ').slice(0, 200)}). Name the column that says when each request arrived "timestamp".`)
  const { key: tk, isEnd: fromEnd } = time
  const rowDur = (row: Record<string, unknown>): number | null => {
    if (dk) return toAmount(row[dk])
    if (!ok) return null
    const out = toAmount(row[ok])
    const inp = !ik || isBlank(row[ik]) ? 0 : toAmount(row[ik])
    if (out === null || inp === null) return null
    return LLM_OVERHEAD_SEC + inp / PREFILL_TOK_PER_SEC + out / DECODE_TOK_PER_SEC
  }
  // In a log of date-times, a bare date is a timestamp cut short: it would read as midnight, hours away.
  const bare = rows.filter((r) => isBareDate(r[tk])).length
  const timed = rows.filter((r) => typeof r[tk] === 'string' && DATE_RE.test(r[tk].trim()) && !isBareDate(r[tk])).length
  // A file that ends inside its last timestamp may still leave something readable, such as a date-time without its zone.
  const prev = rows.length > 1 && rows[rows.length - 1] === lastRow && lastCell === tk ? rows[rows.length - 2][tk] : null
  let garbled = 0
  const pairs: [number, number | null][] = []
  for (const row of rows) {
    const ts = toSeconds(row[tk])
    if (ts === null || (timed > bare && isBareDate(row[tk])) || (row === lastRow && isCutTime(row[tk], prev))) {
      skipped++
      continue
    }
    const dv = rowDur(row)
    if (dv === null && ((dk && !isBlank(row[dk])) || (ok && (!isBlank(row[ok]) || (ik && !isBlank(row[ik])))))) garbled++
    pairs.push([ts, dv])
  }
  if (pairs.length === 0) throw new Error(`Could not read any timestamps from column "${tk}".`)

  // Epoch milliseconds / microseconds -> seconds.
  const maxTs = pairs.reduce((m, p) => Math.max(m, p[0]), -Infinity)
  const tsScale = maxTs > 1e17 ? 1e-9 : maxTs > 1e14 ? 1e-6 : maxTs > 1e11 ? 1e-3 : 1
  if (tsScale !== 1) notes.push(`Timestamps look like epoch ${tsScale === 1e-3 ? 'milliseconds' : tsScale === 1e-6 ? 'microseconds' : 'nanoseconds'}.`)

  let dScale = 1
  const ds = pairs.map((p) => p[1]).filter((x): x is number => x !== null)
  const missing = pairs.length - ds.length
  if (garbled > 0 && garbled >= ds.length) throw new Error(`Could not read ${ds.length ? 'most' : 'any'} durations from column "${dk ?? ok}". Use plain numbers such as 1.5, without units or a decimal comma.`)
  if (dk && ds.length === 0) notes.push(`"${dk}" is empty: using the configured service time.`)
  else if (dk) {
    const med = ds.slice().sort((a, b) => a - b)[ds.length >> 1] ?? 0
    const [scale, unit] = unitOf(dk) ?? (med > 100 ? [1e-3, 'milliseconds'] : [1, 'seconds'])
    dScale = scale
    notes.push(`Durations in "${dk}" read as ${unit}.`)
  } else if (ok) {
    notes.push(`No duration column: service time estimated from "${ok}"${ik ? ` and "${ik}"` : ''} at ${DECODE_TOK_PER_SEC} output tok/s and ${PREFILL_TOK_PER_SEC.toLocaleString()} prompt tok/s.`)
  } else notes.push('No duration column: using the configured service time.')
  if (missing > 0 && ds.length > 0)
    notes.push(`${missing.toLocaleString()} of ${pairs.length.toLocaleString()} rows have no readable duration: ${ds.length > pairs.length * 0.5 ? 'they use the mean of the others' : 'using the configured service time for every row'}.`)
  if (fromEnd) notes.push(`"${tk}" marks when requests finished: arrivals are end minus duration.`)

  // Arrival in seconds; logs that only record completion are shifted back by the request's duration.
  const arrivals: [number, number | null][] = pairs.map(([ts, d]) => {
    const dur = d === null ? null : d * dScale
    return [ts * tsScale - (fromEnd && dur !== null ? dur : 0), dur]
  })
  arrivals.sort((a, b) => a[0] - b[0])
  const t0 = arrivals[0][0]
  const capped = arrivals.slice(0, MAX_REQUESTS)
  if (capped.length < arrivals.length) notes.push(`Trimmed to the first ${MAX_REQUESTS.toLocaleString()} requests.`)
  const t = capped.map((p) => p[0] - t0)
  const haveD = ds.length > pairs.length * 0.5
  const fallback = ds.length ? (ds.reduce((a, b) => a + b, 0) / ds.length) * dScale : 1
  const d = haveD ? capped.map((p) => p[1] ?? fallback) : null
  const horizon = Math.max(60, t[t.length - 1] + 1)
  return { trace: { t, d, horizon }, skipped, notes }
}
