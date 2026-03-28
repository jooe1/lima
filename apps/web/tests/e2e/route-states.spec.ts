import { test, expect } from '@playwright/test'
import { loginAsDev, waitForRouteReady } from './helpers'

test.describe('route states', () => {
  test('404 page shows friendly not-found message', async ({ page }) => {
    await page.goto('/this-path-does-not-exist-at-all-1234')
    // Next.js renders not-found.tsx for unknown routes
    await page.waitForLoadState('domcontentloaded')
    const body = await page.locator('body').textContent()
    expect(body).toBeTruthy()
    // Should show a user-friendly message, not a blank page
    const text = body ?? ''
    expect(text.length).toBeGreaterThan(10)
  })

  test('root page redirects or renders without crash', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle').catch(() => {})
    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
  })

  test('authenticated user sees tools page without crash', async ({ page }) => {
    await loginAsDev(page)
    await waitForRouteReady(page, '/tools')
    await expect(page.locator('h1')).toBeVisible()
  })

  test('runtime loading state shows for unknown app', async ({ page }) => {
    await loginAsDev(page)
    await page.goto('/app/does-not-exist?workspace=does-not-exist')
    await page.waitForTimeout(2000)
    // Should show some feedback, not blank
    const body = await page.locator('body').textContent()
    expect((body ?? '').length).toBeGreaterThan(10)
  })
})
