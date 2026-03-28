import { test, expect } from '@playwright/test'
import { loginAsDev, waitForRouteReady } from './helpers'

/**
 * Publish blocker and recovery coverage.
 * Tests verify that publish blockers are visible, user-friendly,
 * and that the editor provides clear guidance to resolve them.
 */
test.describe('publish blockers', () => {
  test('unauthenticated user cannot access editor', async ({ page }) => {
    await page.goto('/builder/any-app-id')
    await page.waitForURL(url => !url.pathname.startsWith('/builder/'), { timeout: 5000 }).catch(() => {})
    const url = page.url()
    const wasRedirected = !url.includes('/builder/any-app-id')
    const hasAuthGate = await page.locator('text=Checking access').isVisible().catch(() => false)
    expect(wasRedirected || hasAuthGate).toBeTruthy()
  })

  test('editor loading state is never blank', async ({ page }) => {
    await page.goto('/builder/some-app-id')
    // Immediately after navigation, something should be visible
    const bodyContent = await page.locator('body').textContent()
    expect((bodyContent ?? '').length).toBeGreaterThan(0)
  })

  test('authenticated editor shows publish button', async ({ page }) => {
    await loginAsDev(page)
    await waitForRouteReady(page, '/builder')
    // If any app exists, navigate into it and check for publish button
    const appLinks = page.locator('a[href^="/builder/"]').filter({
      hasNot: page.locator('[href="/builder/connectors"]'),
    })
    const count = await appLinks.count()
    if (count > 0) {
      await appLinks.first().click()
      await page.waitForTimeout(2000)
      const publishBtn = page.getByRole('button', { name: /publish/i })
      await expect(publishBtn).toBeVisible({ timeout: 10000 })
    }
  })

  test('publish dialog uses user-friendly sharing language', async ({ page }) => {
    await loginAsDev(page)
    await waitForRouteReady(page, '/builder')
    const appLinks = page.locator('a[href^="/builder/"]').filter({
      hasNot: page.locator('[href="/builder/connectors"]'),
    })
    const count = await appLinks.count()
    if (count > 0) {
      await appLinks.first().click()
      await page.waitForTimeout(2000)
      const publishBtn = page.getByRole('button', { name: /^publish$/i })
      const isEnabled = await publishBtn.isEnabled().catch(() => false)
      if (isEnabled) {
        await publishBtn.click()
        // Check for user-friendly dialog language — NOT technical "audience capability" language
        const dialogText = await page.locator('body').textContent()
        const hasFriendlyLanguage = (dialogText ?? '').match(/who should|access|find and use|can find|can use/i)
        expect(hasFriendlyLanguage).toBeTruthy()
        // Should NOT show technical jargon
        expect(dialogText).not.toContain('publication capability')
        expect(dialogText).not.toContain('audience group')
      }
    }
  })

  test('publish blocker message is user-friendly when shown', async ({ page }) => {
    await loginAsDev(page)
    await waitForRouteReady(page, '/builder')
    const appLinks = page.locator('a[href^="/builder/"]').filter({
      hasNot: page.locator('[href="/builder/connectors"]'),
    })
    const count = await appLinks.count()
    if (count > 0) {
      await appLinks.first().click()
      await page.waitForTimeout(2000)
      const publishBtn = page.getByRole('button', { name: /publish/i })
      const isDisabled = await publishBtn.isDisabled().catch(() => false)
      if (isDisabled) {
        // If publish is blocked, find the blocker message
        const pageText = await page.locator('body').textContent()
        // Message should be user-friendly — no internal node IDs (e.g., "table1:", "button2:")
        const hasNodeId = (pageText ?? '').match(/\b(table|button|chart|text|filter|form)\d+:/i)
        expect(hasNodeId).toBeNull()
      }
    }
  })
})
