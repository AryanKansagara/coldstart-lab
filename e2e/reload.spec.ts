import { test, expect, openLogs, pasteLog, uploadLog, settled, kpis, note, HAND_CFG } from './fixtures.ts'

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

test.fail('#8: a log too big for the link survives a reload', async ({ page }) => {
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
