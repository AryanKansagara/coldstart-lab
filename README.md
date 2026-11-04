# Cold Start Lab

Replay a real request trace through a simulation of [Modal](https://modal.com)'s autoscaler and tune it before you deploy.

**Live:** LIVE_URL

## The pain

`min_containers`, `buffer_containers` and `scaledown_window` trade dollars for cold starts, and the right answer depends on the shape of your traffic. A pricing calculator cannot see that shape, so most teams guess, then find out from a p99 alert or a GPU bill.

## Features

- **Your data:** drop or paste a CSV/JSONL request log (timestamp, optional duration or latency), or generate diurnal, bursty, Poisson or spike traffic from a seed. Four samples included.
- **Discrete-event simulator:** `min_containers`, `max_containers`, `buffer_containers`, `scaledown_window`, `@modal.concurrent(max_inputs, target_inputs)`, queueing, and cold start as boot + image + model, with GPU presets and memory snapshots.
- **Real prices:** Modal's per-second GPU, CPU and memory rates, dated, in `src/engine/pricing.ts`.
- **Outputs:** p50/p95/p99, cold-start hit rate, queue time, cost, $/1k requests, idle cost, an animated timeline and a latency histogram.
- **Optimizer:** grid search with a cost vs p99 Pareto frontier. Click a point to apply it, compare scenarios side by side, get recommendations in plain English, and copy the resulting decorator.
- **Stays smooth and private:** everything runs in Web Workers in your browser. State lives in a shareable URL.

## Model limits

An idle container lives its full `scaledown_window` (Modal may reap earlier when overprovisioned), concurrency does not slow an input down, and preemption and capacity delays are not modeled. Cold-start presets are typical figures, so set them from your own logs. The lab states these assumptions too.

## Run locally

```sh
npm install
npm run dev
npm test
npm run build
```

Independent project, not affiliated with Modal.
