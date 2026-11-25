import { test, expect, openLogs, pasteLog, kpis, note, alert, HAND_CFG } from './fixtures.ts'

for (const [name, text] of [
  ['status codes', 'status,latency\n200,100\n200,200\n500,200\n'],
  ['product names', 'name,price\nProduct 1,3\nProduct 2,4\n'],
  ['row ids', 'id,duration\n1001,2\n1002,3\n'],
] as const) {
  test.fail(`#5: ${name} are not read as timestamps`, async ({ page }) => {
    await openLogs(page, HAND_CFG)
    await pasteLog(page, text)
    await expect(alert(page)).toContainText(/time column/i)
  })
}

test.fail('#5: a duration column named execution_time is not used as the arrival time', async ({ page }) => {
  // Arrivals 0, 11, 100, 120: the paper example.
  await openLogs(page, HAND_CFG)
  await pasteLog(page, 'execution_time,event_time\n2,0\n4,11\n3,100\n1,120\n')
  await expect(note(page)).toContainText('4 requests over 2:01')
  expect(await kpis(page)).toMatchObject({ 'total cost': '$0.017 | $12.27/day' })
})
