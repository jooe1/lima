import { test, expect } from '@playwright/test'
import { loginAsDev, waitForRouteReady } from './helpers'

test.describe('runtime launch', () => {
  test('tools page loads for authenticated user', async ({ page }) => {
    await loginAsDev(page)
    await waitForRouteReady(page, '/tools')
    await expect(page.locator('h1')).toContainText('Your Tools')
  })

  test('tools page has search input', async ({ page }) => {
    await loginAsDev(page)
    await waitForRouteReady(page, '/tools')
    const searchInput = page.getByRole('searchbox').or(page.locator('input[type="search"]'))
    await expect(searchInput).toBeVisible()
  })

  test('unauthenticated user is redirected from tools', async ({ page }) => {
    await page.goto('/tools')
    await page.waitForURL(url => url.pathname !== '/tools', { timeout: 5000 }).catch(() => {})
    const url = page.url()
    expect(url).not.toContain('/tools')
  })

  test('runtime shows friendly message for invalid app', async ({ page }) => {
    await loginAsDev(page)
    await page.goto('/app/nonexistent-app-id?workspace=nonexistent-workspace')
    await page.waitForTimeout(3000)
    // Should show a friendly blocked state, not a blank page or raw error
    const body = page.locator('body')
    const text = await body.textContent()
    expect(text).toBeTruthy()
    // Should NOT show raw technical messages
    expect(text).not.toContain('undefined')
    expect(text).not.toContain('null')
  })
})
