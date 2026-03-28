import { test, expect } from '@playwright/test'
import { loginAsDev, waitForRouteReady } from './helpers'

test('login page renders', async ({ page }) => {
  await page.goto('/login')

  const hasLimaHeading = await page
    .getByRole('heading', { name: /lima/i })
    .isVisible()
    .catch(() => false)

  const hasEmailInput = await page
    .locator('input[type="email"]')
    .first()
    .isVisible()
    .catch(() => false)

  expect(hasLimaHeading || hasEmailInput).toBe(true)
})

test('dev login redirects to builder', async ({ page }) => {
  await loginAsDev(page)
  await waitForRouteReady(page, '/builder')
  expect(page.url()).toContain('/builder')
})
