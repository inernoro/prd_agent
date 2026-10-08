// 通过可见控件展开完整报告，不能靠读取隐藏 DOM 替代用户可读正文。
export async function expandCompleteReport(page) {
  let expanded = 0;
  for (const frame of page.frames()) {
    const button = frame.locator('[data-view-mode="full"]');
    if (await button.count() !== 1) continue;
    if (await frame.locator('body').getAttribute('data-view') !== 'brief') continue;
    if (!await button.isVisible()) continue;
    await button.click({ timeout: 5000 });
    if (await frame.locator('body').getAttribute('data-view') !== 'full') {
      throw new Error('报告完整版切换失败，无法核对完整正文');
    }
    expanded += 1;
  }
  return expanded;
}
