import { test, expect } from '@playwright/test'

test('unauthenticated: /builder redirects to /login', async ({ page }) => {
  await page.goto('/builder')
  await page.waitForURL((url) => url.pathname.includes('/login'), { timeout: 10_000 })
  expect(page.url()).toContain('/login')
})

test('login page shows Lima heading (builder home auth check)', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: /lima/i })).toBeVisible()
})
