import { test, expect, settled, kpis, copied } from './fixtures.ts'

test('landing page leads to the lab and the docs', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('cold start')
  await page.getByRole('link', { name: 'Open the lab' }).first().click()
  await expect(page.locator('.kpis')).toBeVisible()
  await page.goto('/docs')
  await expect(page.getByRole('heading', { name: 'Formats, model and sources' })).toBeVisible()
})

for (const [chip, id, n] of [
  ['Bursty app sessions', 'bursty', 6],
  ['Diurnal chat API, 24h', 'diurnal', 24],
  ['Steady transcription', 'poisson', 4],
  ['Launch-day spike', 'spike', 3],
] as const) {
  test(`sample: ${chip}`, async ({ page }) => {
    const spec = { bursty: 0.25, diurnal: 1.5, poisson: 0.4, spike: 2 }[id]
    await page.goto('/app')
    await page.getByRole('button', { name: chip }).click()
    await settled(page)
    const text = (await page.locator('.lab-top p').textContent())!
    const count = Number(/([\d,]+) requests/.exec(text)![1].replaceAll(',', ''))
    // Within 20% of rate x hours x 3600.
    expect(Math.abs(count / (spec * n * 3600) - 1)).toBeLessThan(0.2)
    const k = await kpis(page)
    expect(k.p50).toMatch(/\d (ms|s|min)/)
    expect(k['total cost']).toMatch(/^\$[\d.]+ \| \$[\d.]+\/day$/)
    const cold = Number(/\| ([\d,]+) requests/.exec(k['cold-start hits'])![1].replaceAll(',', ''))
    expect(cold).toBeGreaterThan(0)
    expect(cold).toBeLessThan(count)
    // Cost per 1k is the total spread over the requests (both are shown rounded to three digits or so).
    const usd = (s: string) => Number(/\$([\d.]+)/.exec(s)![1])
    expect(usd(k['per 1k requests']) / ((usd(k['total cost']) / count) * 1000)).toBeCloseTo(1, 1)
    await page.goto(`/app?sample=${id}`)
    await settled(page)
    await expect(page.locator('.lab-top p')).toContainText(`${count.toLocaleString('en-US')} requests`)
  })
}

test('the decorator follows the settings', async ({ page }) => {
  await page.goto('/app')
  await page.getByLabel('preset').selectOption('llm8b-h100')
  await page.getByLabel('min_containers').fill('2')
  await page.getByLabel('buffer_containers').fill('1')
  await page.getByRole('spinbutton', { name: 'scaledown_window' }).fill('300')
  await page.locator('.switch').click()
  await settled(page)
  await page.getByRole('button', { name: 'Copy', exact: true }).click()
  expect(await copied(page)).toBe(
    '@app.cls(\n    gpu="H100",\n    cpu=8,\n    memory=65536,\n    min_containers=2,\n    max_containers=20,\n    buffer_containers=1,\n    scaledown_window=300,\n    enable_memory_snapshot=True,\n    experimental_options={"enable_gpu_snapshot": True},\n)\n@modal.concurrent(max_inputs=32, target_inputs=24)\nclass Model:\n    ...',
  )
})

test('scenarios compare, apply and are removed', async ({ page }) => {
  await page.goto('/app')
  await page.getByRole('button', { name: 'Save scenario' }).click()
  await page.getByLabel('min_containers').fill('1')
  await settled(page)
  const row = page.locator('.compare tr', { hasText: 'Cost per day' })
  await expect(row.locator('td')).toHaveCount(2)
  const [now, saved] = await row.locator('td').allTextContents()
  expect(now).not.toBe(saved)
  await page.locator('.compare').getByRole('button', { name: 'Apply' }).click()
  await settled(page)
  await expect(page.getByLabel('min_containers')).toHaveValue('0')
  await page.getByRole('button', { name: /^Remove/ }).click()
  await expect(page.getByText('Save up to four configs')).toBeVisible()
})

test.fail('#13: no suggestion to go past max_containers', async ({ page }) => {
  await page.goto('/app')
  await page.getByLabel('max_containers').fill('1')
  await page.getByLabel('min_containers').fill('1')
  await settled(page)
  await expect(page.locator('.insights')).toBeVisible()
  await expect(page.locator('.insights')).not.toContainText('min_containers=2')
})
