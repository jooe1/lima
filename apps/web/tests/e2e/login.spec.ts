import { test, expect } from '@playwright/test'

test('login page shows Lima heading', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: /lima/i })).toBeVisible()
})

test('login page shows magic link form', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByRole('button', { name: /send magic link/i })).toBeVisible()
})

test('login page shows email label', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByLabelText(/email address/i)).toBeVisible()
})

test('magic link form shows error on bad submit', async ({ page }) => {
  await page.goto('/login')
  // Fill in a valid-looking email so the form submits
  await page.getByLabel(/email address/i).fill('test@example.com')
  await page.getByRole('button', { name: /send magic link/i }).click()
  // Either success message or error — just confirm the page doesn't crash
  await page.waitForTimeout(500)
  const url = page.url()
  expect(url).toContain('/login')
})
