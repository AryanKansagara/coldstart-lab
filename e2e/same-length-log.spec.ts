import { test, expect, openLogs, pasteLog, kpis, settled, HAND_CFG } from './fixtures.ts'

// 30 requests 100 s apart. Only the last duration differs, so the two logs have the same name, length and first 200 characters.
const log = (last: number) => `timestamp,duration_s\n${Array.from({ length: 30 }, (_, i) => `${1000 + i * 100},2\n`).join('')}4000,${last}\n`

test.fail('#4: a second pasted log of the same length replaces the first', async ({ page }) => {
  // Every request finds the container gone (idle 60 s), so latency is 10 + duration. 31 requests: p99 is the slowest.
  await openLogs(page, HAND_CFG)
  await pasteLog(page, log(2))
  expect(await kpis(page)).toMatchObject({ p99: '12.0 s | target 5.00 s' })
  await pasteLog(page, log(9))
  expect(await kpis(page)).toMatchObject({ p99: '19.0 s | target 5.00 s' })
})

test.fail('#4: the optimizer result is marked stale after a same-length log replaces the one it searched', async ({ page }) => {
  await openLogs(page, HAND_CFG)
  await pasteLog(page, log(2))
  await page.getByRole('button', { name: 'Run grid search' }).click()
  await expect(page.locator('#optimizer .rec')).toBeVisible({ timeout: 30_000 })
  await pasteLog(page, log(9))
  await settled(page)
  await expect(page.locator('#optimizer')).toContainText('Re-run it to refresh the frontier.')
})
