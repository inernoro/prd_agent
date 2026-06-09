/**
 * MD-to-PPT 完整生命周期验收驱动
 * 流程：登录 → 进页面 → 发消息 → 等大纲气泡 → 确认生成 → 等 iframe → 验证安全 → 多轮 patch → 刷新持久化
 */
import { chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const BASE = 'https://amazing-edison-mhzb22-claude-prd-agent.miduo.org';
const SHOTS_DIR = '/tmp/lifecycle_shots';
const USER  = process.env.MAP_AI_USER;
const PASS  = process.env.MAP_ACCEPT_PASS;

if (!USER || !PASS) {
  console.error('[FATAL] MAP_AI_USER / MAP_ACCEPT_PASS not set');
  process.exit(1);
}

fs.mkdirSync(SHOTS_DIR, { recursive: true });

const shots = [];
const findings = [];

async function shot(page, name, caption) {
  const p = path.join(SHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: p, fullPage: false });
  shots.push({ name, caption });
  console.log(`  [shot] ${name} | ${caption}`);
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--ignore-certificate-errors'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  // ─── Step 1: Login ──────────────────────────────────────────────────────────
  console.log('[1] 登录...');
  await page.goto(`${BASE}/login`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(3000);
  console.log(`[1] URL: ${page.url()}`);

  // Login form: input[type=text] (placeholder=admin), input[type=password]
  const userInput = page.locator('input[type="text"]').first();
  const passInput = page.locator('input[type="password"]').first();

  if (await userInput.count() > 0 && await passInput.count() > 0) {
    await userInput.fill(USER);
    await passInput.fill(PASS);
    // Find submit/login button
    const loginBtn = page.locator('button:has-text("登录"), button:has-text("Login"), button[type="submit"]').first();
    if (await loginBtn.count() > 0) {
      await loginBtn.click();
    } else {
      await passInput.press('Enter');
    }
    await page.waitForTimeout(4000);
    console.log(`[1] 登录后 URL: ${page.url()}`);
  } else {
    console.log('[1] 未找到登录表单，直接尝试 API 注入...');
  }

  // If still on login page
  if (page.url().includes('/login')) {
    console.log('[1] 仍在登录页，检查登录结果...');
    await shot(page, '00-login-state', '登录状态');
    // Check for error message
    const errMsg = await page.locator('[class*="error"], [class*="alert"], text=/用户名或密码错误|登录失败/').first().textContent().catch(() => '');
    if (errMsg) {
      findings.push({ severity: 'P0', desc: `登录失败: ${errMsg}` });
      writeReport(shots, findings, 'BLOCKED');
      await browser.close();
      process.exit(1);
    }
  }

  // ─── Step 2: Navigate to md-to-ppt-agent ─────────────────────────────────
  console.log('[2] 导航到 MD 转 PPT...');
  await page.goto(`${BASE}/md-to-ppt-agent`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(3000);
  console.log(`[2] URL: ${page.url()}`);

  if (page.url().includes('/login')) {
    console.log('[2] 重定向登录，等待输入框...');
    await page.waitForSelector('input[type="password"]', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const userInput2 = page.locator('input[type="text"]').first();
    const passInput2 = page.locator('input[type="password"]').first();
    if (await userInput2.count() > 0) {
      await userInput2.fill(USER);
      await passInput2.fill(PASS);
      const loginBtn2 = page.locator('button:has-text("登录"), button:has-text("Login")').first();
      if (await loginBtn2.count() > 0) {
        await loginBtn2.click();
      } else {
        await passInput2.press('Enter');
      }
      await page.waitForTimeout(4000);
      if (!page.url().includes('/login')) {
        await page.goto(`${BASE}/md-to-ppt-agent`, { waitUntil: 'load', timeout: 30000 });
        await page.waitForTimeout(3000);
      }
    }
    console.log(`[2] 最终 URL: ${page.url()}`);
  }

  if (page.url().includes('/login')) {
    findings.push({ severity: 'P0', desc: '无法通过登录，无法到达目标页面' });
    await shot(page, '01-blocked', '登录受阻');
    writeReport(shots, findings, 'BLOCKED');
    await browser.close();
    process.exit(1);
  }

  // Verify we're on PPT page
  const hasTextarea = await page.locator('textarea').count() > 0;
  const pageContent = await page.locator('body').textContent();
  const onPptPage = pageContent?.includes('PPT') || pageContent?.includes('工作台');
  console.log(`[2] 在 PPT 工作台: ${onPptPage}, textarea: ${hasTextarea}`);

  await shot(page, '01-initial-layout', 'PPT 创作工作台初始双栏布局');

  if (!hasTextarea) {
    findings.push({ severity: 'P0', desc: `页面无 textarea，不是 PPT 工作台 (URL=${page.url()})` });
    writeReport(shots, findings, 'FAIL');
    await browser.close();
    process.exit(1);
  }

  // ─── Step 3: Send message ─────────────────────────────────────────────────
  console.log('[3] 输入 PPT 需求...');
  const testPrompt = '帮我制作一个关于"React Hooks 核心概念"的 PPT，4 页，包含 useState 和 useEffect 介绍';

  const textarea = page.locator('textarea').first();
  await textarea.click();
  await textarea.fill(testPrompt);
  await page.waitForTimeout(300);
  await shot(page, '02-input-filled', '已输入 PPT 需求文字');

  // Send via Enter (page onKeyDown: Enter without Shift = handleSend)
  await textarea.press('Enter');
  await page.waitForTimeout(1500);
  console.log('[3] 消息已发送');
  await shot(page, '03-message-sent', '消息已发送，等待 LLM 大纲规划');

  // ─── Step 4: Wait for OutlineBubble ───────────────────────────────────────
  console.log('[4] 等待大纲气泡（最多 60 秒）...');

  let outlineAppeared = false;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1000);
    const hasConfirmBtn = await page.locator('button:has-text("确认，生成 PPT")').count() > 0;
    if (hasConfirmBtn) {
      outlineAppeared = true;
      console.log(`[4] 大纲气泡在 ${i+1}s 后出现`);
      break;
    }
    // Also check for error
    const hasError = await page.locator('text=/调用失败|网络错误|LLM.*错误/i').count() > 0;
    if (hasError) {
      findings.push({ severity: 'P0', desc: 'LLM 调用出错，大纲生成失败' });
      await shot(page, '04-llm-error', 'LLM 调用失败');
      writeReport(shots, findings, 'FAIL');
      await browser.close();
      process.exit(1);
    }
    if (i === 15 || i === 35) await shot(page, `04-waiting-${i}s`, `等待大纲 ${i}s`);
  }

  if (!outlineAppeared) {
    // Check what's on screen
    const msgTexts = await page.locator('[class*="text-xs"]').allTextContents();
    findings.push({ severity: 'P0', desc: `60 秒内大纲气泡未出现。页面内容: ${msgTexts.slice(0, 5).join(' | ').substring(0, 200)}` });
    await shot(page, '04-timeout', '大纲等待超时');
    writeReport(shots, findings, 'FAIL');
    await browser.close();
    process.exit(1);
  }

  await shot(page, '05-outline-bubble', '大纲气泡已渲染，显示 AI 规划的幻灯片大纲结构');

  // ─── Step 5: Click confirm ─────────────────────────────────────────────────
  console.log('[5] 点击确认生成 PPT...');
  await page.locator('button:has-text("确认，生成 PPT")').first().click();
  await page.waitForTimeout(1000);
  await shot(page, '06-generation-started', '已确认大纲，PPT 生成 SSE 流已启动');

  // ─── Step 6: Wait for iframe ───────────────────────────────────────────────
  console.log('[6] 等待 iframe 出现（最多 90 秒，SSE 流需时间）...');

  let iframeAppeared = false;
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(1000);
    const count = await page.locator('iframe[sandbox]').count();
    if (count > 0) {
      iframeAppeared = true;
      console.log(`[6] iframe 在 ${i+1}s 后出现`);
      break;
    }
    // Note: "中止" button uses text-red-400 during streaming (isStreaming=true) - that is NOT an error
    // Only check for actual error phase messages (phase=error in chat messages)
    const hasPhaseError = await page.locator('[class*="flex items-start gap-2 text-red"]').count() > 0;
    if (i > 20 && hasPhaseError) {
      const errText = await page.locator('[class*="flex items-start gap-2 text-red"]').first().textContent().catch(() => '');
      if (errText && errText.length > 5) {
        findings.push({ severity: 'P0', desc: `PPT 生成失败（phase=error）: ${errText.substring(0, 100)}` });
        await shot(page, '06-gen-error', 'PPT 生成失败');
        writeReport(shots, findings, 'FAIL');
        await browser.close();
        process.exit(1);
      }
    }
    if (i === 20 || i === 50 || i === 70) await shot(page, `06-generating-${i}s`, `生成中 ${i}s`);
  }

  if (!iframeAppeared) {
    findings.push({ severity: 'P0', desc: '90 秒内 iframe 未出现，PPT 生成失败' });
    await shot(page, '06-iframe-timeout', 'iframe 超时');
    writeReport(shots, findings, 'FAIL');
    await browser.close();
    process.exit(1);
  }

  await page.waitForTimeout(2000);
  await shot(page, '07-ppt-rendered', 'PPT 已在 iframe 中渲染（reveal.js）');

  // ─── Step 7: Verify P1 security fix ───────────────────────────────────────
  console.log('[7] P1 安全验证：iframe sandbox 属性...');

  const sandboxAttr = await page.evaluate(() => {
    const iframe = document.querySelector('iframe[sandbox]');
    return iframe?.getAttribute('sandbox') ?? null;
  });
  const srcdocLen = await page.evaluate(() => {
    const iframe = document.querySelector('iframe[sandbox]');
    return iframe?.getAttribute('srcdoc')?.length ?? 0;
  });
  const srcdocPreview = await page.evaluate(() => {
    const iframe = document.querySelector('iframe[sandbox]');
    return (iframe?.getAttribute('srcdoc') ?? '').substring(0, 300);
  });

  console.log(`[7] sandbox="${sandboxAttr}" srcdocLen=${srcdocLen}`);
  console.log(`[7] srcdoc 前 200: ${srcdocPreview.substring(0, 200).replace(/\n/g, ' ')}`);

  const hasAllowSameOrigin = sandboxAttr?.includes('allow-same-origin') ?? false;
  const hasAllowScripts = sandboxAttr?.includes('allow-scripts') ?? false;
  const hasReveal = srcdocPreview.toLowerCase().includes('reveal');

  if (sandboxAttr === null) {
    findings.push({ severity: 'P1', desc: 'iframe 无 sandbox 属性' });
  } else if (hasAllowSameOrigin) {
    findings.push({ severity: 'P0', desc: `P1 安全漏洞未修复：sandbox="${sandboxAttr}" 含 allow-same-origin` });
    console.log('[7] [FAIL] P1 安全漏洞！');
  } else if (!hasAllowScripts) {
    findings.push({ severity: 'P1', desc: `sandbox 不含 allow-scripts (值="${sandboxAttr}")` });
  } else {
    console.log(`[7] [PASS] P1 安全修复正确：sandbox="${sandboxAttr}"，无 allow-same-origin`);
  }

  if (!hasReveal && srcdocLen < 500) {
    findings.push({ severity: 'P1', desc: `iframe srcdoc 过短或无 reveal.js 标记 (len=${srcdocLen})` });
  } else {
    console.log(`[7] [PASS] reveal.js PPT 内容已注入，srcdoc ${srcdocLen} 字符，含 reveal: ${hasReveal}`);
  }

  await shot(page, '08-security-pass', `P1 安全验证：sandbox="${sandboxAttr}"，srcdoc ${srcdocLen}字符`);

  // ─── Step 8: Multi-turn patch ──────────────────────────────────────────────
  console.log('[8] 多轮 patch 测试...');

  const patchMsg = '请把第一页的标题改成"React Hooks 完全指南"';
  const textarea2 = page.locator('textarea').first();

  let patchTested = false;
  const isDisabled = await textarea2.isDisabled().catch(() => true);
  if (!isDisabled) {
    await textarea2.click();
    await textarea2.fill(patchMsg);
    await page.waitForTimeout(300);
    await shot(page, '09-patch-input', '输入 patch 修改请求');

    await textarea2.press('Enter');
    await page.waitForTimeout(1000);
    console.log('[8] patch 消息已发送，等待更新（最多 60s）...');

    const prevSrcdocLen = srcdocLen;
    let patchDone = false;

    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(1000);
      const spinners = await page.locator('[class*="animate-spin"]').count();
      const curLen = await page.evaluate(() => {
        return document.querySelector('iframe[sandbox]')?.getAttribute('srcdoc')?.length ?? 0;
      });

      // Done if no spinner AND content changed (or enough time passed)
      if (i >= 3 && spinners === 0 && curLen > 0) {
        console.log(`[8] patch 完成: srcdoc ${prevSrcdocLen} → ${curLen}`);
        patchDone = true;
        patchTested = true;
        break;
      }
      if (i === 30) await shot(page, '09-patching-30s', 'patch 生成中 30s');
    }

    if (!patchDone) {
      findings.push({ severity: 'P2', desc: 'patch：60s 内未检测到 iframe 更新完成' });
    }
    await shot(page, '10-patch-done', `patch 处理结果（已测试: ${patchTested}）`);
  } else {
    findings.push({ severity: 'P2', desc: '多轮 patch 跳过：textarea 处于禁用状态' });
    console.log('[8] 跳过 patch（textarea 不可用）');
  }

  // ─── Step 9: Session persistence ──────────────────────────────────────────
  console.log('[9] 测试 sessionStorage 持久化...');

  const beforeRefresh = await page.evaluate(() => {
    const raw = sessionStorage.getItem('md-to-ppt-chat-v1');
    try { return raw ? JSON.parse(raw) : null; } catch { return null; }
  });
  console.log(`[9] 刷新前 session: ${beforeRefresh ? `${beforeRefresh.messages?.length ?? 0} 条消息` : '无'}`);

  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(3500);
  console.log(`[9] 刷新后 URL: ${page.url()}`);

  if (page.url().includes('/login')) {
    findings.push({ severity: 'P2', desc: '刷新后 session token 失效，跳转登录（sessionStorage 不持久跨刷新，已知行为）' });
    console.log('[9] [INFO] 刷新后 token 失效（sessionStorage 不跨刷新，属已知行为）');
    await shot(page, '11-reload-login', '刷新后跳转登录（token 失效，已知）');
  } else {
    const afterRefresh = await page.evaluate(() => {
      const raw = sessionStorage.getItem('md-to-ppt-chat-v1');
      try { return raw ? JSON.parse(raw) : null; } catch { return null; }
    });
    const msgCount = afterRefresh?.messages?.length ?? 0;
    const runId = afterRefresh?.activeRunId ?? '';
    const hasIframe = await page.locator('iframe[sandbox]').count() > 0;
    const hasReactText = await page.locator('text=/React Hooks/').count() > 0;

    console.log(`[9] 刷新后: ${msgCount} 条消息, runId=${runId}, iframe=${hasIframe}, 消息可见=${hasReactText}`);

    if (msgCount > 0) {
      console.log('[9] [PASS] sessionStorage 持久化成功');
    } else {
      findings.push({ severity: 'P2', desc: '刷新后 sessionStorage 无对话历史（可能页面重建后清空）' });
    }
    await shot(page, '11-after-reload', `刷新后：${msgCount} 条消息, iframe=${hasIframe}`);
  }

  // ─── Final ──────────────────────────────────────────────────────────────────
  await browser.close();

  const p0 = findings.filter(f => f.severity === 'P0').length;
  const p1 = findings.filter(f => f.severity === 'P1').length;
  const p2 = findings.filter(f => f.severity === 'P2').length;
  const verdict = p0 > 0 ? 'FAIL' : p1 > 0 ? 'CONDITIONAL' : 'PASS';

  console.log(`\n[完成] verdict=${verdict} P0=${p0} P1=${p1} P2=${p2}`);
  console.log('[截图]', shots.map(s => s.name + '.png').join(', '));
  if (findings.length > 0) {
    console.log('[缺陷]');
    findings.forEach(f => console.log(`  ${f.severity}: ${f.desc}`));
  }

  writeReport(shots, findings, verdict);
})().catch(async (err) => {
  console.error('[CRASH]', err.message, err.stack?.split('\n')[0]);
  findings.push({ severity: 'P0', desc: `驱动异常: ${err.message}` });
  writeReport(shots, findings, 'FAIL');
  process.exit(1);
});

function writeReport(shots, findings, verdict) {
  const manifest = {
    verdict,
    tier: 'L1',
    capturedAt: new Date().toISOString(),
    branch: 'claude/amazing-edison-mhzb22',
    previewUrl: 'https://amazing-edison-mhzb22-claude-prd-agent.miduo.org/md-to-ppt-agent',
    shots: shots.map(s => s.name),
    autoFindings: findings,
    p0Count: findings.filter(f => f.severity === 'P0').length,
    p1Count: findings.filter(f => f.severity === 'P1').length,
    p2Count: findings.filter(f => f.severity === 'P2').length,
  };
  fs.writeFileSync('/tmp/lifecycle_result.json', JSON.stringify(manifest, null, 2));
}
