import { Link } from './App.tsx'
import { CPU_CORE_PRICE_PER_SEC, GPU_PRICE_PER_SEC, GPUS, MEMORY_GIB_PRICE_PER_SEC, PRICES_AS_OF, PRICES_SOURCE } from './engine/pricing.ts'
import { DECODE_TOK_PER_SEC, LLM_OVERHEAD_SEC, PREFILL_TOK_PER_SEC } from './engine/traffic.ts'
import { SNAPSHOT_SPEEDUP } from './engine/sim.ts'

const AZURE_LLM = 'https://github.com/Azure/AzurePublicDataset/blob/master/AzureLLMInferenceDataset2023.md'
const AZURE_FN = 'https://github.com/Azure/AzurePublicDataset/blob/master/AzureFunctionsInvocationTrace2021.md'

export default function Docs() {
  return (
    <article className="band docs">
      <div className="band-head">
        <p className="eyebrow mono">Docs</p>
        <h2>Formats, model and sources</h2>
        <p className="lede sm">What the lab reads, how it simulates Modal's autoscaler, and where every number comes from.</p>
      </div>

      <h3>Request logs it reads</h3>
      <ul>
        <li>
          <b>CSV, TSV or semicolon CSV</b> with a header, or headerless <code>timestamp,duration</code>. Quoted fields may contain commas. One row per request.
        </li>
        <li>
          <b>JSONL</b>, one object per line.
        </li>
        <li>
          <b>Arrival time</b> from a column named like <code>timestamp</code>, <code>time</code>, <code>ts</code>, <code>start_time</code>, <code>created_at</code> or <code>date</code>: ISO 8601 (space or T, any number of fraction digits, optional offset), epoch seconds, milliseconds or microseconds, or seconds from the start of the trace. A file with no such column, and no column of dates, is refused.
        </li>
        <li>
          <b>Completion-only logs</b> such as the{' '}
          <a href={AZURE_FN} target="_blank" rel="noreferrer">
            Azure Functions 2021 trace
          </a>{' '}
          (<code>app,func,end_timestamp,duration</code>): arrival is <code>end_timestamp − duration</code>.
        </li>
        <li>
          <b>Duration</b> from <code>duration</code>, <code>latency</code>, <code>execution_time</code> and similar. Names with <code>ms</code>, or a median above 100, are read as milliseconds.
        </li>
        <li>
          <b>LLM token logs</b> such as the{' '}
          <a href={AZURE_LLM} target="_blank" rel="noreferrer">
            Azure LLM inference trace
          </a>{' '}
          (<code>TIMESTAMP,ContextTokens,GeneratedTokens</code>) or <code>prompt_tokens</code>/<code>completion_tokens</code>: with no duration column, service time is estimated as {LLM_OVERHEAD_SEC} s + prompt tokens ÷ {PREFILL_TOK_PER_SEC.toLocaleString()} + output tokens ÷ {DECODE_TOK_PER_SEC}. Edit the CSV with your own measured durations for a sharper answer.
        </li>
        <li>
          <b>Several functions in one log</b> (a <code>func</code>, <code>function</code> or <code>endpoint</code> column): each Modal Function scales on its own, so the lab keeps the busiest one and says so.
        </li>
      </ul>

      <h3>Real data you can try</h3>
      <p>
        <b>Real Azure LLM trace</b> in the lab's "Your logs" tab loads <code>AzureLLMInferenceTrace_conv.csv</code> unchanged: 19,366 chat requests from one hour of Azure's production LLM service on 16 November 2023. Source:{' '}
        <a href={AZURE_LLM} target="_blank" rel="noreferrer">
          Azure Public Dataset
        </a>
        , licensed CC BY 4.0, from Patel et al., "Splitwise: Efficient generative LLM inference using phase splitting", ISCA 2024. The four generated samples are synthetic and labelled as such.
      </p>

      <h3>Simulation model</h3>
      <ul>
        <li>Discrete-event replay of every request. Desired containers = ⌈(in flight + queued) ÷ target_inputs⌉ + buffer_containers, clamped to [min_containers, max_containers].</li>
        <li>Inputs pack onto warm containers up to target_inputs, then burst to max_inputs. A new container is cold for boot + image + model seconds; with memory snapshots, image and model load run {SNAPSHOT_SPEEDUP}× faster.</li>
        <li>An idle container is reclaimed only after a full scaledown_window and only while there are more containers than desired. Modal can reap earlier when overprovisioned, so idle cost here is an upper bound.</li>
        <li>Billing is per second from container start to stop, including the cold start. Not modelled: preemption, GPU capacity delays, region multipliers, and slowdown from concurrency.</li>
        <li>Percentiles use nearest rank. The grid search sweeps min_containers, buffer_containers, scaledown_window and target_inputs.</li>
      </ul>

      <h3>Prices</h3>
      <p>
        Modal on-demand rates per second, checked against{' '}
        <a href={PRICES_SOURCE} target="_blank" rel="noreferrer">
          {PRICES_SOURCE}
        </a>{' '}
        on {PRICES_AS_OF}. CPU is ${CPU_CORE_PRICE_PER_SEC} per physical core (0.125 core minimum), memory ${MEMORY_GIB_PRICE_PER_SEC} per GiB. The test suite reproduces Modal's own worked examples on that page.
      </p>
      <div className="docs-table">
        <table>
          <thead>
            <tr>
              <th>GPU</th>
              <th>$/sec</th>
              <th>$/hour</th>
            </tr>
          </thead>
          <tbody>
            {GPUS.map((g) => (
              <tr key={g}>
                <td className="mono">{g}</td>
                <td className="mono">{GPU_PRICE_PER_SEC[g]}</td>
                <td className="mono">{(GPU_PRICE_PER_SEC[g] * 3600).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="docs-cta">
        <Link href="/app" className="btn btn-primary">
          Open the lab
        </Link>
      </p>
    </article>
  )
}
