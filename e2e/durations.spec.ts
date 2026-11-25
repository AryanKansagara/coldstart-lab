import { test, expect, openLogs, pasteLog, kpis, note, alert, HAND_CFG } from './fixtures.ts'

test.fail('#6: microsecond durations are read as microseconds', async ({ page }) => {
  // 2,000,000 us = 2 s, after the 10 s cold start.
  await openLogs(page, HAND_CFG)
  await pasteLog(page, 'timestamp,latency_us\n0,2000000\n')
  expect(await kpis(page)).toMatchObject({ p50: '12.0 s' })
})

test.fail('#6: nanosecond timestamps and durations are read as nanoseconds', async ({ page }) => {
  await openLogs(page, HAND_CFG)
  await pasteLog(page, 'ts,duration_ns\n1763000000000000000,2000000000\n1763000120000000000,1000000000\n')
  await expect(note(page)).toContainText('2 requests over 2:01')
  expect(await kpis(page)).toMatchObject({ p50: '11.0 s', p99: '12.0 s | target 5.00 s' })
})

test.fail('#6: decimal-comma durations are refused, not read as dates', async ({ page }) => {
  await openLogs(page, HAND_CFG)
  await pasteLog(page, 'ts;duration\n0;0,5\n1;1,5\n2;2,5\n')
  await expect(alert(page)).toContainText('Could not read any durations from column "duration"')
})

test.fail('#6: rows without a readable duration are counted on screen', async ({ page }) => {
  await openLogs(page, HAND_CFG)
  await pasteLog(page, 'ts,duration\n0,2\n1,\n2,2\n3,abc\n4,2\n')
  await expect(note(page)).toContainText('2 of 5 rows have no readable duration')
})
