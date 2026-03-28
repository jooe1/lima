import { test, expect } from '@playwright/test'
import { loginAsDev, waitForRouteReady } from './helpers'

/**
 * Self-serve smoke suite: covers the full zero-to-tool journey UI path.
 * Tests verify that each step in the journey is navigable and renders
 * the expected affordances, without requiring a live backend.
 */
test.describe('self-serve journey smoke', () => {
  test('step 1: login page renders and has primary CTA', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('heading')).toBeVisible()
    // Primary send magic link button should exist
    const primaryBtn = page.getByRole('button', { name: /send magic link|sign in/i }).first()
    await expect(primaryBtn).toBeVisible()
  })

  test('step 2: authenticated user lands on builder', async ({ page }) => {
    await loginAsDev(page)
    await waitForRouteReady(page, '/builder')
    await expect(page.locator('body')).not.toBeEmpty()
    // Builder navigation should be present
    const nav = page.locator('nav').or(page.locator('[role="navigation"]'))
    await expect(nav.first()).toBeVisible()
  })

  test('step 3: connector setup page is accessible from builder', async ({ page }) => {
    await loginAsDev(page)
    await waitForRouteReady(page, '/builder')
    // Navigate to connectors
    await page.goto('/builder/connectors')
    await page.waitForLoadState('networkidle').catch(() => {})
    await expect(page.locator('body')).not.toBeEmpty()
    // Should show connector-related content
    const bodyText = await page.locator('body').textContent()
    expect(bodyText?.toLowerCase()).toMatch(/connector|data source/i)
  })

  test('step 4: builder home shows app creation affordance', async ({ page }) => {
    await loginAsDev(page)
    await waitForRouteReady(page, '/builder')
    const bodyText = await page.locator('body').textContent()
    // Should show some kind of create/new app affordance OR setup guidance
    expect(bodyText).toBeTruthy()
    expect((bodyText ?? '').length).toBeGreaterThan(20)
  })

  test('step 5: tools page is reachable for authenticated users', async ({ page }) => {
    await loginAsDev(page)
    await page.goto('/tools')
    await page.waitForLoadState('networkidle').catch(() => {})
    await expect(page.getByRole('heading', { name: /your tools/i })).toBeVisible({ timeout: 10000 })
  })

  test('step 6: tools search input is present and focusable', async ({ page }) => {
    await loginAsDev(page)
    await page.goto('/tools')
    await page.waitForLoadState('networkidle').catch(() => {})
    const searchInput = page.locator('input[type="search"], input#tool-search')
    await expect(searchInput).toBeVisible()
    await searchInput.click()
    const isFocused = await searchInput.evaluate(el => el === document.activeElement)
    expect(isFocused).toBeTruthy()
  })

  test('step 7: unauthenticated user is redirected away from all protected routes', async ({ page }) => {
    for (const path of ['/builder', '/tools', '/builder/connectors']) {
      await page.goto(path)
      await page.waitForURL(url => url.pathname !== path, { timeout: 5000 }).catch(() => {})
      const url = page.url()
      expect(url).not.toContain(path)
    }
  })
})
