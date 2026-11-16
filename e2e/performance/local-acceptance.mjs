import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { digest, executionErrors, buildIdentityErrors } from './metrics.mjs';

// Reuse a successful run's immutable Release build, SDK, pinned images and
// proxy. This suite exercises real pages; it does not recalibrate performance.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--prepared', '--out'].includes(args[i]) || !args[i + 1]) throw new Error('参数: --prepared RESULT_JSON --out work/DIR');
  options[args[i].slice(2)] = args[i + 1];
}
if (!options.prepared || !options.out) throw new Error('先用现有run.mjs完成指定提交的normal运行，再传入其result.json');
const preparedPath = path.resolve(root, options.prepared);
const prepared = JSON.parse(await fs.readFile(preparedPath, 'utf8'));
if (executionErrors(prepared).length || prepared.failure || prepared.comparison?.pass === false
    || prepared.injectionMs || prepared.browserInjection?.delayMs) throw new Error('准备结果必须为未注入且完整成功的实际运行');
const out = path.resolve(root, options.out);
if (!out.startsWith(path.join(root, 'work') + path.sep)) throw new Error('输出仅限仓库work目录');
await fs.mkdir(out, { recursive: true });
try { await fs.access(path.join(out, 'result.json')); throw new Error('拒绝覆盖已有验收结果'); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
const runId = `map-perf-ui-${randomBytes(6).toString('hex')}`;
const run = promisify(execFile);
const command = async (bin, argv) => (await run(bin, argv, { cwd: root, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
const docker = async argv => {
  try {
    return (await run('docker', ['--host=unix:///var/run/docker.sock', ...argv], {
      cwd: root, maxBuffer: 4 * 1024 * 1024,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'].includes(key))),
    })).stdout.trim();
  } catch (e) { throw new Error(`本地Docker ${argv[0]}失败: ${(e.stderr ?? '').slice(0, 400)}`); }
};
const commit = prepared.commit;
const sdk = process.env.DOTNET_BIN ?? 'dotnet';
if (await command(sdk, ['--version']) !== prepared.contract.sdkVersion) throw new Error('SDK与准备结果不一致');
const sdkRoot = path.dirname(await fs.realpath(await command('sh', ['-c', 'command -v "$1"', 'sh', sdk])));
const build = path.join(root, 'work/performance', `build-${digest({ commit, sdkVersion: prepared.contract.sdkVersion, arch: os.arch(), buildMetadataVersion: 2 }).slice(0, 20)}`);
if ((await fs.readFile(path.join(build, 'complete'), 'utf8')).trim() !== commit) throw new Error('没有该提交的完整构建，先运行现有性能入口');
const containers = [], networks = [];
const password = `Perf_${randomBytes(18).toString('hex')}!`;
let base, token, browser;
const result = { schema: 1, provenance: 'integration-live', commit, harnessCommit: await command('git', ['rev-parse','HEAD']),
  driverDigest: digest(await fs.readFile(fileURLToPath(import.meta.url), 'utf8')),
  preparedResult: { path: options.prepared, sha256: createHash('sha256').update(await fs.readFile(preparedPath)).digest('hex') },
  startedAt: new Date().toISOString(), state: 'running', cases: [], anonymous: null, restartRecovery: null };
const save = () => fs.writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
const api = async (route, method = 'GET', body) => {
  const response = await fetch(`${base}${route}`, { method, headers: { 'Content-Type':'application/json', ...(token ? {Authorization:`Bearer ${token}`} : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000), redirect: 'error' });
  const json = await response.json();
  if (!response.ok || !json.success) throw new Error(`${method} ${route}: ${response.status} ${json.error?.code ?? ''}`);
  return json.data;
};
const login = async () => {
  token = (await api('/api/v1/auth/login', 'POST', { username:'perfadmin', password, clientType:'admin' })).accessToken;
};
const waitReady = async () => {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${base}/api/version`, {signal:AbortSignal.timeout(3000)}); if(r.ok && (await r.json()).actualCommit === commit) return; } catch {}
    await pause(300);
  }
  throw new Error('实际API版本在180秒内未就绪');
};
const originalContent = '# 性能文档-0-0\n\nMAP性能样例\n\n' + '真实本地验收，不调用模型。\n'.repeat(180);
let entryId;
try {
  await docker(['info','--format','{{.ServerVersion}}']);
  const apiDir = path.join(out,'api');
  await fs.cp(path.join(build,'api'),apiDir,{recursive:true});
  for (const file of ['Map.PerformanceProbe.dll','Map.PerformanceProbe.deps.json'])
    await fs.copyFile(path.join(path.dirname(preparedPath),'probe',file),path.join(apiDir,file));
  for (const name of [runId,`${runId}-ingress`]) {
    await docker(['network','create',...(name===runId?['--internal']:[]),'--label',`map-perf=${runId}`,name]); networks.push(name);
  }
  const images = { ...prepared.contract.images, api: prepared.contract.runtimeImage };
  for (const role of ['mongo','redis','api','web']) {
    const name=`${runId}-${role}`;
    const argv=['run','-d','--name',name,'--label',`map-perf=${runId}`,'--network',runId,'--network-alias',role,
      '-e','HTTP_PROXY=','-e','HTTPS_PROXY=','-e','ALL_PROXY=','-e','http_proxy=','-e','https_proxy=','-e','all_proxy='];
    if(role==='api') argv.push('--user',`${process.getuid()}:${process.getgid()}`,'--entrypoint','/dotnet/dotnet','-w','/app',
      '-v',`${sdkRoot}:/dotnet:ro`,'-v',`${apiDir}:/app`,'-e','DOTNET_ROOT=/dotnet','-e','ASPNETCORE_URLS=http://+:8080',
      '-e','ASPNETCORE_ENVIRONMENT=Testing','-e',`GIT_COMMIT=${commit}`,'-e','MongoDB__ConnectionString=mongodb://mongo:27017',
      '-e','MongoDB__DatabaseName=map_performance','-e','LlmGateway__MongoConnectionString=mongodb://mongo:27017',
      '-e','LlmGateway__DatabaseName=perf_gateway','-e','Redis__ConnectionString=redis:6379',
      '-e','MAP_INITIAL_ADMIN_USERNAME=perfadmin','-e',`MAP_INITIAL_ADMIN_PASSWORD=${password}`,'-e',`Jwt__Secret=${randomBytes(32).toString('hex')}`,
      '-e','ASSETS_PROVIDER=local','-e','ASSETS_LOCAL_DIR=/tmp/assets','-e','LlmGateway__ServeBaseUrl=http://127.0.0.1:9',
      '-e','MAP_PERF_ISOLATED=1','-e','MAP_PERF_DELAY_MS=0','-e','ASPNETCORE_HOSTINGSTARTUPASSEMBLIES=Map.PerformanceProbe',
      '-e','DOTNET_ADDITIONAL_DEPS=/app/Map.PerformanceProbe.deps.json');
    if(role==='web') argv.push('--network',`${runId}-ingress`,'-p','127.0.0.1::80',
      '-v',`${path.join(build,'prd-admin/dist')}:/usr/share/nginx/html:ro`,
      '-v',`${path.join(root,'e2e/performance/nginx.conf')}:/etc/nginx/nginx.conf:ro`);
    argv.push(images[role]); if(role==='api') argv.push('PrdAgent.Api.dll');
    await docker(argv); containers.push(name);
  }
  const web=JSON.parse(await docker(['inspect',`${runId}-web`]))[0];
  base=`http://127.0.0.1:${web.NetworkSettings.Ports['80/tcp'][0].HostPort}`;
  const isolated=JSON.parse(await docker(['network','inspect',runId]))[0].Internal;
  if(!isolated) throw new Error('API网络未隔离');
  result.isolation={networkInternal:isolated,publishedAddress:base,freshDatabases:true,credentials:'random-local-only'};
  await waitReady(); await login();
  const version=await (await fetch(`${base}/api/version`)).json();
  const html=await (await fetch(base)).text();
  result.buildIdentity={api:{actualCommit:version.actualCommit,expectedCommit:version.expectedCommit,commitMatch:version.commitMatch},
    webEntries:[...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map(x=>x[1])};
  if(buildIdentityErrors(commit,result.buildIdentity).length) throw new Error('实际应用/Web SHA与冻结提交不符');
  await api('/api/v1/admin/rate-limit/global','PUT',prepared.contract.workload.rateLimit);
  for(let s=0;s<6;s++) {
    const store=await api('/api/document-store/stores','POST',{name:`性能知识库-${s}`,isPublic:false});
    for(let d=0;d<20;d++) {
      const doc=await api(`/api/document-store/stores/${store.id}/entries`,'POST',{title:`性能文档-${s}-${d}`,sourceType:'upload',contentType:'text/markdown'});
      await api(`/api/document-store/entries/${doc.id}/content`,'PUT',{content:originalContent.replace('性能文档-0-0',`性能文档-${s}-${d}`)});
      if(s===0&&d===0) entryId=doc.id;
    }
    await api(`/api/document-store/stores/${store.id}`);
  }
  result.fixture={stores:6,readingDocuments:120,contentBytes:Buffer.byteLength(originalContent),purpose:'功能与主题验收；不替代248篇文档的性能容量合同'};
  browser=await chromium.launch({executablePath:process.env.PERF_CHROMIUM_PATH||undefined,args:['--no-proxy-server']});
  result.browserVersion=browser.version();
  const cases=[['desktop-dark',1440,1000,'dark'],['desktop-light',1440,1000,'light'],['mobile-dark',390,844,'dark'],['mobile-light',390,844,'light']];
  for(const [id,width,height,theme] of cases) {
    await login(); await api(`/api/document-store/entries/${entryId}/content`,'PUT',{content:originalContent});
    const context=await browser.newContext({viewport:{width,height},hasTouch:width<768,isMobile:width<768,reducedMotion:'reduce',serviceWorkers:'block'});
    const origin=new URL(base).origin;
    await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    const page=await context.newPage(); page.setDefaultTimeout(30_000);
    let stage='entry';
    const record={id,viewport:{width,height},theme,pass:false,steps:[],requests:[],pageErrors:[],
      preferenceSetup:'各目标视口通过实际外观入口选择主题，不注入存储或修改DOM'}; result.cases.push(record);
    page.on('pageerror',e=>record.pageErrors.push(e.message));
    page.on('response',r=>{let u=new URL(r.url());if(u.pathname.startsWith('/api/'))record.requests.push({path:u.pathname,status:r.status(),stage,at:new Date().toISOString()});});
    await page.addLocatorHandler(page.getByRole('button',{name:'我已学会',exact:true}),()=>page.getByRole('button',{name:'我已学会',exact:true}).click());
    const uiLogin=async()=>{
      await page.goto(`${base}/home`,{waitUntil:'domcontentloaded'});
      const publicMenu=page.getByRole('button',{name:'Open menu',exact:true});
      if(await publicMenu.isVisible()) await publicMenu.click();
      await page.getByRole('button',{name:'登录 / 注册',exact:true}).filter({visible:true}).first().click();
      await page.locator('input[autocomplete="username"]').fill('perfadmin');
      await page.locator('input[type="password"]').fill(password);
      await page.getByRole('button',{name:'进入控制台',exact:true}).click();
      if(width<768) {
        await expect(page.getByText('继续上次',{exact:true})).toBeVisible();
        await expect(page.getByText(/^性能知识库-\d+$/).first()).toBeVisible();
      } else await expect(page.locator('[aria-labelledby="home-continue-heading"] .home-desk-work-list button').first()).toBeVisible();
    };
    // The product deliberately omits data-theme in dark mode; only light is
    // represented by an attribute. Check the real contract, not a synthetic DOM.
    const assertTheme=()=>expect.poll(()=>page.locator('html').getAttribute('data-theme')).toBe(theme==='light'?'light':null);
    const capture=async step=>{stage=step;record.steps.push({step,url:page.url(),theme:(await page.locator('html').getAttribute('data-theme'))??'dark'});await page.screenshot({path:path.join(out,`${id}-${step}.png`),animations:'disabled'});};
    try {
      // Each journey starts at the public entry and uses its viewport's real
      // theme control. No storage flags, token injection or DOM mutation.
      await uiLogin();
      if(width<768) {
        const toggle=()=>page.getByRole('button',{name:theme==='light'?'切换到浅色':'切换到暗色',exact:true});
        if(!await toggle().isVisible()) await page.getByRole('button',{name:theme==='light'?'切换到暗色':'切换到浅色',exact:true}).click();
        await toggle().click();
      } else {
        await page.getByRole('button',{name:'打开用户菜单',exact:true}).click();
        await page.getByRole('menuitemradio',{name:theme==='light'?'白天':'黑夜',exact:true}).click();
        await page.keyboard.press('Escape');
      }
      await assertTheme(); await capture('home');
      if(width<768) {
        await page.getByRole('button',{name:'打开导航菜单',exact:true}).click();
        const drawer=page.getByRole('dialog');
        await drawer.getByRole('button',{name:'知识库',exact:true}).click();
        await expect(drawer).not.toBeVisible();
      } else await page.getByText('知识库',{exact:true}).filter({visible:true}).first().click();
      await expect(page.getByText('性能知识库-0',{exact:true}).first()).toBeVisible(); await capture('knowledge-list');
      await page.getByText('性能知识库-0',{exact:true}).first().click();
      await page.getByText('性能文档-0-0',{exact:true}).first().click();
      await expect(page.getByText('MAP性能样例',{exact:true}).first()).toBeVisible(); await capture('document-open');
      if(width<768) await page.getByRole('button',{name:'更多操作',exact:true}).click();
      await page.getByRole('button',{name:'编辑文档',exact:true}).click();
      const source=page.getByRole('button',{name:/源码/}); if(await source.count()) await source.first().click();
      const marker=`MAP无模型写入已持久化-${id}`;
      await page.locator('textarea[placeholder*="正文"], textarea[placeholder*="在此编辑"]').fill(`# 本地验收-${id}\n\n${marker}`);
      const saved=page.waitForResponse(r=>r.request().method()==='PUT'&&r.url().endsWith('/content')&&r.ok());
      await page.getByRole('button',{name:'保存',exact:true}).click(); await saved;
      await expect(page.getByText(marker,{exact:true}).first()).toBeVisible();
      const refreshed=page.waitForResponse(r=>r.request().method()==='GET'&&r.url().includes(`/entries/${entryId}/content`)&&r.ok());
      await page.reload({waitUntil:'domcontentloaded'}); await refreshed;
      await expect(page.getByText(marker,{exact:true}).first()).toBeVisible();
      await assertTheme();
      const layout=await page.evaluate(()=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth,theme:document.documentElement.dataset.theme??'dark'}));
      if(layout.documentWidth>width+1) throw new Error(`页面水平溢出 ${layout.documentWidth}>${width}`);
      record.layout=layout; await capture('saved-refresh');
      if(id==='mobile-light') {
        stage='api-restart';
        await docker(['restart',`${runId}-api`]); await waitReady();
        const recovered=page.waitForResponse(r=>r.request().method()==='GET'&&r.url().includes(`/entries/${entryId}/content`)&&r.ok());
        await page.reload({waitUntil:'domcontentloaded'}); await recovered;
        await expect(page.getByText(marker,{exact:true}).first()).toBeVisible();
        await assertTheme();
        result.restartRecovery={pass:true,method:'重启真实API容器后在原浏览器会话刷新，正文与主题保留'};
        await capture('server-restart');
      }
      await login();
      const body=await api(`/api/document-store/entries/${entryId}/content`);
      if(!body.content.includes(marker)) throw new Error('真实持久化回读不一致');
      if(record.pageErrors.length) throw new Error(`页面运行异常: ${record.pageErrors.join('; ')}`);
      record.unexpectedHttpErrors=record.requests.filter(r=>r.status>=400&&r.stage!=='api-restart');
      if(record.unexpectedHttpErrors.length) throw new Error('稳态路径出现非预期HTTP失败，见请求证据');
      record.persisted=true; record.pass=true;
      console.log(`${id}: 真实登录→首页→知识库→文档→保存→刷新通过`);
    } catch(e) { record.error=e.message;record.failureUrl=page.url();await page.screenshot({path:path.join(out,`${id}-failure.png`)});throw e; }
    finally {await context.close();await save();}
  }
  const anon=await browser.newContext();const page=await anon.newPage();
  await page.goto(base);await expect(page.getByRole('button',{name:'登录 / 注册',exact:true}).filter({visible:true}).first()).toBeVisible();
  await page.getByRole('button',{name:'登录 / 注册',exact:true}).filter({visible:true}).first().click();
  await expect(page.locator('input[autocomplete="username"]')).toBeVisible();
  const before=(await api(`/api/document-store/entries/${entryId}/content`)).content;
  const denied=await fetch(`${base}/api/document-store/entries/${entryId}/content`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:'不应写入'})});
  if(![401,403].includes(denied.status)||(await api(`/api/document-store/entries/${entryId}/content`)).content!==before)throw new Error('未登录写入未被阻止或数据改变');
  result.anonymous={pass:true,status:denied.status,publicRedirect:true,loginEntryAccessible:true,contentUnchanged:true};await anon.close();
} catch(e) {result.failure=e.message;console.error(e.message);}
finally {
  await browser?.close();
  for(const name of containers.reverse())await docker(['rm','-f','-v',name]).catch(e=>{result.failure??=e.message;});
  for(const name of networks.reverse())await docker(['network','rm',name]).catch(e=>{result.failure??=e.message;});
  await fs.rm(path.join(out,'api'),{recursive:true,force:true});
  result.finishedAt=new Date().toISOString();result.state=result.failure?'failed':'complete';
  result.pass=Boolean(!result.failure&&result.cases.length===4&&result.cases.every(c=>c.pass)&&result.anonymous?.pass&&result.restartRecovery?.pass);
  await save();
}
if(!result.pass)process.exitCode=1;
