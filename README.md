# Cold Start Lab

Replay a real request trace through a simulation of [Modal](https://modal.com)'s autoscaler and tune it before you deploy.

**Live:** https://coldstart-lab.vercel.app

## The pain

`min_containers`, `buffer_containers` and `scaledown_window` trade dollars for cold starts, and the right answer depends on the shape of your traffic. A pricing calculator cannot see that shape, so most teams guess, then find out from a p99 alert or a GPU bill.

## Features

- **Your data:** drop or paste a CSV/TSV/JSONL request log (timestamp, optional duration or latency), or generate diurnal, bursty, Poisson or spike traffic from a seed. Also reads completion-only logs (`end_timestamp,duration`, as in the Azure Functions 2021 trace), LLM token logs (`ContextTokens,GeneratedTokens` or `prompt_tokens,completion_tokens`), quoted CSV, and multi-function logs (keeps the busiest function).
- **Real trace included:** one hour of Azure's production LLM chat traffic (19,366 requests, [Azure Public Dataset](https://github.com/Azure/AzurePublicDataset/blob/master/AzureLLMInferenceDataset2023.md), CC BY 4.0), loaded unchanged from `public/samples/`. The four generated samples are synthetic.
- **Discrete-event simulator:** `min_containers`, `max_containers`, `buffer_containers`, `scaledown_window`, `@modal.concurrent(max_inputs, target_inputs)`, queueing, and cold start as boot + image + model, with GPU presets and memory snapshots.
- **Real prices:** Modal's per-second GPU, CPU and memory rates, re-checked against modal.com/pricing on 2026-11-15, in `src/engine/pricing.ts`. Tests reproduce Modal's own worked pricing examples.
- **Docs:** formats, model and sources at [/docs](https://coldstart-lab.vercel.app/docs).
- **Outputs:** p50/p95/p99, cold-start hit rate, queue time, cost, $/1k requests, idle cost, an animated timeline and a latency histogram.
- **Optimizer:** grid search with a cost vs p99 Pareto frontier. Click a point to apply it, compare scenarios side by side, get recommendations in plain English, and copy the resulting decorator.
- **Stays smooth and private:** everything runs in Web Workers in your browser. State lives in a shareable URL.

## Model limits

An idle container lives its full `scaledown_window` (Modal may reap earlier when overprovisioned), concurrency does not slow an input down, and preemption and capacity delays are not modeled. Cold-start presets are typical figures, so set them from your own logs. For token-only logs, service time is estimated from token counts at assumed speeds (60 output tok/s, 10,000 prompt tok/s). The lab states these assumptions too.

## Run locally

```sh
npm install
npm run dev
npm test
npm run build
```

Independent project, not affiliated with Modal.
