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

// 只有报告目标与当前 CDS_HOST 精确同主机时才允许注入访问凭据。
// 不按域名后缀放宽，避免密钥被带到外站或伪造子域。
export function isConfiguredCdsTargetHost(targetHost, configuredHost) {
  try {
    const expected = new URL(configuredHost).host.toLowerCase();
    return Boolean(expected) && String(targetHost || '').toLowerCase() === expected;
  } catch {
    return false;
  }
}
