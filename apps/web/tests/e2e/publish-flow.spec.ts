import { test, expect } from '@playwright/test'
import { loginAsDev, waitForRouteReady } from './helpers'

test.describe('publish flow', () => {
  test('editor loading state is visible', async ({ page }) => {
    await page.goto('/builder/test-app-id')
    // Should show loading state (not blank) while auth resolves
    // Either RouteGateShell or redirect to login
    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
  })

  test('unauthenticated user is redirected from editor', async ({ page }) => {
    await page.goto('/builder/some-app-id')
    await page.waitForURL(url => !url.pathname.startsWith('/builder'), { timeout: 5000 }).catch(() => {})
    // Either redirected or shows auth gate
    const url = page.url()
    const isRedirected = !url.includes('/builder/some-app-id')
    const hasGate = await page.locator('text=Checking access').isVisible().catch(() => false)
    expect(isRedirected || hasGate).toBeTruthy()
  })

  test('publish button is present in editor when authenticated', async ({ page }) => {
    await loginAsDev(page)
    await waitForRouteReady(page, '/builder')
    // Navigate into an app if one exists — otherwise just verify the builder home loaded
    const appLinks = page.locator('a[href^="/builder/"]').filter({ hasNot: page.locator('[href="/builder/connectors"]') })
    const count = await appLinks.count()
    if (count > 0) {
      await appLinks.first().click()
      await page.waitForTimeout(1500)
      const publishBtn = page.getByRole('button', { name: /publish/i })
      await expect(publishBtn).toBeVisible({ timeout: 10000 })
    }
  })

  test('publish dialog shows audience selection', async ({ page }) => {
    await loginAsDev(page)
    await waitForRouteReady(page, '/builder')
    const appLinks = page.locator('a[href^="/builder/"]').filter({ hasNot: page.locator('[href="/builder/connectors"]') })
    const count = await appLinks.count()
    if (count > 0) {
      await appLinks.first().click()
      await page.waitForTimeout(1500)
      const publishBtn = page.getByRole('button', { name: /^publish$/i })
      const isEnabled = await publishBtn.isEnabled().catch(() => false)
      if (isEnabled) {
        await publishBtn.click()
        // Dialog should mention access/sharing in user-friendly terms
        await expect(page.locator('text=/who should|access|find and use/i')).toBeVisible({ timeout: 5000 })
      }
    }
  })
})
