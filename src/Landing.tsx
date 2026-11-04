import { lazy, Suspense } from 'react'
import { Link } from './App.tsx'
import { GPU_PRICE_PER_SEC, GPUS, PRICES_AS_OF, PRICES_SOURCE } from './engine/pricing.ts'
import { SAMPLE_TRAFFIC } from './engine/presets.ts'

const HeroSim = lazy(() => import('./HeroSim.tsx'))

const KNOBS = [
  ['min_containers', 'A warm floor, billed around the clock. Kills cold starts after quiet periods, and is usually the priciest fix.'],
  ['buffer_containers', 'Spare idle containers while the Function is active. Pays for itself on bursts where one input predicts more.'],
  ['scaledown_window', 'How long an idle container waits, from 2s to 20 min. Cheap when traffic gaps are short, wasteful when they are not.'],
  ['max_containers', 'The ceiling. Past it, inputs queue, and that queue is what shows up in your p99 on launch day.'],
  ['@modal.concurrent(max_inputs)', 'Inputs per container. Often the cheapest latency and cost win in the whole config, if the workload batches.'],
  ['target_inputs', 'Where the autoscaler aims below max_inputs, leaving burst headroom while new containers boot.'],
]

const STEPS = [
  ['01', 'Bring your traffic', 'Drop a CSV or JSONL request log, or generate diurnal, bursty, Poisson or spike traffic from a seed.'],
  ['02', 'Replay it', 'A discrete-event simulator runs every request through the autoscaler in a Web Worker, with real per-second GPU prices.'],
  ['03', 'Pick from the frontier', 'Grid-search the knobs, click a point on the cost vs p99 Pareto frontier, and paste the resulting decorator.'],
]

export default function Landing() {
  return (
    <>
      <section className="hero">
        <p className="eyebrow mono">Discrete-event autoscaler simulator</p>
        <h1>
          Stop guessing your
          <br />
          <span className="accent">cold start</span> settings.
        </h1>
        <p className="lede">Replay your real request trace through a simulation of Modal's autoscaler. See p99, cold starts and dollars for every config before you deploy one.</p>
        <div className="cta">
          <Link href="/app" className="btn btn-primary">
            Open the lab
          </Link>
          <a className="btn btn-ghost" href="#how">
            How it works
          </a>
        </div>
        <Suspense fallback={<div className="stage stage-loading" aria-hidden />}>
          <HeroSim />
        </Suspense>
        <p className="hero-hint mono">This is the real simulator, not an animation. Change a knob and the replay re-runs.</p>
      </section>

      <section className="band" id="how">
        <div className="band-head">
          <p className="eyebrow mono">How it works</p>
          <h2>Tune it on a Tuesday, not during the incident.</h2>
          <p className="lede sm">
            A warm H100 costs real money every idle hour and a cold one costs your users the time it takes to load the weights. The right trade-off depends on the shape of your traffic, and that is the one thing a pricing calculator cannot see.
          </p>
        </div>
        <ol className="steps">
          {STEPS.map(([n, t, b]) => (
            <li key={n}>
              <span className="mono step-n">{n}</span>
              <h3>{t}</h3>
              <p>{b}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="band" id="knobs">
        <div className="band-head">
          <p className="eyebrow mono">Every knob Modal exposes</p>
          <h2>The same names you put in your decorator.</h2>
        </div>
        <div className="knob-grid">
          {KNOBS.map(([k, b]) => (
            <article key={k} className="card">
              <code>{k}</code>
              <p>{b}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="band">
        <div className="band-head">
          <p className="eyebrow mono">Start from a sample</p>
          <h2>Four traffic shapes, four very different answers.</h2>
        </div>
        <div className="sample-grid">
          {SAMPLE_TRAFFIC.map((s) => (
            <Link key={s.id} href={`/app?sample=${s.id}`} className="card card-link">
              <span className="mono dim">{s.spec.kind}</span>
              <h3>{s.name}</h3>
              <span className="card-go mono">Replay →</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="band">
        <div className="band-head">
          <p className="eyebrow mono">
            The price of staying warm ·{' '}
            <a href={PRICES_SOURCE} target="_blank" rel="noreferrer">
              modal.com/pricing, {PRICES_AS_OF}
            </a>
          </p>
          <h2>One idle container, 24 hours.</h2>
        </div>
        <ul className="price-grid">
          {GPUS.map((g) => (
            <li key={g}>
              <span className="mono">{g}</span>
              <b>${(GPU_PRICE_PER_SEC[g] * 86400).toFixed(2)}</b>
            </li>
          ))}
        </ul>
      </section>

      <section className="closer">
        <h2>Your trace. Your numbers.</h2>
        <p className="lede sm">It runs entirely in your browser, so your logs never leave the page.</p>
        <Link href="/app" className="btn btn-primary">
          Open the lab
        </Link>
      </section>
    </>
  )
}
