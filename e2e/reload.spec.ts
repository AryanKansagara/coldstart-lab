import { test, expect, openLogs, pasteLog, uploadLog, settled, kpis, note, decodeLink, HAND_CFG } from './fixtures.ts'

const SMALL = 'timestamp,duration_s\n0,2\n11,4\n100,3\n120,1\n'

test('settings, target, scenarios and a small log survive a reload', async ({ page }) => {
  await openLogs(page, HAND_CFG)
  await pasteLog(page, SMALL)
  await page.getByLabel('p99 target').fill('7')
  await page.getByLabel('boot').fill('4')
  await settled(page)
  await page.getByRole('button', { name: 'Save scenario' }).click()
  await settled(page)
  const before = await kpis(page)
  expect(before.p99).toBe('15.0 s | target 7.00 s')
  await page.waitForTimeout(800) // the page saves 400 ms after the last change
  await page.reload()
  await settled(page)
  expect(await kpis(page)).toEqual(before)
  await expect(page.locator('.drop b')).toHaveText('pasted log')
  await expect(page.getByLabel('Scenario 1 name')).toHaveValue('min 0 · buf 0 · 60s')
})

test('settings survive opening /app again without the link', async ({ page }) => {
  await openLogs(page, HAND_CFG)
  await pasteLog(page, SMALL)
  await page.waitForTimeout(800)
  await page.goto('/docs')
  await page.goto('/app')
  await settled(page)
  expect(await kpis(page)).toMatchObject({ 'total cost': '$0.017 | $12.27/day' })
})

test('corrupt saved data falls back to the defaults', async ({ page }) => {
  await page.goto('/docs')
  await page.evaluate(() => localStorage.setItem('coldstart-lab:v1', '{"cfg":'))
  await page.goto('/app')
  await expect(page.locator('.kpis')).toBeVisible()
  await expect(page.getByRole('spinbutton', { name: 'scaledown_window' })).toHaveValue('60')
})

test('#8: a log too big for the link survives a reload', async ({ page }) => {
  // 3,000 requests, one every 10 s, about 25 KB: over the 16,000 characters a link carries, under the 2 MB the browser keeps.
  await openLogs(page, HAND_CFG)
  await uploadLog(page, 'big.csv', `timestamp,duration_s\n${Array.from({ length: 3000 }, (_, i) => `${100000 + i * 10},2\n`).join('')}`)
  await expect(note(page)).toContainText('3,000 requests')
  const before = await kpis(page)
  await page.waitForTimeout(800)
  await page.reload()
  await settled(page)
  await expect(page.locator('.drop b')).toHaveText('big.csv', { timeout: 3000 })
  expect(await kpis(page)).toEqual(before)
})

test('#8: the real Azure trace survives a reload', async ({ page }) => {
  await openLogs(page)
  await page.getByRole('button', { name: 'Real Azure LLM trace' }).click()
  await expect(note(page)).toContainText('19,366 requests', { timeout: 30_000 })
  await settled(page)
  const before = await kpis(page)
  await page.waitForTimeout(1500)
  for (let i = 0; i < 2; i++) {
    await page.reload()
    await settled(page)
    await expect(note(page)).toContainText('19,366 requests')
    expect(await kpis(page)).toEqual(before)
    await page.waitForTimeout(800) // the reloaded page saves again and must not lose the log either
  }
})

test('#8: a big log survives another tab saving its own state', async ({ page, context }) => {
  await openLogs(page, HAND_CFG)
  await uploadLog(page, 'big.csv', `timestamp,duration_s\n${Array.from({ length: 3000 }, (_, i) => `${100000 + i * 10},2\n`).join('')}`)
  await page.waitForTimeout(800)
  const other = await context.newPage()
  await other.goto('/app')
  await other.getByRole('tab', { name: 'Generate' }).click()
  await other.waitForTimeout(800)
  await page.reload()
  await settled(page)
  await expect(page.locator('.drop b')).toHaveText('big.csv')
})

test('#8: a link from someone else wins over a saved big log, even with the same settings', async ({ page, context }) => {
  await openLogs(page, HAND_CFG)
  await uploadLog(page, 'big.csv', `timestamp,duration_s\n${Array.from({ length: 3000 }, (_, i) => `${100000 + i * 10},2\n`).join('')}`)
  await page.waitForTimeout(800)
  const link = page.url()
  expect((await decodeLink(page, link)).upload).toBeNull()
  const other = await context.newPage()
  await other.goto(link)
  await settled(other)
  await expect(other.getByRole('tab', { name: 'Generate' })).toHaveAttribute('aria-selected', 'true')
  await expect(other.getByLabel('max_containers')).toHaveValue('1')
})

test('#8: leaving the lab while its link is being written keeps the new address', async ({ page }) => {
  await page.goto('/app')
  await settled(page)
  await page.evaluate(() => {
    const real = CompressionStream
    // Slow the encoder down so the page change falls inside it.
    Object.assign(window, { CompressionStream: class { constructor(f: CompressionFormat) { const c = new real(f); const t = new TransformStream({ transform: async (b, k) => { await new Promise((r) => setTimeout(r, 600)); k.enqueue(b) } }); return { writable: c.writable, readable: c.readable.pipeThrough(t) } as never } } })
  })
  await page.getByLabel('boot').fill('4')
  await page.waitForTimeout(600)
  await page.getByRole('navigation').getByRole('link', { name: 'Docs', exact: true }).click()
  await page.waitForTimeout(1500)
  expect(new URL(page.url()).pathname).toBe('/docs')
})
