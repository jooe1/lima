import type { Page } from '@playwright/test'

/**
 * Logs in using the dev login form (only available when NEXT_PUBLIC_DEV_LOGIN=true).
 * Resolves quietly if the dev form is not present (e.g. in production builds).
 */
export async function loginAsDev(
  page: Page,
  options?: { email?: string; companySlug?: string },
): Promise<void> {
  const email = options?.email ?? 'dev@example.com'
  const companySlug = options?.companySlug ?? 'dev'

  await page.goto('/login')

  // The dev form is only rendered when isDev is true.
  // Identify it via its unique submit button.
  const devButton = page.getByRole('button', { name: /dev sign in/i })
  const isVisible = await devButton.isVisible().catch(() => false)
  if (!isVisible) {
    return
  }

  // Target inputs scoped to the form that contains the dev submit button.
  const devForm = page.locator('form').filter({
    has: page.getByRole('button', { name: /dev sign in/i }),
  })

  // Fill email — the dev form's email input (placeholder "Email", type email)
  await devForm.locator('input[type="email"]').fill(email)

  // Fill company slug — placeholder "Company slug"
  await devForm.locator('input[placeholder="Company slug"]').fill(companySlug)

  await devButton.click()

  // Wait until navigation moves away from /login
  await page.waitForURL((url: URL) => !url.pathname.startsWith('/login'), {
    timeout: 15_000,
  })
}

/**
 * Waits until the current URL includes `pathname` and the network is idle.
 */
export async function waitForRouteReady(
  page: Page,
  pathname: string,
): Promise<void> {
  await page.waitForURL((url: URL) => url.pathname.includes(pathname), {
    timeout: 15_000,
  })
  await page.waitForLoadState('networkidle')
}
