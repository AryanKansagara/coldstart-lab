import { test as base, expect, type Page } from '@playwright/test'

/** The only external hosts the page asks for: web fonts in index.html. They are answered with an empty stylesheet. */
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com'])

export const test = base.extend<{ guard: void }>({
  // Every test: only the app is reachable, and an uncaught page error fails the test.
  guard: [
    async ({ context, baseURL }, use) => {
      const errors: string[] = []
      const external: string[] = []
      const origin = new URL(baseURL!).origin
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url())
        if (url.origin === origin) return route.continue()
        external.push(url.host)
        if (FONT_HOSTS.has(url.host)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' })
        return route.abort('blockedbyclient')
      })
      context.on('weberror', (e) => errors.push(String(e.error())))
      // The clipboard is replaced so a test can read what the page copied without browser permissions.
      await context.addInitScript(() => {
        const copied: string[] = []
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t: string) => void copied.push(t) }, configurable: true })
        Object.assign(window, { __copied: copied })
      })
      await use()
      expect(errors, 'uncaught page errors').toEqual([])
      expect(external.filter((h) => !FONT_HOSTS.has(h)), 'requests to other hosts').toEqual([])
    },
    { auto: true },
  ],
})

export { expect }

export const copied = (page: Page) => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied.at(-1) ?? '')

/**
 * The container every hand-worked example uses: one T4, 1 core, 0 GiB, cold start 2 + 3 + 5 = 10 s, one input and one
 * container at a time. Price: 0.000164 (T4) + 0.0000131 (core) = 0.0001771 $/s.
 */
export const HAND_CFG = {
  gpu: 'T4', gpuCount: 1, cpuCores: 1, memoryGiB: 0, minContainers: 0, maxContainers: 1, bufferContainers: 0, scaledownWindow: 60,
  maxInputs: 1, targetInputs: 0, bootSec: 2, imageSec: 3, modelSec: 5, snapshot: false, serviceMean: 2,
}
export const HAND_PRICE = 0.0001771

/** Opens the lab on "Your logs". Passing `cfg` starts from saved settings, the way a returning visitor would. */
export async function openLogs(page: Page, cfg?: object, slo = 5) {
  if (cfg) {
    await page.goto('/docs')
    await page.evaluate((s) => localStorage.setItem('coldstart-lab:v1', s), JSON.stringify({ cfg, slo }))
  }
  await page.goto('/app')
  await page.getByRole('tab', { name: 'Your logs' }).click()
  await expect(page.locator('.kpis')).toBeVisible()
  await settled(page)
}

/** Waits until the worker has answered the latest input. */
export async function settled(page: Page) {
  await page.waitForTimeout(200)
  await expect(page.locator('.kpis, .alert').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.lab-top .status')).not.toHaveClass(/on/, { timeout: 30_000 })
}

export async function pasteLog(page: Page, text: string) {
  await page.getByLabel('Paste a request log').fill(text)
  await page.getByRole('button', { name: 'Use pasted log' }).click()
  await settled(page)
}

export async function uploadLog(page: Page, name: string, text: string) {
  await page.locator('input[type=file]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) })
  await settled(page)
}

/** Value (and small print) of each tile, by label. */
export async function kpis(page: Page) {
  const rows = await page.locator('.kpi').evaluateAll((els) => els.map((e) => [e.querySelector('.kpi-label')?.textContent ?? '', e.querySelector('.kpi-value')?.textContent ?? '', e.querySelector('.kpi-sub')?.textContent ?? '']))
  return Object.fromEntries(rows.map(([l, v, s]) => [l, s ? `${v} | ${s}` : v]))
}

/** Decodes the state carried by a share link, with the platform's own inflate. */
export const decodeLink = (page: Page, url: string) =>
  page.evaluate(async (u) => {
    const b64 = (u.split('#s=')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    return JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text())
  }, url)

export const note = (page: Page) => page.locator('.note.mono')
export const alert = (page: Page) => page.getByRole('alert')
