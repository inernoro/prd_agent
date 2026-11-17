import { expect } from '@playwright/test';

const onboardingHandlers = new WeakMap();
export async function installOnboardingHandler(page, onDismiss = () => {}) {
  const learned = page.getByRole('button', { name: '我已学会', exact: true });
  const state = { tipsLoaded: false, tips: [], tipsError: null, dismissedRoutes: new Set() };
  page.on('response', async response => {
    if (new URL(response.url()).pathname !== '/api/daily-tips/visible' || response.request().method() !== 'GET') return;
    try {
      if (response.status() !== 200) throw new Error(`教程读取HTTP ${response.status()}`);
      const body = await response.json();
      if (!Array.isArray(body.data?.items)) throw new Error('教程响应缺少items');
      state.tips = body.data.items;
    } catch (error) { state.tipsError = error.message; }
    finally { state.tipsLoaded = true; }
  });
  const handler = async () => {
    const route = new URL(page.url()).pathname;
    onDismiss(await learned.ariaSnapshot());
    await learned.click();
    await expect(learned).not.toBeVisible();
    state.dismissedRoutes.add(route);
  };
  await page.addLocatorHandler(learned, handler);
  Object.assign(state, { learned, handler });
  onboardingHandlers.set(page, state);
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

// Content can become visible before the real page guide has mounted. A hover
// may pass through the guide's spotlight hole, so it is not a readiness barrier.
// Observe authentic bootstrap data, then complete the expected guide through UI.
export async function settleKnowledgeOnboarding(page) {
  const installed = onboardingHandlers.get(page);
  if (!installed) throw new Error('必须在登录前安装教程处理器');
  await expect.poll(() => installed.tipsLoaded, { timeout: 10000, message: '等待真实教程载入' }).toBe(true);
  if (installed.tipsError) throw new Error(installed.tipsError);
  const route = new URL(page.url()).pathname;
  const expected = installed.tips.some(tip => typeof tip.sourceId === 'string'
    && tip.sourceId.endsWith('-page-guide') && !tip.learned
    && typeof tip.actionUrl === 'string' && new URL(tip.actionUrl, page.url()).pathname === route);
  if (expected && !installed.dismissedRoutes.has(route)) {
    // Our own auto handler must not consume the button while this explicit
    // semantic wait/click is in progress. Other handlers remain installed.
    await page.removeLocatorHandler(installed.learned);
    try {
      await installed.learned.waitFor({ state: 'visible' });
      await installed.handler();
    } finally { await page.addLocatorHandler(installed.learned, installed.handler); }
  }
  await expect(page.locator('[aria-label="关闭高亮引导"]')).toHaveCount(0);
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
