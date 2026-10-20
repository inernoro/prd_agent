export async function enterVisualFromHome(page, { touch = false, timeout = 30_000 } = {}) {
  if (new URL(page.url()).pathname !== '/') throw new Error('视觉入口验收必须从真实首页开始');
  const label = touch ? '生图' : '视觉创作智能体';
  // 手机首页的用量统计也叫“生图”，只有应用按钮才是业务入口。
  const entry = (touch ? page.getByRole('button', { name: label, exact: true }) : page.getByText(label, { exact: true })).and(page.locator(':visible'));
  await entry.first().waitFor({ state: 'visible', timeout });
  if (await entry.count() !== 1) throw new Error(`首页 ${label} 入口必须唯一且可见`);
  if (touch) await entry.tap(); else await entry.click();
  await page.waitForURL(url => url.pathname === '/visual-agent', { timeout: 30_000 });
  return { label, path: new URL(page.url()).pathname, realClick: true, touch };
}

export async function openOwnVisualWorkspace(page, workspaceId, { touch = false } = {}) {
  if (!/^[a-f0-9]{32}$/i.test(workspaceId)) throw new Error('本轮工作区标识无效');
  const card = page.locator(`[data-ws-card="1"][data-ws-id="${workspaceId}"]`);
  await card.waitFor({ state: 'visible', timeout: 30_000 });
  if (touch) await card.tap(); else await card.click();
  await page.waitForURL(url => url.pathname === `/visual-agent/${workspaceId}`, { timeout: 30_000 });
}
