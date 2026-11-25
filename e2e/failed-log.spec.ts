import { test, expect, openLogs, pasteLog, uploadLog, alert, kpis, HAND_CFG } from './fixtures.ts'

test('#7: no result is shown for a log that could not be read', async ({ page }) => {
  await openLogs(page, HAND_CFG)
  await pasteLog(page, 'timestamp,duration_s\n0,2\n')
  await uploadLog(page, 'bad.csv', 'timestamp,duration_s\nabc,2\n')
  await expect(alert(page)).toContainText('That trace could not be simulated.')
  await expect(page.locator('.kpis')).toHaveCount(0)
  await expect(page.locator('.note.mono')).toHaveCount(0)
  await expect(page.locator('pre.code')).toHaveCount(0)
  await expect(page.locator('.lab-top')).not.toContainText('requests')
})

test('a good log after a bad one clears the error', async ({ page }) => {
  await openLogs(page, HAND_CFG)
  await uploadLog(page, 'bad.csv', 'timestamp,duration_s\nabc,2\n')
  await expect(alert(page)).toBeVisible()
  await uploadLog(page, 'good.csv', 'timestamp,duration_s\n0,2\n')
  await expect(alert(page)).toHaveCount(0)
  expect(await kpis(page)).toMatchObject({ p50: '12.0 s' })
})
