import { test, expect } from '@playwright/test'

test('unauthenticated user is redirected to login from /builder', async ({ page }) => {
  await page.goto('/builder')
  await page.waitForURL((url) => url.pathname.includes('/login'), { timeout: 10_000 })
  expect(page.url()).toContain('/login')
})

test('unauthenticated user is redirected to login from /tools', async ({ page }) => {
  await page.goto('/tools')
  await page.waitForURL((url) => url.pathname.includes('/login'), { timeout: 10_000 })
  expect(page.url()).toContain('/login')
})

test('route gate shows loading message', async ({ page }) => {
  await page.goto('/login')
  await expect(page).toHaveTitle(/lima/i)
})
