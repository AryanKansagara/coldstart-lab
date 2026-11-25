import { test, expect, openLogs, pasteLog, settled, kpis, HAND_CFG, HAND_PRICE } from './fixtures.ts'

/*
 * Worked on paper, with HAND_CFG (10 s cold start, one container, one input at a time, 60 s scaledown_window).
 * Arrivals at 0, 11, 100 and 120 s; the window ends 1 s after the last arrival, at 121 s.
 *
 *  request  arrives  takes  served    queue  latency  cold
 *  1        0        2      10-12     10     12       yes (boot 0-10)
 *  2        11       4      12-16     1      5        no  (the container was ready at 10)
 *  3        100      3      110-113   10     13       yes (first container idle from 16, gone at 76)
 *  4        120      1      120-121   0      1        no
 *
 *  Containers alive 0-76 and 100-121 = 97 s billed: 20 booting, 10 busy, 67 idle.
 *  Cost 97 x 0.0001771 = $0.0171787; per 1k = x 250 = $4.294675; per day = / 121 x 86400 = $12.266.
 */
const LOG = 'timestamp,duration_s\n0,2\n11,4\n100,3\n120,1\n'

test('cost, latency, cold starts and queue time match the paper example', async ({ page }) => {
  await openLogs(page, HAND_CFG)
  await pasteLog(page, LOG)
  expect(await kpis(page)).toEqual({
    p50: '5.00 s',
    p95: '13.0 s',
    p99: '13.0 s | target 5.00 s',
    'cold-start hits': '50% | 2 requests',
    'queue time': '5.25 s | mean · p99 10.0 s',
    'total cost': '$0.017 | $12.27/day',
    'per 1k requests': '$4.29',
    'idle cost': '$0.012 | + $0.0035 booting',
  })
  await expect(page.locator('.lab-top')).toContainText('4 requests · 2:01 window · 2 cold boots')
})

test('the timeline adds up to the billed container-seconds', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openLogs(page, HAND_CFG)
  await pasteLog(page, LOG)
  const svg = page.getByRole('img', { name: /^Timeline over 2:01\. Peak 2 containers/ })
  // Requests 1 and 2 overlap at 11-12 s, so the axis reaches 2. The alive line runs from y=8 (two containers) to y=170 (none), one point per bucket.
  const d = await svg.locator('path[stroke="var(--viz-alive)"]').getAttribute('d')
  const alive = d!.slice(1).split('L').map((p) => 2 * (1 - (Number(p.trim().split(/\s+/)[1]) - 8) / 162))
  const billed = (alive.reduce((a, b) => a + b, 0) / alive.length) * 121
  expect(Math.abs(billed - 97)).toBeLessThan(0.1)
  expect(billed * HAND_PRICE).toBeCloseTo(0.0171787, 4)
})

test('min_containers=1 removes cold starts and bills the whole window', async ({ page }) => {
  // Every request is served on arrival: latencies 2, 4, 3, 1. Billed 121 s: $0.0214291, $5.357 per 1k, $15.30/day; idle 111 s = $0.0196581.
  await openLogs(page, HAND_CFG)
  await pasteLog(page, LOG)
  await page.getByLabel('min_containers').fill('1')
  await settled(page)
  expect(await kpis(page)).toEqual({
    p50: '2.00 s',
    p95: '4.00 s',
    p99: '4.00 s | target 5.00 s',
    'cold-start hits': '0.0% | 0 requests',
    'queue time': '0 ms | mean · p99 0 ms',
    'total cost': '$0.021 | $15.30/day',
    'per 1k requests': '$5.36',
    'idle cost': '$0.020 | + $0 booting',
  })
})

test('a 100 s scaledown_window keeps the first container for request 3', async ({ page }) => {
  // Idle from 16 s would end at 116 s, so requests 3 and 4 are warm: latencies 12, 5, 3, 1; one cold start; queue (10 + 1) / 4.
  // Billed 0-121: 10 booting, 10 busy, 101 idle = $0.0178871.
  await openLogs(page, HAND_CFG)
  await pasteLog(page, LOG)
  await page.getByRole('spinbutton', { name: 'scaledown_window' }).fill('100')
  await settled(page)
  expect(await kpis(page)).toMatchObject({
    p50: '3.00 s',
    p99: '12.0 s | target 5.00 s',
    'cold-start hits': '25% | 1 requests',
    'queue time': '2.75 s | mean · p99 10.0 s',
    'total cost': '$0.021 | $15.30/day',
    'idle cost': '$0.018 | + $0.0018 booting',
  })
})

test('the optimizer finds both paper frontier points and applying one changes the run', async ({ page }) => {
  // Cheapest: scaledown_window=2. Boots at 0, 100 and 120 live 18 + 15 + 11 = 44 s; latencies 12, 5, 13, 11 so p99 13; the run ends at 131 s.
  // 44 x 0.0001771 / 131 x 86400 = $5.14/day. Next: one warm container for 121 s, p99 4, $15.30/day. Longer windows cost the same 121 s at p99 12.
  await openLogs(page, HAND_CFG)
  await pasteLog(page, LOG)
  await page.getByRole('button', { name: 'Run grid search' }).click()
  const opt = page.locator('#optimizer')
  await expect(opt.locator('.rec')).toContainText('min_containers=1, buffer_containers=0, scaledown_window=2 meets your 5.00 s p99 target: p99 13.0 s → 4.00 s, removes 100% of cold starts')
  await opt.getByText('Frontier as a table (2)').click()
  await expect(opt.locator('tbody tr').nth(0)).toContainText('min_containers=0, buffer_containers=0, scaledown_window=2$5.1413.0 s13.0 s75.0%')
  await expect(opt.locator('tbody tr').nth(1)).toContainText('$15.304.00 s4.00 s0.0%')
  await opt.locator('.rec').getByRole('button', { name: 'Apply' }).click()
  await settled(page)
  expect(await kpis(page)).toMatchObject({ p99: '4.00 s | target 5.00 s', 'total cost': '$0.021 | $15.30/day' })
  await expect(opt.locator('.rec')).toContainText('You are on it')
  await expect(page.locator('pre.code')).toContainText('min_containers=1,')
  await expect(page.locator('pre.code')).toContainText('scaledown_window=2,')
})

test('#2: work done back to back is not counted as idle', async ({ page }) => {
  // Paper example: 10 of the 97 billed seconds are work, so 87 / 97 = 89.69% is idle or booting.
  await openLogs(page, HAND_CFG)
  await pasteLog(page, LOG)
  await expect(page.locator('.diagnosis')).toContainText('90% of spend')
})

test('#3: a request that waits behind a booting container counts as a cold start', async ({ page }) => {
  // Boot 0-10, then 10-12 and 12-14. Both requests arrived (0 and 1 s) before the container that served them was ready.
  await openLogs(page, HAND_CFG)
  await pasteLog(page, 'timestamp,duration_s\n0,2\n1,2\n')
  expect((await kpis(page))['cold-start hits']).toBe('100% | 2 requests')
})

test('#9: the timeline covers a run that outlasts the last arrival', async ({ page }) => {
  // One request: boot 0-10, work 10-110. The run is 110 s, all of it with one container alive, and all of it must be drawn.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openLogs(page, HAND_CFG)
  await pasteLog(page, 'timestamp,duration_s\n0,100\n')
  const svg = page.getByRole('img', { name: /^Timeline over 1:50/ })
  await svg.focus()
  for (let i = 0; i < 130; i++) await svg.press('ArrowRight') // to the last bucket
  await expect(page.locator('.tip b').first()).toHaveText('t = 1:49')
  // The alive line stays at one container from the first bucket to the last.
  const d = await svg.locator('path[stroke="var(--viz-alive)"]').getAttribute('d')
  expect(new Set(d!.slice(1).split('L').map((p) => p.trim().split(/\s+/)[1]))).toEqual(new Set(['8.0']))
})
