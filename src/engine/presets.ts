import type { SimConfig } from './sim.ts'
import type { TrafficSpec } from './traffic.ts'

export interface Preset {
  id: string
  name: string
  blurb: string
  cfg: Partial<SimConfig>
}

// Rough, typical numbers; tune them to what your own container logs show.
export const PRESETS: Preset[] = [
  {
    id: 'embed-t4',
    name: 'Embeddings · T4',
    blurb: 'Small encoder, fast loads, high concurrency.',
    cfg: { gpu: 'T4', gpuCount: 1, cpuCores: 2, memoryGiB: 8, bootSec: 1, imageSec: 2, modelSec: 3, maxInputs: 8, targetInputs: 0, serviceMean: 0.08 },
  },
  {
    id: 'whisper-l4',
    name: 'Whisper · L4',
    blurb: 'Speech-to-text, a few seconds per clip.',
    cfg: { gpu: 'L4', gpuCount: 1, cpuCores: 4, memoryGiB: 16, bootSec: 1, imageSec: 4, modelSec: 8, maxInputs: 1, targetInputs: 0, serviceMean: 3 },
  },
  {
    id: 'sdxl-a10g',
    name: 'SDXL · A10G',
    blurb: 'Image generation, one image per container at a time.',
    cfg: { gpu: 'A10G', gpuCount: 1, cpuCores: 4, memoryGiB: 16, bootSec: 1, imageSec: 6, modelSec: 14, maxInputs: 1, targetInputs: 0, serviceMean: 4 },
  },
  {
    id: 'llm8b-h100',
    name: '8B LLM (vLLM) · H100',
    blurb: 'Continuous batching; slow model load dominates cold start.',
    cfg: { gpu: 'H100', gpuCount: 1, cpuCores: 8, memoryGiB: 64, bootSec: 1, imageSec: 10, modelSec: 45, maxInputs: 32, targetInputs: 24, serviceMean: 6 },
  },
  {
    id: 'llm70b-h200',
    name: '70B LLM · 2×H200',
    blurb: 'Huge weights; cold starts measured in minutes.',
    cfg: { gpu: 'H200', gpuCount: 2, cpuCores: 16, memoryGiB: 256, bootSec: 1, imageSec: 20, modelSec: 140, maxInputs: 48, targetInputs: 32, serviceMean: 12 },
  },
  {
    id: 'video-b200',
    name: 'Video gen · B200',
    blurb: 'Long jobs, one per GPU.',
    cfg: { gpu: 'B200', gpuCount: 1, cpuCores: 8, memoryGiB: 128, bootSec: 1, imageSec: 15, modelSec: 60, maxInputs: 1, targetInputs: 0, serviceMean: 45 },
  },
]

export const DEFAULT_CFG: SimConfig = {
  gpu: 'A10G',
  gpuCount: 1,
  cpuCores: 4,
  memoryGiB: 16,
  minContainers: 0,
  maxContainers: 20,
  bufferContainers: 0,
  scaledownWindow: 60,
  maxInputs: 1,
  targetInputs: 0,
  bootSec: 1,
  imageSec: 6,
  modelSec: 14,
  snapshot: false,
  serviceMean: 4,
}

export const DEFAULT_TRAFFIC: TrafficSpec = { kind: 'bursty', rate: 0.25, hours: 6, seed: 42, serviceMean: 4, serviceCv: 0.4 }

export const SAMPLE_TRAFFIC: { id: string; name: string; spec: TrafficSpec; preset: string }[] = [
  { id: 'bursty', name: 'Bursty app sessions', spec: DEFAULT_TRAFFIC, preset: 'sdxl-a10g' },
  { id: 'diurnal', name: 'Diurnal chat API, 24h', spec: { kind: 'diurnal', rate: 1.5, hours: 24, seed: 7, serviceMean: 6, serviceCv: 0.6 }, preset: 'llm8b-h100' },
  { id: 'poisson', name: 'Steady transcription', spec: { kind: 'poisson', rate: 0.4, hours: 4, seed: 3, serviceMean: 3, serviceCv: 0.5 }, preset: 'whisper-l4' },
  { id: 'spike', name: 'Launch-day spike', spec: { kind: 'spike', rate: 2, hours: 3, seed: 11, serviceMean: 0.08, serviceCv: 0.3 }, preset: 'embed-t4' },
]
