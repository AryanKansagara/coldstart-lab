// Modal public on-demand prices, per second. Source: https://modal.com/pricing
export const PRICES_AS_OF = '2026-11-03'
export const PRICES_SOURCE = 'https://modal.com/pricing'

export const GPU_PRICE_PER_SEC = {
  T4: 0.000164,
  L4: 0.000222,
  A10G: 0.000306,
  L40S: 0.000542,
  'A100-40GB': 0.000583,
  'A100-80GB': 0.000694,
  'RTX-PRO-6000': 0.000842,
  H100: 0.001097,
  H200: 0.001261,
  B200: 0.001736,
  B300: 0.001972,
} as const

export type Gpu = keyof typeof GPU_PRICE_PER_SEC
export const GPUS = Object.keys(GPU_PRICE_PER_SEC) as Gpu[]

/** Per physical core (2 vCPU) per second. Modal bills a 0.125 core minimum. */
export const CPU_CORE_PRICE_PER_SEC = 0.0000131
export const MEMORY_GIB_PRICE_PER_SEC = 0.00000222

export function containerPricePerSec(gpu: Gpu, gpuCount: number, cpuCores: number, memoryGiB: number): number {
  return (
    GPU_PRICE_PER_SEC[gpu] * gpuCount +
    CPU_CORE_PRICE_PER_SEC * Math.max(0.125, cpuCores) +
    MEMORY_GIB_PRICE_PER_SEC * memoryGiB
  )
}
