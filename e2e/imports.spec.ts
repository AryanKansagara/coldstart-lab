import { test, expect, openLogs, pasteLog, uploadLog, settled, kpis, note, alert, HAND_CFG } from './fixtures.ts'

/** Same four requests as the paper example in hand-worked.spec.ts, in each documented layout. */
const SAME: [string, string, string][] = [
  ['CSV with a BOM and CRLF', 'a.csv', '﻿timestamp,duration_s\r\n0,2\r\n11,4\r\n100,3\r\n120,1\r\n'],
  ['TSV', 'a.tsv', 'ts\tlatency_ms\n0\t2000\n11\t4000\n100\t3000\n120\t1000\n'],
  ['semicolon CSV', 'b.csv', 'time;duration\n0;2\n11;4\n100;3\n120;1\n'],
  ['headerless CSV out of order', 'c.csv', '100,3\n0,2\n120,1\n11,4\n'],
  ['quoted CSV', 'd.csv', 'path,timestamp,duration\n"/a,b",0,2\n"/say ""x""",11,4\n/c,100,3\n/d,120,1\n'],
  ['ISO timestamps with offsets', 'e.csv', 'timestamp,duration\n2026-10-12T14:00:00Z,2\n2026-10-12 14:00:11 UTC,4\n2026-10-12T10:01:40.0000000-04:00,3\n2026-10-12T14:02:00.000Z,1\n'],
  ['JSONL in epoch milliseconds', 'f.jsonl', [[0, 2], [11, 4], [100, 3], [120, 1]].map(([t, d]) => JSON.stringify({ ts: 1760277600000 + t * 1000, duration: d })).join('\n')],
  ['completion-only log', 'g.csv', 'end_timestamp,duration\n52,2\n65,4\n153,3\n171,1\n'],
]

for (const [name, file, text] of SAME) {
  test(`${name} gives the paper result`, async ({ page }) => {
    await openLogs(page, HAND_CFG)
    await uploadLog(page, file, text)
    await expect(note(page)).toContainText('4 requests over 2:01')
    expect(await kpis(page)).toMatchObject({ p50: '5.00 s', p99: '13.0 s | target 5.00 s', 'cold-start hits': '50% | 2 requests', 'total cost': '$0.017 | $12.27/day' })
    if (file === 'g.csv') await expect(note(page)).toContainText('arrivals are end minus duration')
  })
}

test('token logs estimate service time and say so', async ({ page }) => {
  // 0.05 + 1000/10000 + 60/60 = 1.15 s, after the 10 s cold start.
  await openLogs(page, HAND_CFG)
  await pasteLog(page, 'timestamp,prompt_tokens,completion_tokens\n0,1000,60\n')
  await expect(note(page)).toContainText('service time estimated from "completion_tokens" and "prompt_tokens"')
  expect(await kpis(page)).toMatchObject({ p50: '11.2 s' })
})

test('a multi-function log keeps the busiest function and says so', async ({ page }) => {
  await openLogs(page, HAND_CFG)
  await pasteLog(page, 'timestamp,duration,function\n0,2,a\n5,50,b\n11,4,a\n100,3,a\n120,1,a\n')
  await expect(note(page)).toContainText('2 functions in this log: kept the busiest (4 of 5 rows)')
  expect(await kpis(page)).toMatchObject({ 'total cost': '$0.017 | $12.27/day' })
})

test('the real Azure trace loads all 19,366 requests', async ({ page }) => {
  await openLogs(page)
  await page.getByRole('button', { name: 'Real Azure LLM trace' }).click()
  await expect(note(page)).toContainText('19,366 requests', { timeout: 30_000 })
  await settled(page)
  await expect(page.locator('.lab-top')).toContainText('19,366 requests')
  await expect(note(page)).toContainText('estimated from "GeneratedTokens" and "ContextTokens"')
  const k = await kpis(page)
  expect(k['total cost']).toMatch(/^\$[1-9]/)
  expect(k['cold-start hits']).toMatch(/% \| [1-9][\d,]* requests/)
})

test('the synthetic example log loads', async ({ page }) => {
  await openLogs(page)
  await page.getByRole('button', { name: 'Synthetic example' }).click()
  await settled(page)
  await expect(note(page)).toContainText('read as milliseconds')
})

test('rows and lines that cannot be read are counted', async ({ page }) => {
  await openLogs(page, HAND_CFG)
  await pasteLog(page, 'timestamp,duration_s\n0,2\nnot a time,4\n')
  await expect(note(page)).toContainText('1 rows skipped')
  await pasteLog(page, '{"ts":0,"duration":2}\n{"ts":11,"dura')
  await expect(note(page)).toContainText('1 requests over')
  await expect(note(page)).toContainText('1 rows skipped')
})

const BAD: [string, string, RegExp][] = [
  ['prose', 'hello world\nthis is not a log', /Could not read any timestamps|No time column/],
  ['an HTML error page', '<!doctype html>\n<html><body>404 Not found</body></html>', /Could not read any timestamps|No time column/],
  ['a header with no rows', 'timestamp,duration\n', /No parseable rows/],
  ['unreadable timestamps', 'timestamp,latency_ms\nabc,5\ndef,6\n', /Could not read any timestamps/],
  ['JSON cut off in its only line', '{"ts":17602', /No parseable rows/],
]
for (const [name, text, msg] of BAD) {
  test(`${name} is refused with a reason`, async ({ page }) => {
    await openLogs(page, HAND_CFG)
    await uploadLog(page, 'bad.csv', text)
    await expect(alert(page)).toContainText('That trace could not be simulated.')
    await expect(alert(page)).toContainText(msg)
  })
}

test('an empty file says so and keeps the loaded log', async ({ page }) => {
  await openLogs(page, HAND_CFG)
  await uploadLog(page, 'a.csv', 'timestamp,duration_s\n0,2\n')
  await uploadLog(page, 'empty.csv', '  \n')
  await expect(alert(page)).toHaveText('That file looks empty.')
  await expect(page.locator('.drop b')).toHaveText('a.csv')
})

test('a failed Azure download says so', async ({ page }) => {
  await openLogs(page)
  await page.route('**/samples/*.csv', (r) => r.abort())
  await page.getByRole('button', { name: 'Real Azure LLM trace' }).click()
  await expect(alert(page)).toContainText('Could not download the Azure trace')
})

test.fail('#12: a last row cut off inside its timestamp does not stretch the window', async ({ page }) => {
  await openLogs(page, HAND_CFG)
  await pasteLog(page, 'timestamp,duration_s\n2026-10-12T14:00:00Z,2\n2026-10-12T14:00:05Z,2\n2026-10-12')
  await expect(note(page)).toContainText('2 requests over 1:00')
})
