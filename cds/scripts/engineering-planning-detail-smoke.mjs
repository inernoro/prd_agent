import assert from 'node:assert/strict';
import path from 'node:path';
import { isEventStream, resolveFixture } from './fixtures/mobile-layout-fixtures.mjs';

const projectId = 'fixture-project';
const target = `/api/projects/${projectId}/planning`;
const actor = { kind: 'human', id: 'fixture-owner', label: '合成验收账号' };
const createdAt = '2026-11-20T01:00:00Z';
const historyNote = '已用合成负载复现查询超时';
const verificationNote = '合成压测中查询低于阈值';
const exemptionNote = '该合成项目没有定时任务';
const active = {
  id: 'debt-fixture-handoff', projectId, title: '合成债务交接', version: 2, status: 'in_progress', priority: 'mid',
  source: { type: 'test', ref: 'fixture-check' }, summary: '合成查询在高负载下超时', impact: '影响合成工作台打开速度',
  whyDebt: '先给合成工作台发布限流措施', rootCause: { state: 'suspected', text: '可能缺少索引' },
  createdAt, updatedAt: createdAt, criteria: [{ id: 'c1', text: '查询耗时低于阈值' }, { id: 'c2', text: '定时任务耗时达标' }],
  reopenCount: 0, hitCount: 0,
};
const progressEvent = { id: 'e-progress', projectId, entity: 'debt', entityId: active.id, type: 'progress', at: createdAt, actor, note: historyNote };
const brief = {
  readiness: { score: 4, max: 7, items: ['问题和影响写清楚', '来源可追溯', '记录欠债时的取舍', '有偿还标准']
    .map(label => ({ label, ok: true })).concat(['根因已确认', '记录期望方向', '近 30 天有再次遇到记录'].map(label => ({ label, ok: false }))) },
  sections: [
    { id: 'problem', title: '现在是什么问题', lines: [{ kind: 'fact', text: active.summary,
      cites: [{ kind: 'record', id: active.id, label: '债务上下文', target: 'context' }] }] },
    { id: 'attempts', title: '之前怎么处理过', lines: [{ kind: 'fact', text: `处理进展 · ${historyNote}`,
      cites: [{ kind: 'event', id: progressEvent.id, label: '2026-11-20 处理进展' }] }] },
    { id: 'why', title: '为什么留到现在', lines: [{ kind: 'fact', text: active.whyDebt,
      cites: [{ kind: 'record', id: active.id, label: '债务上下文', target: 'context' }] }] },
    { id: 'direction', title: '期望往哪个方向走', lines: [{ kind: 'gap', text: '尚未记录期望方向。', cites: [] }] },
  ],
  next: ['定位并确认根因，补充依据。'], gaps: ['根因已确认', '记录期望方向', '近 30 天有再次遇到记录'],
  markdown: `# ${active.id} ${active.title}\n\n- ${historyNote}（出处 ${progressEvent.id}）`,
};
const paid = {
  ...active, id: 'debt-fixture-verification', title: '合成债务逐项验收', version: 3, status: 'repaid',
  repayment: { at: createdAt, by: actor, summary: '已校验合成债务',
    results: [{ criterionId: 'c1', verdict: 'met', note: verificationNote }, { criterionId: 'c2', verdict: 'na', note: exemptionNote }],
    evidence: [{ type: 'test', label: '整笔偿还的合成测试记录', url: 'https://example.test/verification' }] },
};

const button = (root, name) => root.getByRole('button', { name, exact: true });
const dialog = (page, name) => page.getByRole('dialog', { name, exact: true });
const repayLabel = /^(核对偿还标准|标记已偿还)$/;

async function runWithDebtList(browser, base, mobile, run, initialDebt = active) {
  const status = { commands: 0 };
  const origin = new URL(base).origin;
  const viewport = mobile ? { width: 320, height: 800 } : { width: 1440, height: 940 };
  const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile,
    colorScheme: mobile ? 'dark' : 'light', reducedMotion: 'reduce' });
  try {
    if (!mobile) await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    await context.route('**/*', async route => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.origin !== origin) return route.abort();
      const pathname = url.pathname.replace(/^\/_cds/, '');
      if (!pathname.startsWith('/api/')) return route.continue();
      if (isEventStream(pathname) || pathname === '/api/activity-stream') {
        return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
      }
      if (pathname === '/api/auth/status') return route.fulfill({ json: { authenticated: true, enabled: true,
        mode: 'basic', user: { ...actor, name: actor.label, isSystemOwner: true } } });
      if (pathname === target) return route.fulfill({ json: { ...resolveFixture(target), permissions: ['read', 'write'] } });
      if (pathname === `${target}/debts`) return route.fulfill({ json: { projectId, today: '2026-11-20',
        items: [url.searchParams.get('view') === 'repaid' ? paid : initialDebt], nextCursor: null } });
      if (pathname === `${target}/debts/${initialDebt.id}`) return route.fulfill({ json: { projectId, debt: initialDebt, events: [progressEvent], brief } });
      if (pathname === `${target}/debts/${paid.id}`) return route.fulfill({ json: { projectId, debt: paid, events: [] } });
      if (pathname === `${target}/commands`) {
        status.commands++;
        return route.fulfill({ status: 500, json: { error: 'unexpected_fixture_write' } });
      }
      return route.fulfill({ json: resolveFixture(pathname) ?? {} });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(base + '/project-list');
    if (mobile) await button(page, '打开导航菜单').tap();
    await page.getByRole('link', { name: '工程规划', exact: true }).click();
    await page.getByRole('heading', { name: '待你确认', exact: true }).waitFor();
    const debtBranch = page.getByRole('button', { name: /^债务分支/ });
    if (mobile) await debtBranch.tap();
    else await debtBranch.click();
    await button(page, initialDebt.title).waitFor();
    const result = await run(page);
    assert.equal(status.commands, 0, '交接只读测试不应提交债务变更');
    return result;
  } finally {
    await context.close();
  }
}

async function receivesFocus(page, locator) {
  const element = await locator.elementHandle();
  try {
    await page.waitForFunction(target => document.activeElement === target, element, { timeout: 1000 });
    return true;
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error;
    return false;
  } finally {
    await element.dispose();
  }
}

async function criterionShowsOwnResult(drawer, index, verdict, note) {
  const title = paid.criteria[index].text;
  const otherTitle = paid.criteria[1 - index].text;
  return drawer.getByText(title).evaluateAll((labels, { otherTitle, verdict, note }) => labels.some(label => {
    if (!label.getClientRects().length) return false;
    for (let item = label; item && item.getAttribute('role') !== 'dialog'; item = item.parentElement) {
      const text = item.innerText;
      if (text.includes(otherTitle)) return false;
      if (text.includes(verdict) && text.includes(note)) return true;
    }
    return false;
  }), { otherTitle, verdict, note });
}

async function verifyLongMobileDebt(browser, base, out, check) {
  const longDebt = { ...active, title: '合成长标题用于验证债务抽屉'.repeat(10).slice(0, 120),
    owner: '合成长负责人名称保证来源可追溯'.repeat(10).slice(0, 120),
    source: { type: 'test', ref: '合成来源编号用于验证窄屏换行'.repeat(24).slice(0, 300) } };
  return runWithDebtList(browser, base, true, async page => {
    await page.setViewportSize({ width: 320, height: 700 });
    await button(page, longDebt.title).tap();
    const drawer = dialog(page, longDebt.title);
    const card = drawer.getByRole('heading', { name: '接手卡', exact: true });
    await card.waitFor({ state: 'attached' });
    const close = button(drawer, '关闭');
    const scroller = drawer.locator('.ep-dialog-content');
    const results = [];
    for (const height of [700, 568]) {
      await page.setViewportSize({ width: 320, height });
      const before = await close.boundingBox();
      const pane = await scroller.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return { y: bounds.y, height: bounds.height };
      });
      const usable = pane.height >= 120 && pane.y + 120 <= height;
      check(usable, `320×${height} 的合法长标题和元信息挤压了债务详情滚动区（${pane.height.toFixed(1)} CSS px）`);
      if (!usable) {
        await page.screenshot({ path: path.join(out, `failure-planning-debt-long-mobile-${height}.png`), animations: 'disabled' });
        results.push({ height, usable });
        continue;
      }
      await card.scrollIntoViewIfNeeded();
      const reachedCard = await card.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return bounds.top >= 0 && bounds.bottom <= innerHeight && element.closest('.ep-dialog-content').scrollTop > 0;
      });
      const after = await close.boundingBox();
      const closeStayed = Math.abs(after.y - before.y) <= 1 && after.y + after.height <= height;
      check(reachedCard && closeStayed, `320×${height} 长内容应可滚到接手卡，且关闭控制保留在原位`);
      await button(drawer, '更多操作').tap();
      const invalid = page.getByRole('menuitem', { name: '标记失效', exact: true });
      await invalid.click({ trial: true });
      await page.keyboard.press('Escape');
      await invalid.waitFor({ state: 'hidden' });
      results.push({ height, usable, reachedCard, closeStayed, moreReachable: true });
    }
    return results;
  }, longDebt);
}

export async function verifyEngineeringPlanningDetail(browser, base, out) {
  const failures = [];
  function check(condition, message) { if (!condition) failures.push(message); }
  const desktop = await runWithDebtList(browser, base, false, async page => {
    const opener = button(page, active.title);
    const drawer = dialog(page, active.title);
    await opener.focus();
    await page.keyboard.press('Enter');
    const repay = drawer.getByRole('button', { name: repayLabel });
    await repay.waitFor();
    const handoff = await drawer.getByRole('heading', { name: '接手卡', exact: true }).isVisible();
    check(handoff, '债务详情缺少接手卡');
    let copiedBrief = false;
    let historicCitation = false;
    if (handoff) {
      await button(drawer, '复制给智能体').click();
      await drawer.getByText('已复制接手卡', { exact: true }).waitFor();
      copiedBrief = await page.evaluate(() => navigator.clipboard.readText()) === brief.markdown;
      check(copiedBrief, '给智能体复制的接手内容与接口回执不一致');
      await drawer.getByRole('button', { name: /查看出处.*处理进展/ }).click();
      historicCitation = await drawer.getByText(historyNote, { exact: true }).evaluate(element => {
        const row = element.closest('li');
        const scroll = element.closest('.ep-dialog-content');
        const bounds = element.getBoundingClientRect();
        const viewport = scroll?.getBoundingClientRect();
        return Boolean(row?.contains(document.activeElement) && viewport && bounds.top >= viewport.top && bounds.bottom <= viewport.bottom);
      });
      check(historicCitation, '接手卡的处理进展出处没有定位并聚焦到同一条历史');
    }
    await repay.focus();
    await page.keyboard.press('Enter');
    const verification = page.getByRole('dialog', { name: repayLabel });
    await verification.waitFor();
    await verification.getByRole('combobox', { name: active.criteria[0].text }).selectOption('met');
    await verification.getByRole('combobox', { name: active.criteria[1].text }).selectOption('na');
    const missingReason = await verification.locator('input[name="note-c2"]').evaluate(input => input.required && input.validity.valueMissing);
    const metReasonOptional = await verification.locator('input[name="note-c1"]').evaluate(input => !input.required);
    check(missingReason && metReasonOptional, '偿还说明需只在对应标准选择不适用时必填');
    await page.keyboard.press('Escape');
    await verification.waitFor({ state: 'hidden' });
    await repay.waitFor();
    const returnedToAction = await receivesFocus(page, repay);
    check(returnedToAction, 'Esc 退出核验表单后焦点未回到核对操作');
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden' });
    const returnedToDebt = await receivesFocus(page, opener);
    check(returnedToDebt, 'Esc 退出债务详情后焦点未回到原债务行');

    await opener.click();
    await button(drawer, '记录进展').click();
    const progress = dialog(page, '记录进展');
    const field = progress.getByLabel('进展说明');
    await field.fill('合成草稿内容，误触外侧不得消失');
    await page.mouse.click(20, 80);
    const draftPreserved = await progress.isVisible() && await field.inputValue() === '合成草稿内容，误触外侧不得消失';
    check(draftPreserved, '单击遮罩丢弃了尚未保存的进展草稿');
    if (await progress.isVisible()) await button(progress, '取消').click();
    await progress.waitFor({ state: 'hidden' });
    await drawer.waitFor();
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden' });

    await opener.click();
    await button(drawer, '记录进展').click();
    await field.fill('合成草稿内容，用于浏览器后退测试');
    await page.goBack();
    await page.waitForURL(url => !url.searchParams.has('item'));
    const browserBackClearedEditor = await progress.waitFor({ state: 'hidden', timeout: 1200 }).then(() => true, error => {
      if (error.name !== 'TimeoutError') throw error;
      return false;
    });
    check(browserBackClearedEditor, '浏览器后退后仍保留上一笔债务的写入表单');
    if (!browserBackClearedEditor) await page.keyboard.press('Escape');
    await progress.waitFor({ state: 'hidden' });

    await page.getByRole('combobox', { name: '债务状态' }).selectOption('repaid');
    await button(page, paid.title).click();
    const paidDrawer = dialog(page, paid.title);
    await paidDrawer.getByText('整笔偿还的合成测试记录', { exact: true }).first().waitFor();
    const resultsVisible = await criterionShowsOwnResult(paidDrawer, 0, '达标', verificationNote)
      && await criterionShowsOwnResult(paidDrawer, 1, '不适用', exemptionNote);
    check(resultsVisible, '已偿债务缺少已存的逐项判定及核验说明');
    if (failures.length > 0) await page.screenshot({ path: path.join(out, 'failure-planning-debt-detail-desktop.png') });
    return { handoff, copiedBrief, historicCitation, returnedToAction, returnedToDebt, draftPreserved, browserBackClearedEditor, resultsVisible,
      notApplicableReasonRequired: missingReason && metReasonOptional };
  });

  const mobile = await runWithDebtList(browser, base, true, async page => {
    await button(page, active.title).tap();
    const drawer = dialog(page, active.title);
    const repay = drawer.getByRole('button', { name: repayLabel });
    await repay.waitFor();
    const primary = await repay.boundingBox();
    const closeButton = button(drawer, '关闭');
    const close = await closeButton.boundingBox();
    const closeGlyph = await closeButton.locator('svg').boundingBox();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    assert(await page.evaluate(() => navigator.maxTouchPoints > 0 && document.documentElement.scrollWidth <= 320));
    check(primary.width >= 44 && primary.height >= 44, `320px 暗色触控下，核验主操作热区仅 ${primary.width.toFixed(1)}×${primary.height.toFixed(1)} CSS px，需至少 44×44`);
    check(close.width >= 44 && close.height >= 44, `320px 暗色触控下，关闭热区仅 ${close.width.toFixed(1)}×${close.height.toFixed(1)} CSS px，需至少 44×44`);
    check(closeGlyph.width / close.width >= 0.55, '触控关闭图标与按钮的宽度占比小于 55%');
    const overflow = button(drawer, '更多操作');
    const destructive = page.getByText('标记失效', { exact: true });
    const destructiveHidden = await overflow.isVisible() && !await destructive.isVisible();
    if (destructiveHidden) await overflow.tap();
    const destructiveReachable = destructiveHidden && await destructive.isVisible();
    check(destructiveReachable, '低频失效操作未通过更多菜单收纳');
    if (destructiveReachable) await destructive.click({ trial: true });
    if (await destructive.isVisible()) {
      await page.keyboard.press('Escape');
      await destructive.waitFor({ state: 'hidden' });
    }
    const menuFocus = [];
    if (await overflow.isVisible()) for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await overflow.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('menuitem', { name: '暂缓', exact: true }).focus();
      await page.keyboard.press('Enter');
      const defer = dialog(page, '暂缓');
      await defer.waitFor();
      await page.keyboard.press('Escape');
      await defer.waitFor({ state: 'hidden' });
      const returned = await receivesFocus(page, overflow);
      check(returned, `${width}px 窄屏用键盘从更多操作进入暂缓，Esc 后焦点未返回更多操作`);
      menuFocus.push({ width, returned });
    }
    if (failures.length > 0) await page.screenshot({ path: path.join(out, 'failure-planning-debt-detail-dark320.png') });
    return { primary: [primary.width, primary.height], close: [close.width, close.height], closeGlyph: [closeGlyph.width, closeGlyph.height],
      destructiveHidden, destructiveReachable, menuFocus };
  });
  const longMobile = await verifyLongMobileDebt(browser, base, out, check);
  assert.equal(failures.length, 0, `工程规划债务详情对抗检查失败\n${failures.join('\n')}`);
  return { desktop, mobile, longMobile };
}
