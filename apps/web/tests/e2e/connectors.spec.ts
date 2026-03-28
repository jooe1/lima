import { test, expect } from '@playwright/test'

test('unauthenticated: /builder/connectors redirects to /login', async ({ page }) => {
  await page.goto('/builder/connectors')
  await page.waitForURL((url) => url.pathname.includes('/login'), { timeout: 10_000 })
  expect(page.url()).toContain('/login')
})

test('login page is reachable for connector setup flow', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: /lima/i })).toBeVisible()
})
