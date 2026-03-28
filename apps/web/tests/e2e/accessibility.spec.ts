import { test, expect } from '@playwright/test'
import { loginAsDev, waitForRouteReady } from './helpers'

test.describe('accessibility', () => {
  test('login page has visible heading', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('heading')).toBeVisible()
  })

  test('login form inputs have associated labels', async ({ page }) => {
    await page.goto('/login')
    // Labeled inputs should be findable by label text
    const emailByLabel = page.getByLabel(/email/i)
    await expect(emailByLabel.first()).toBeVisible()
  })

  test('login page is keyboard-navigable to submit button', async ({ page }) => {
    await page.goto('/login')
    // Tab to the first email input
    await page.keyboard.press('Tab')
    const focused = await page.evaluate(() => document.activeElement?.tagName)
    // After one tab, focus should be on an interactive element
    expect(['INPUT', 'BUTTON', 'A']).toContain(focused)
  })

  test('tools page has main landmark', async ({ page }) => {
    await loginAsDev(page)
    await waitForRouteReady(page, '/tools')
    const main = page.locator('main')
    await expect(main).toBeVisible()
  })

  test('builder layout has main content area', async ({ page }) => {
    await loginAsDev(page)
    await waitForRouteReady(page, '/builder')
    const main = page.locator('main')
    await expect(main).toBeVisible()
  })

  test('tools page renders correctly at 768px viewport', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 })
    await loginAsDev(page)
    await waitForRouteReady(page, '/tools')
    // Page should render without horizontal scroll overflow
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth)
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 10) // allow 10px tolerance
  })

  test('login page renders correctly at 768px viewport', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 })
    await page.goto('/login')
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth)
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 10)
  })
})
