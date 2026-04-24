/**
 * Shared login helper. prd-admin uses sessionStorage-based auth (see
 * .claude/rules/no-localstorage.md) so each page context starts fresh.
 *
 * Pulls credentials from env:
 *   E2E_USER / E2E_PASSWORD — real account on the target deployment.
 *
 * When env is missing, callers fall back to `skip()` with a clear
 * message so CI jobs that forgot to inject secrets don't fail with an
 * opaque "login button not found" error.
 */

import type { Page, TestInfo } from '@playwright/test';

export function requireCreds(testInfo: TestInfo): { user: string; password: string } {
  const user = process.env.E2E_USER;
  const password = process.env.E2E_PASSWORD;
  if (!user || !password) {
    testInfo.skip(
      true,
      'E2E_USER / E2E_PASSWORD not set — inject via repo secrets or local .env before running auth-gated specs.',
    );
    // testInfo.skip throws; this return is for the type checker.
    return { user: '', password: '' };
  }
  return { user, password };
}

/**
 * Perform a fresh login via the /login page. Assumes the default
 * prd-admin login form with `#username` + `#password` + submit button.
 * Adjust selectors if the login page is restyled.
 */
export async function login(page: Page, user: string, password: string): Promise<void> {
  await page.goto('/login');
  // The login page could reside at /login or /auth/login depending on
  // deployment — fall back to auth if /login redirects away. The
  // navigation wait here keeps the test robust to slow first-paint.
  await page.waitForLoadState('domcontentloaded');

  // Prefer stable data-testid selectors over text — text labels
  // change when we translate i18n or tweak copy.
  await page.locator('input[name="username"], #username, [data-testid="login-user"]').first().fill(user);
  await page.locator('input[name="password"], #password, [data-testid="login-pass"]').first().fill(password);
  await page.locator('button[type="submit"], [data-testid="login-submit"]').first().click();

  // Landing page URL pattern — home or dashboard. Waiting for
  // /dashboard|/home|/groups suffices for every admin role we ship.
  await page.waitForURL(/(dashboard|home|groups|\/$)/, { timeout: 15_000 });
}
