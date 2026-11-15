import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url), { chromium } = require('playwright');
const arg = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; };
const root = arg('--source', path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const out = arg('--out', '/tmp/cds-topology-task'); fs.mkdirSync(out, { recursive: true });
const { startViteDevServer } = await import(pathToFileURL(root + '/cds/scripts/lib/vite-dev-server.mjs'));
const { resolveFixture } = await import(pathToFileURL(root + '/cds/scripts/fixtures/mobile-layout-fixtures.mjs'));
const hash = () => createHash('sha256').update(execFileSync('git', ['diff', 'HEAD', '--', 'cds/web/src'], { cwd: root })).digest('hex');
const provenance = { kind: 'deterministic-fixture', sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceDiffSha256: hash(), scriptSha256: createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex') };
const results = [], server = await startViteDevServer(); let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox'] });
  for (const width of arg('--widths','1440,390').split(',').map(Number)) for (const theme of arg('--themes','light,dark').split(',')) for (const sample of [
    { name: 'sparse-one', profiles: 1, branches: 2, infraCount: 0 },
    { name: 'few-shared', profiles: 2, branches: 2 },
    { name: 'few-branch', profiles: 2, branches: 2, branch: true },
    { name: 'many-shared', profiles: 30, branches: 91 },
    { name: 'mode-unknown', profiles: 2, branches: 2, branch: true, unknown: true },
    { name: 'read-error', profiles: 2, branches: 2, error: true },
    { name: 'empty', profiles: 0, branches: 0 },
  ].filter(s=>arg('--cases','all')==='all'||arg('--cases','all').split(',').includes(s.name))) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' }), page = await context.newPage();
    const label = `${sample.name}-${width}-${theme}`; console.log(label); page.setDefaultTimeout(10000);
    const check = (pass, name, measurement) => { results.push({ width, theme, sample: sample.name, name, pass: !!pass, ...(measurement ? { measurement } : {}) }); if (!pass) process.exitCode = 1; };
    const profiles = Array.from({ length: sample.profiles }, (_, i) => ({ id: `profile-${i}`, projectId: 'fixture-project', name: i ? `样例应用 ${i}` : '样例支付 API', dockerImage: 'node:22-alpine', workDir: '.', containerPort: 8000 + i, command: 'node server.mjs --require-confirmed-fixture-config ' + ' --synthetic-long-argument=readable-context'.repeat(8), pathPrefixes: ['/api'], dependsOn: sample.infraCount===0?[]:['infra-0'] }));
    const branches = Array.from({ length: sample.branches }, (_, i) => ({ id: `branch-${i}`, projectId: 'fixture-project', branch: i ? `feature/workspace-${i}` : 'main', previewSlug: `sample-${i}`, status: i === 1 ? 'error' : 'running', createdAt: '2026-11-15T09:00:00Z', services: Object.fromEntries(profiles.map(p => [p.id, { profileId: p.id, containerName: `${p.id}-b${i}`, hostPort: p.containerPort, status: i === 1 ? 'error' : 'running', ...(i === 1 ? { errorMessage: '合成启动错误，保留原因' } : {}) }])) }));
    const infra = profiles.length ? Array.from({length:sample.infraCount??2},(_,i)=>i).map(i => ({ id: `infra-${i}`, projectId: 'fixture-project', name: i ? '样例缓存' : '样例数据库', dockerImage: i ? 'redis:7' : 'postgres:16', containerPort: i ? 6379 : 5432, hostPort: 16000 + i, containerName: `fixture-infra-${i}`, status: 'running' })) : [];
    const writes = [], readonlyPosts = [];
    await context.addInitScript(theme => { localStorage.setItem('cds_theme', theme); window.EventSource = class { addEventListener() {} removeEventListener() {} close() {} }; }, theme);
    await context.route('**/api/**', async route => {
      const p = new URL(route.request().url()).pathname.replace(/^\/_cds/, ''), method = route.request().method(); let data;
      if (method !== 'GET') { if (p.endsWith('/container-logs')) { readonlyPosts.push(p); data = { logs: '合成运行日志，仅本地查询' }; } else { writes.push({ path: p, method }); return route.fulfill({ status: 403, body: '{}' }); } }
      else if (p === '/api/auth/status') data = { authenticated: true, enabled: true, mode: 'github', user: { id: 'fixture-owner', githubLogin: 'fixture-owner', isSystemOwner: true } };
      else if (p === '/api/projects/fixture-project') { if (sample.error) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"拓扑接口暂不可用"}' }); data = { id: 'fixture-project', name: '拓扑样例项目', slug: 'fixture-project', branchCount: branches.length }; }
      else if (p === '/api/branches') data = { branches };
      else if (p === '/api/build-profiles') data = { profiles };
      else if (p === '/api/infra') data = { services: infra };
      else if (p.endsWith('/preview-mode')) { if (sample.unknown) return route.fulfill({ status: 503, body: '{}' }); data = { mode: 'multi' }; }
      else if (p === '/api/config') data = { mainDomain: 'example.invalid', previewDomain: 'preview.example.invalid' };
      else if (p === '/api/routing-rules') data = { rules: [] };
      else data = resolveFixture(p) ?? {};
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    });
    try {
      await page.goto(server.url + '/branch-topology?project=fixture-project' + (sample.branch ? '&branch=branch-0' : ''), { waitUntil: 'domcontentloaded' });
      if (sample.error) { await page.getByText('拓扑接口暂不可用', { exact: false }).first().waitFor(); check(await page.getByText('还没有服务节点', { exact: true }).count() === 0, '读取失败不伪称无节点'); }
      else if (!profiles.length) { await page.getByText('还没有服务节点', { exact: true }).waitFor(); check(await page.getByRole('button', { name: '新增基础设施', exact: true }).count() > 0, '真实空态明确添加下一步'); const empty=await page.getByText('还没有服务节点',{exact:true}).evaluate(e=>{const r=e.closest('section').getBoundingClientRect();return {height:r.height,bottom:r.bottom}}); check(empty.bottom<900&&await page.getByText('选择一个节点',{exact:true}).count()===0,'全空状态自然结束，不追加无对象详情空架',empty); }
      else {
        const firstNode = page.getByRole('button', { name: /^样例支付 API/ }).first(); await firstNode.waitFor();
        await page.waitForTimeout(150);
        const measure = await firstNode.evaluate(e => { const r = e.getBoundingClientRect(), select = [...document.querySelectorAll('select')].find(e => [...e.options].some(o => o.textContent === '共享视图')); return { firstObjectY: r.top, firstObjectHeight: r.height, branchSelectY: select?.getBoundingClientRect().top, scrollToFirstObject: Math.max(0, r.bottom - innerHeight) }; });
        const spacing=await firstNode.evaluate(e=>{const section=e.closest('section').parentElement.closest('section'),r=section.getBoundingClientRect(),last=Math.max(...[...section.querySelectorAll('button')].map(b=>b.getBoundingClientRect().bottom)),aside=section.parentElement.querySelector('aside');const prior=section.style.minHeight;section.style.minHeight='0px';const naturalHeight=section.getBoundingClientRect().height;section.style.minHeight=prior;let detailExcess=null;if(aside){const height=aside.getBoundingClientRect().height,old=aside.style.minHeight;aside.style.minHeight='0px';detailExcess=height-aside.getBoundingClientRect().height;aside.style.minHeight=old}return{sectionHeight:r.height,sectionMinHeightExcess:r.height-naturalHeight,detailMinHeightExcess:detailExcess,spaceAfterLastAction:r.bottom-last,detailGap:aside?aside.getBoundingClientRect().top-last:null}});results.push({width,theme,sample:sample.name,name:'少量布局真实尾部间隔',pass:true,measurement:spacing});
        check(measure.firstObjectY < 900 && measure.branchSelectY < 900, '首屏能看到首服务对象与分支选择', measure);
        check(await page.getByText('预览模式', { exact: false }).count() > 0 && await page.getByText('应用服务', { exact: true }).count() > 0 && await page.getByText('基础设施', { exact: true }).count() > 0, '模式与应用基础设施事实完整保留');
        await page.screenshot({ path: `${out}/${label}-default.png` });
        const quick=page.getByText('按分支名打开预览',{exact:true});if(await quick.count()){await quick.focus();await page.keyboard.press('Enter');await page.locator('#topology-quick-branch').waitFor();check(await page.locator('#topology-quick-branch').isVisible(),'按名预览替代路径可由键盘按需打开');await quick.focus();await page.keyboard.press('Enter');}else check(false,'按名预览替代路径可由键盘按需打开');
        await firstNode.focus(); await page.keyboard.press('Enter');
        const details = page.locator('aside'); await details.getByText('样例支付 API', { exact: true }).waitFor();
        if (sample.unknown) check(await page.getByText('预览模式未确认', { exact: false }).count() > 0 && await details.getByRole('link', { name: '打开预览', exact: true }).count() === 0, '模式读取失败不借用multi生成可预览承诺');
        if(sample.unknown)check(await details.getByText('预览模式未确认',{exact:false}).count()>0&&await details.getByRole('button',{name:'预览入口',exact:true}).count()===0,'未知预览在选中对象旁说明并给真实核对去向，不用仅toast的死入口');
        const disclosure = details.locator('details').filter({ has: page.locator('summary', { hasText: '配置与依赖' }) });
        const outsideCommand = await details.evaluate(e => [...e.querySelectorAll('*')].some(n => !n.closest('details') && n.children.length === 0 && n.textContent.includes('--require-confirmed-fixture-config')));
        check(!outsideCommand, '长命令不在诊断摘要重复常驻');
        await disclosure.locator('summary').focus(); await page.keyboard.press('Enter'); await disclosure.locator('pre').waitFor();
        check((await disclosure.locator('pre').innerText()).includes('--synthetic-long-argument=readable-context'), '配置全文键盘按需可达');
        await page.screenshot({ path: `${out}/${label}-config.png` });
      }
      if(sample.error||!profiles.length)await page.screenshot({path:`${out}/${label}-default.png`});
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '文档没有横向溢出');
      check(writes.length === 0, '无业务写入', { blockedWrites: writes, syntheticReadonlyPosts: readonlyPosts.length });
    } catch (error) { results.push({ width, theme, sample: sample.name, name: '流程完成', pass: false, error: String(error) }); process.exitCode = 1; await page.screenshot({ path: `${out}/${label}-failed.png` }); }
    finally { await context.close(); }
  }
  checkStable: { const pass = hash() === provenance.sourceDiffSha256; results.push({ name: '取证源码稳定', pass }); if (!pass) process.exitCode = 1; }
} finally { fs.writeFileSync(out + '/results.json', JSON.stringify({ provenance, results }, null, 2)); console.log(JSON.stringify(results)); await browser?.close(); server.stop(); }
