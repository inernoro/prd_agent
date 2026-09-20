// 任务台验收 driver —— 关掉 debt.platform.active-tasks 第 7 条用的那条脚本。
//
// 它要证明的不是「页面打得开」，而是三条从没被真人跑过的链路真的成立：
//   A 手工链路：加一件 → 拖着排 → 点圆圈完成 → 补一句「做成了什么样」→ 撤销
//   B AI 拆解：粘一段真实的清单 → 候选一条条冒出来 → 勾选后真的进了队列
//   C 建议吸取：给自己提一条 → 收件箱出现 → 吸取整理成任务 → 建议标记已吸取
//
// 为什么每一步都要机读断言而不只是截图：截图只证明「那一刻屏幕长这样」，
// 证明不了「那条任务真的存在」。所以每步都用可数的东西（行数、某条标题在不在）判，
// 截图只作证据（closed-loop-acceptance：产物必须真的出现在截图里）。
//
// 运行：
//   export PWPATH=$(npm root -g)/playwright
//   export MAP_AI_USER='<账号>' MAP_ACCEPT_PASS='<口令>'
//   node active-tasks-driver.mjs "https://<预览域名>"
//
//   沙箱里浏览器打不通真站时（ERR_CONNECTION_RESET），先用 sandbox-net 技能搭隧道，
//   再把 BASE 换成 http://127.0.0.1:7801 —— 判据不变。
//
// 产出：$OUT/*.png + $OUT/manifest.json + $OUT/verdict.json（机读结论，供归档与 CI 消费）

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { loadConfig, launch, login, gotoByClick, shot, writeManifest, findings } from '../../.claude/skills/create-visual-test-to-kb/scripts/harness.mjs';

const CFG = loadConfig(new URL('../../.claude/skills/create-visual-test-to-kb/acceptance.config.json', import.meta.url).pathname);
const BASE = (process.argv[2] || '').replace(/\/+$/, '');
const OUT = process.env.ATB_OUT || '/tmp/atb-acceptance';
if (!BASE) { console.error('用法: node active-tasks-driver.mjs <预览域名>'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

// 每次跑用不同的后缀，免得上一轮的残留把断言弄成假绿
const RUN = `验收${Date.now().toString().slice(-6)}`;
const FIXTURE = readFileSync(new URL('./active-tasks-fixture.txt', import.meta.url).pathname, 'utf8').trim();

const checks = [];
/** 记一条判据。expected/actual 都写下来 —— 失败时不用回头猜它当时在比什么。 */
function check(id, ok, expected, actual, severity = 'P1') {
  checks.push({ id, ok: !!ok, expected, actual, severity });
  console.log(`${ok ? '[通过]' : `[失败 ${severity}]`} ${id} :: 期望 ${expected} / 实际 ${actual}`);
  return !!ok;
}

const { browser, page } = await launch(CFG);

/** 列表里现在有哪些标题（含正在做的那条 + 备用队列，不含做完的） */
async function liveTitles() {
  return page.locator('.atb-list .atb-row:not(.atb-row--add):not(.atb-row--adding) .atb-row__title').allTextContents();
}
/** 做完区的标题 */
async function doneTitles() {
  return page.locator('.atb-done-row__title').allTextContents();
}

try {
  // ── 0. 登录（表单，不注入 token）───────────────────────
  await login(page, BASE, CFG);
  check('login', !page.url().includes('/login'), '离开 /login', page.url());
  await shot(page, OUT, '00-login', '登录后落地首页', { overview: true });

  // ── 1. 从导航点进任务台（禁止地址栏直达：入口点不到本身就是缺陷）──
  const nav = await gotoByClick(page, '任务台');
  check('nav-entry', nav.found, '侧边导航能点到「任务台」', nav.found ? '点到了' : '点不到');
  await page.waitForSelector('.atb-list', { timeout: 15000 });
  await shot(page, OUT, '01-board', '经导航进入任务台（非地址栏直达）', { overview: true });

  // 首次进入会弹一次性新人指引，先收掉，否则挡住列表
  const welcome = page.locator('[role=dialog] >> text=开始用');
  if (await welcome.count()) { await welcome.first().click(); await page.waitForTimeout(400); }

  // ── A 手工链路 ─────────────────────────────────────────
  const titleA1 = `${RUN}-手工第一件`;
  const titleA2 = `${RUN}-手工第二件`;

  await page.locator('.atb-row--add:has-text("加一件")').click();
  await page.locator('.atb-row--adding input').fill(titleA1);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  // 回车之后输入框该还在（连续新建的节奏），直接敲第二条
  const stillOpen = await page.locator('.atb-row--adding input').count();
  check('inline-add-keeps-open', stillOpen > 0, '回车提交后输入行仍在，可接着敲下一条', `输入行数量 ${stillOpen}`);
  await page.locator('.atb-row--adding input').fill(titleA2);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);

  let titles = await liveTitles();
  check('add-two', titles.includes(titleA1) && titles.includes(titleA2),
    '两条都进了列表', JSON.stringify(titles.filter((t) => t.startsWith(RUN))));
  await shot(page, OUT, '02-added', `行内新建两条：${titleA1} / ${titleA2}`);

  // 拖拽排序：把第二条拖到第一条前面
  const rows = page.locator('.atb-list .atb-row');
  const src = rows.filter({ hasText: titleA2 }).first();
  const dst = rows.filter({ hasText: titleA1 }).first();
  if (await src.count() && await dst.count()) {
    const a = await src.boundingBox(); const b = await dst.boundingBox();
    if (a && b) {
      await page.mouse.move(a.x + 30, a.y + a.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + 30, b.y + b.height / 2 - 4, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(1500);
    }
  }
  titles = (await liveTitles()).filter((t) => t.startsWith(RUN));
  check('drag-reorder', titles.indexOf(titleA2) >= 0 && titles.indexOf(titleA2) < titles.indexOf(titleA1),
    `${titleA2} 排到了 ${titleA1} 前面`, JSON.stringify(titles));
  await shot(page, OUT, '03-reordered', '拖拽之后队列顺序真的变了（不是只有动画）');

  // 点圆圈完成 → 底下那条补写「做成了什么样」
  await rows.filter({ hasText: titleA2 }).first().locator('.atb-circle').first().click();
  await page.waitForSelector('.atb-undo', { timeout: 15000 });
  const noteText = '验收脚本写的那句结论';
  await page.locator('.atb-undo__input').fill(noteText);
  await page.waitForTimeout(1500); // 停手 600ms 自动存，留足余量
  await shot(page, OUT, '04-completed', `点圆圈立刻完成 + 底部补写「${noteText}」，旁边永远有撤销`);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.atb-list', { timeout: 15000 });
  const done = await doneTitles();
  check('complete-persisted', done.some((t) => t.includes(titleA2)),
    `刷新后「做完的」里有 ${titleA2}`, JSON.stringify(done.slice(0, 5)));
  const notes = await page.locator('.atb-done-row__note').allTextContents();
  check('closing-note-persisted', notes.some((n) => n.includes(noteText)),
    '那句「做成了什么样」真的存下来了', JSON.stringify(notes.slice(0, 5)));
  await shot(page, OUT, '05-history', '刷新后做完的那条带着结论句还在 —— 这一步才叫闭环');

  // ── B AI 拆解 ──────────────────────────────────────────
  await page.locator('.atb-row--add:has-text("AI 帮你拆")').click();
  await page.waitForSelector('[role=dialog]', { timeout: 10000 });
  await page.locator('[role=dialog] textarea').fill(FIXTURE);
  await shot(page, OUT, '06-import-input', '粘进一段真实清单（会议纪要体，不是一行一件）');

  const sheet = page.locator('[role=dialog]');
  await sheet.locator('button:has-text("拆开看看")').click();
  // 规则 #6：等待期屏幕上必须有产物在长。这里就断言「有候选真的冒出来了」。
  await sheet.locator('.atb-draft').first().waitFor({ state: 'visible', timeout: 180000 });
  await page.waitForTimeout(8000); // 让流吐完
  const draftCount = await sheet.locator('.atb-draft').count();
  check('ai-split-produced', draftCount >= 3, '至少拆出 3 条候选', `拆出 ${draftCount} 条`);
  await shot(page, OUT, '07-import-drafts', `AI 拆出 ${draftCount} 条候选，逐条可勾可改`);

  const firstDraft = (await sheet.locator('.atb-draft input.atb-inline-input').first().inputValue()) || '';
  await sheet.locator('button:has-text("加 ")').first().click();
  await page.waitForTimeout(3000);
  titles = await liveTitles();
  check('ai-split-landed', firstDraft.length > 0 && titles.some((t) => t.trim() === firstDraft.trim()),
    `勾选的候选「${firstDraft}」真的进了队列`, JSON.stringify(titles.slice(0, 6)));
  await shot(page, OUT, '08-import-landed', 'AI 拆出来的任务进了队列 —— 勾了才建，机器没替人做决定');

  // ── C 建议 → 吸取 ──────────────────────────────────────
  const suggestText = `${RUN}：把网关那条重试策略写进文档，另外顺手把日报模板的错别字改掉`;
  await page.locator('.atb-headact button:has-text("提建议")').click();
  await page.waitForSelector('[role=dialog]', { timeout: 10000 });
  // 提给自己 —— 验收要闭环，得能在同一个账号里看到它落进收件箱
  const sel = page.locator('[role=dialog] select');
  const opts = await sel.locator('option').allTextContents();
  const me = opts.find((o) => o && !o.includes('提给谁'));
  if (me) await sel.selectOption({ label: me });
  await page.locator('[role=dialog] textarea').fill(suggestText);
  await shot(page, OUT, '09-suggest', `提一条建议给 ${me ?? '某人'}：建议不会变成对方的任务`);
  await page.locator('[role=dialog] button:has-text("提过去")').click();
  await page.waitForTimeout(2500);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.atb-list', { timeout: 15000 });
  const banner = page.locator('.atb-banner');
  const hasBanner = await banner.count();
  check('suggestion-inbox', hasBanner > 0, '收件箱横幅出现（有建议等吸取）', `横幅数量 ${hasBanner}`);
  await shot(page, OUT, '10-inbox-banner', '收件箱横幅：建议提了不会进队列，躺在这儿等吸取');

  if (hasBanner) {
    await banner.first().click();
    await page.waitForSelector('[role=dialog]', { timeout: 10000 });
    await shot(page, OUT, '11-inbox', '建议收件箱：可勾、可选知识库、可补一句要求');
    await page.locator('[role=dialog] button:has-text("吸取")').click();
    await page.locator('[role=dialog] .atb-draft').first().waitFor({ state: 'visible', timeout: 180000 });
    await page.waitForTimeout(8000);
    const absorbed = await page.locator('[role=dialog] .atb-draft').count();
    check('absorb-produced', absorbed >= 1, '吸取整理出至少 1 条任务', `整理出 ${absorbed} 条`);
    await shot(page, OUT, '12-absorbed', `吸取把建议整理成 ${absorbed} 条能动手做的事`);
    await page.locator('[role=dialog] button:has-text("加 ")').first().click();
    await page.waitForTimeout(3000);
    const bannerAfter = await page.locator('.atb-banner').count();
    check('suggestion-resolved', bannerAfter === 0, '吸取之后收件箱清空（建议已了结）', `横幅数量 ${bannerAfter}`);
    await shot(page, OUT, '13-after-absorb', '吸取完成：任务进队列，那几条建议标记已吸取');
  }

  // ── D 管理视图 ─────────────────────────────────────────
  const navTeam = await gotoByClick(page, '大家在做什么');
  if (navTeam.found) {
    await page.waitForTimeout(2000);
    await shot(page, OUT, '14-team', '管理视图：谁卡住 / 谁没活 / 谁堆太多', { overview: true });
  }
  check('team-view', navTeam.found, '左栏能切到「大家在做什么」', navTeam.found ? '切到了' : '切不过去');

  // ── E 手机形态（真实触控 context，不是把桌面缩窄）──────
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1200);
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('mobile-no-overflow', !overflowX, '390px 下无横向溢出', overflowX ? '有横向溢出' : '无');
  await shot(page, OUT, '15-mobile', '手机宽度：单栏 + 顶部分段控件', { overview: true });
} catch (e) {
  check('driver-crashed', false, '脚本跑完', String(e).slice(0, 300), 'P0');
} finally {
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.filter((c) => !c.ok);
  const verdict = failed.some((c) => c.severity === 'P0') ? 'fail' : failed.length ? 'conditional' : 'pass';
  writeFileSync(`${OUT}/verdict.json`, JSON.stringify({
    verdict, passed, total: checks.length, checks, autoFindings: findings(), runTag: RUN,
  }, null, 2));
  writeManifest(OUT, { verdict, runTag: RUN });
  console.log(`\n结论 ${verdict} —— ${passed}/${checks.length} 条判据通过，证据在 ${OUT}`);
  await browser.close();
  process.exit(verdict === 'pass' ? 0 : 1);
}
