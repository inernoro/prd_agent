import { expect } from '@playwright/test';

const onboardingHandlers = new WeakMap();
export async function installOnboardingHandler(page, onDismiss = () => {}) {
  const learned = page.getByRole('button', { name: '我已学会', exact: true });
  const handler = async () => {
    onDismiss(await learned.ariaSnapshot());
    await learned.click();
  };
  await page.addLocatorHandler(learned, handler);
  onboardingHandlers.set(page, { learned, handler });
}

export async function dismissOnboarding(page) {
  const installed = onboardingHandlers.get(page);
  const learned = installed?.learned ?? page.getByRole('button', { name: '我已学会', exact: true });
  if (await learned.isVisible()) {
    // An explicit click on the trigger would itself run the locator handler,
    // then wait forever for the now-dismissed button. Temporarily remove only
    // this handler; both paths still use the real UI and preserve other handlers.
    if (installed) await page.removeLocatorHandler(learned);
    try {
      if (installed) await installed.handler();
      else await learned.click();
      await expect(learned).not.toBeVisible();
    } finally {
      if (installed) await page.addLocatorHandler(learned, installed.handler);
    }
  }
}

export function classifyPageHttpErrors(requests) {
  const expected = row => row.status === 502 && row.stage === 'api-restart';
  return {
    expectedRestartErrors: requests.filter(expected),
    unexpectedHttpErrors: requests.filter(row => row.status >= 400 && !expected(row)),
  };
}

// A fading store card can still contain the same title as the document tree.
// Click the actual tree row, then require the product's persisted deep link.
// All waits concern visible state; no forced clicks, storage flags or sleeps.
export async function openFixtureDocument(page, { storeId, entryId }) {
  await dismissOnboarding(page);
  const card = page.locator(`[data-store-card="${storeId}"]`);
  await expect(card).toBeVisible();
  await card.getByRole('heading').click();
  await expect(page).toHaveURL(url => url.searchParams.get('store') === storeId);
  const row = page.locator(`button[data-entry-id="${entryId}"]`);
  await expect(row).toBeVisible();
  await row.click();
  await expect(page).toHaveURL(url => url.searchParams.get('store') === storeId
    && url.searchParams.get('entry') === entryId);
  await expect(page.getByText('MAP性能样例', { exact: true }).first()).toBeVisible();
  return { storeId, entryId, url: page.url() };
}
