import { test, expect, openLogs, pasteLog, uploadLog, settled, kpis, copied, decodeLink, HAND_CFG } from './fixtures.ts'

const LOG = 'timestamp,duration_s\n0,2\n11,4\n100,3\n120,1\n'

test('a share link carries settings and a small log to another browser', async ({ page, browser, baseURL }) => {
  await openLogs(page, HAND_CFG)
  await pasteLog(page, LOG)
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: 'Copy share link' }).click()
  await expect(page.getByText('Link copied.')).toBeVisible()
  const link = await copied(page)
  expect(link.startsWith(`${baseURL}/app#s=`)).toBe(true)
  const before = await kpis(page)

  const other = await browser.newContext({ baseURL })
  await other.route('**/*', (r) => (r.request().url().startsWith(baseURL!) ? r.continue() : r.abort()))
  const p2 = await other.newPage()
  await p2.goto(link)
  await settled(p2)
  expect(await kpis(p2)).toEqual(before)
  await expect(p2.getByLabel('max_containers')).toHaveValue('1')
  await other.close()
})

test('a big log is left out of the link, and the page says so', async ({ page }) => {
  await openLogs(page, HAND_CFG)
  await uploadLog(page, 'big.csv', `timestamp,duration_s\n${Array.from({ length: 3000 }, (_, i) => `${i * 10},2\n`).join('')}`)
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: 'Copy share link' }).click()
  await expect(page.getByText('carries the settings only')).toBeVisible()
  expect((await decodeLink(page, await copied(page))).upload).toBeNull()
})

test('hostile values in a link are forced into range and shown as text', async ({ page }) => {
  await openLogs(page)
  const hash = await page.evaluate(async () => {
    const state = { cfg: { gpu: 'constructor', minContainers: 1e9, maxContainers: -4, scaledownWindow: 'x' }, slo: -1, scenarios: [{ name: '<img src=x onerror=alert(1)>', cfg: null }] }
    const z = new Uint8Array(await new Response(new Blob([JSON.stringify(state)]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer())
    return btoa(String.fromCharCode(...z)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  })
  await page.goto('/docs')
  await page.goto(`/app#s=${hash}`)
  await settled(page)
  await expect(page.getByLabel('max_containers')).toHaveValue('1')
  await expect(page.getByRole('spinbutton', { name: 'scaledown_window' })).toHaveValue('60')
  await expect(page.getByLabel('Scenario 1 name')).toHaveValue('<img src=x onerror=alert(1)>')
  await expect(page.locator('img[src="x"]')).toHaveCount(0)
})

test.fail('#10: the link leaves out a log that is not the one on screen', async ({ page }) => {
  await openLogs(page, HAND_CFG)
  await pasteLog(page, 'timestamp,duration_s,user\n0,2,someone@example.com\n')
  await page.getByRole('tab', { name: 'Generate' }).click()
  await settled(page)
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: 'Copy share link' }).click()
  await expect.poll(() => copied(page)).toContain('#s=')
  expect((await decodeLink(page, await copied(page))).upload).toBeNull()
})

test.fail('#10: a link copied right after an edit carries the edit', async ({ page }) => {
  await openLogs(page, HAND_CFG)
  await page.waitForTimeout(800)
  // Edit and click back to back inside the page, so a slow machine cannot hide the gap.
  await page.evaluate(async () => {
    const input = [...document.querySelectorAll('label')].find((l) => l.textContent?.startsWith('min_containers'))!.querySelector('input')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '1')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 50))
    ;[...document.querySelectorAll('button')].find((b) => b.textContent === 'Copy share link')!.click()
  })
  await expect.poll(() => copied(page)).toContain('#s=')
  expect((await decodeLink(page, await copied(page))).cfg.minContainers).toBe(1)
})

test.fail('#10: a refused clipboard is not reported as copied', async ({ page }) => {
  await openLogs(page, HAND_CFG)
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true }))
  await page.getByRole('button', { name: 'Copy share link' }).click()
  await expect(page.locator('.lab-top .micro')).toHaveText(/./)
  expect(await page.locator('.lab-top .micro').textContent()).not.toContain('Link copied')
})

test.fail('#11: a damaged link says it could not be opened', async ({ page }) => {
  await page.goto('/app#s=AAAA-cut-off')
  await expect(page.locator('.kpis')).toBeVisible()
  await expect(page.getByText(/link .*(damaged|could not be (read|opened))/i)).toBeVisible({ timeout: 3000 })
})
