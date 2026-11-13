import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { workload, digest, summarize, compare, capacity, executionErrors, buildIdentityErrors, browserScenarios, stats } from './metrics.mjs';
import { readProcesses, processTree } from './resources.mjs';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, args) => {
  if (index % 2 === 0) {
    if (!['--ref', '--out', '--profile', '--baseline', '--inject-ms', '--inject-browser-ms'].includes(value) || !args[index + 1])
      throw new Error('参数: --ref COMMIT --out DIR --profile normal|all --baseline FILE --inject-ms 350 --inject-browser-ms 10000');
    pairs.push([value.slice(2), args[index + 1]]);
  }
  return pairs;
}, []));
if (!['normal', 'all'].includes(options.profile ?? 'all')) throw new Error('未知负载配置');
const out = path.resolve(root, options.out ?? `work/performance/run-${Date.now()}`);
if (!out.startsWith(path.join(root, 'work') + path.sep)) throw new Error('输出目录必须位于仓库 work/ 内');
await fs.mkdir(out, { recursive: true });
try { await fs.access(path.join(out, 'result.json')); throw new Error('输出目录已有结果，请选择新目录'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const runId = `map-perf-${randomBytes(6).toString('hex')}`;
const command = async (bin, args, extra = {}) => {
  const { captureStderr, ...settings } = extra;
  const output = await exec(bin, args, { cwd: root, maxBuffer: 16 * 1024 * 1024, ...settings });
  return (output.stdout + (captureStderr ? output.stderr : '')).trim();
};
// Never use an inherited remote Docker endpoint/context or a caller-supplied URL.
const docker = args => command('docker', ['--host=unix:///var/run/docker.sock', ...args], {
  captureStderr: args[0] === 'logs',
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'].includes(key))),
});
const commit = await command('git', ['rev-parse', '--verify', `${options.ref ?? 'HEAD'}^{commit}`]);
const dotnet = process.env.DOTNET_BIN ?? 'dotnet';
const sdkVersion = await command(dotnet, ['--version']);
const sdkRoot = path.dirname(await fs.realpath(await command('sh', ['-c', 'command -v "$1"', 'sh', dotnet])));
const images = {
  // The official Mongo image supplies Ubuntu, ICU, OpenSSL and zlib. The API runs
  // with its entrypoint replaced and the installed .NET SDK mounted read-only.
  // This avoids a separate runtime image and uses the same SDK as the build.
  mongo: 'mongo:7@sha256:9896df581dfd0718b7abe112f4c37598d0986c54060e4ec1384997e6503c8c71',
  redis: 'redis:7-alpine@sha256:7f7d30b7fdd09467bac58198a1f166dd69789d348d4fe859cccb20e0cf287fbe',
  web: 'nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10',
};
const limits = { api: ['1', '1024m'], mongo: ['1', '768m'], redis: ['0.5', '256m'], web: ['0.5', '256m'] };
const contract = { schema: 4, buildMetadataVersion: 2, workload, limits, images, sdkVersion,
  nodeMajor: process.versions.node.split('.')[0], arch: os.arch(), cpu: os.cpus()[0].model,
  probe: digest(await fs.readFile(path.join(here, 'probe/Probe.cs'), 'utf8')),
  metricsCode: digest(await fs.readFile(path.join(here, 'metrics.mjs'), 'utf8')),
  resourcesCode: digest(await fs.readFile(path.join(here, 'resources.mjs'), 'utf8')),
  proxyRecipe: digest(await fs.readFile(path.join(here, 'nginx.conf'), 'utf8')),
  runtimeRecipe: digest(await fs.readFile(path.join(here, 'runtime.Dockerfile'), 'utf8')),
  workloadCode: digest(await fs.readFile(fileURLToPath(import.meta.url), 'utf8')) };
const result = { schema: 2, commit, harnessCommit: await command('git', ['rev-parse', 'HEAD']),
  environmentId: runId, startedAt: new Date().toISOString(), contract,
  execution: { profile: options.profile ?? 'all', state: 'running' },
  host: { cpus: os.cpus().length, memoryBytes: os.totalmem(), kernel: os.release() },
  injectionMs: Number(options['inject-ms'] ?? 0), phases: [],
  browser: { samples: Object.fromEntries(browserScenarios.map(name => [name, []])) }, resources: [],
  browserInjection: { delayMs: Number(options['inject-browser-ms'] ?? 0), applied: [] } };
if (!Number.isInteger(result.injectionMs) || result.injectionMs < 0 || result.injectionMs > 2000)
  throw new Error('注入延迟必须为0到2000毫秒');
if (!Number.isInteger(result.browserInjection.delayMs) || result.browserInjection.delayMs < 0 || result.browserInjection.delayMs > 15000)
  throw new Error('浏览器脚本交付注入延迟必须为0到15000毫秒');
const log = text => console.log(`[${new Date().toISOString()}] ${text}`);
const buildKey = digest({ commit, sdkVersion, arch: os.arch(), buildMetadataVersion: 2 }).slice(0, 20);
const build = path.join(root, 'work/performance', `build-${buildKey}`);
const buildCommand = async (bin, args, cwd, logName) => {
  const stream = createWriteStream(path.join(out, logName));
  const child = spawn(bin, args, { cwd, env: { ...process.env, CI: 'true', GITHUB_SHA: commit, VITE_BUILD_ID: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(stream); child.stderr.pipe(stream);
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => { stream.end(); code === 0 ? resolve() : reject(new Error(`${bin} 失败: ${logName} (${code})`)); });
  });
};
let base, token, browser, sampling = false, monitor;
const containers = [];
const networks = [];
const raw = createWriteStream(path.join(out, 'requests.ndjson'));
let activePhase = 'setup';
const sample = row => { raw.write(JSON.stringify({ ...row, phase: activePhase, at: new Date().toISOString() }) + '\n'); return row; };
async function api(route, method = 'GET', body, measuredName) {
  const start = performance.now();
  let row;
  try {
    const response = await fetch(new URL(route, base), {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000), redirect: 'error',
    });
    const json = await response.json();
    const timing = response.headers.get('server-timing') ?? '';
    const appMs = /(?:^|, )app;dur=([\d.]+)/.exec(timing)?.[1];
    const external = /external_http;dur=([\d.]+)/.exec(timing)?.[1];
    const isolated = response.headers.get('x-map-perf-isolated') === 'v1';
    row = { name: measuredName, ms: performance.now() - start, ok: response.ok && json.success === true && isolated,
      status: response.status, app: appMs === undefined ? undefined : Number(appMs),
      external: external === undefined ? undefined : Number(external) };
    if (!row.ok) throw new Error(`${method} ${route}: HTTP ${response.status} ${json.error?.code ?? '响应或隔离标记不合法'}`);
    if (measuredName) sample(row);
    return { data: json.data, row };
  } catch (error) {
    row = { ...row, name: measuredName, ms: performance.now() - start, ok: false, error: error.message };
    if (measuredName) sample(row);
    throw Object.assign(error, { sample: row });
  }
}
async function ready() {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const login = await api('/api/v1/auth/login', 'POST', { username: 'perfadmin', password: password, clientType: 'admin' });
      token = login.data.accessToken;
      await api('/api/document-store/stores');
      return;
    } catch {
      const state = JSON.parse(await docker(['inspect', '--format', '{{json .State}}', `${runId}-api`]));
      if (!state.Running) throw new Error(`API启动失败: exit=${state.ExitCode}，见api.log`);
      await pause(500);
    }
  }
  throw new Error('180秒内真实登录和知识库接口未就绪');
}
const password = `Perf_${randomBytes(18).toString('hex')}!`;
function documentContent(title) {
  const content = `# ${title}\n\nMAP性能样例\n\n` + '固定内容用于性能回归，不调用任何模型。\n'.repeat(100);
  return content + 'x'.repeat(workload.contentBytes - Buffer.byteLength(content));
}
const payload = documentContent('MAP性能样例');
const fixture = { stores: [], entries: [], writers: [] };
async function seed() {
  for (let s = 0; s < workload.stores; s++) {
    const store = (await api('/api/document-store/stores', 'POST', { name: `性能知识库-${s}`, isPublic: false })).data;
    fixture.stores.push(store.id);
    for (let e = 0; e < workload.documentsPerStore; e++) {
      const doc = (await api(`/api/document-store/stores/${store.id}/entries`, 'POST', {
        title: `性能文档-${s}-${e}`, sourceType: 'upload', contentType: 'text/markdown',
      })).data;
      await api(`/api/document-store/entries/${doc.id}/content`, 'PUT', { content: documentContent(`性能文档-${s}-${e}`) });
      fixture.entries.push(doc.id);
    }
    // Populate the actual recent-open ledger through the same store-open endpoint as the UI.
    await api(`/api/document-store/stores/${store.id}`);
  }
  // Match the UI's existing-document edit/save path. Give each VU a distinct
  // document so another user's writes cannot invalidate the readback assertion.
  // Creation is setup; disposal of this run's database is cleanup. Neither
  // document creation nor the store-level recycle-bin lease is timed as writing.
  for (let vu = 0; vu < workload.writerDocuments; vu++) {
    const doc = (await api(`/api/document-store/stores/${fixture.stores[vu % fixture.stores.length]}/entries`, 'POST', {
      title: `性能写入-${vu}`, sourceType: 'upload', contentType: 'text/markdown',
    })).data;
    fixture.writers.push(doc.id);
  }
  if (fixture.writers.length < Math.max(...workload.ramp.users) || new Set(fixture.writers).size !== fixture.writers.length)
    throw new Error('每个并发用户必须持有独立写入文档');
  await fs.writeFile(path.join(out, 'fixture.json'), JSON.stringify({ ...workload,
    actualContentBytes: Buffer.byteLength(payload), totalStores: fixture.stores.length,
    totalDocuments: fixture.entries.length + fixture.writers.length, writers: fixture.writers }, null, 2));
}
async function browserJourney(round) {
  browser = await chromium.launch({ executablePath: process.env.PERF_CHROMIUM_PATH || undefined, args: ['--no-proxy-server'] });
  contract.browserVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  // Block all non-local destinations, including browser-side font/CDN requests.
  const origin = new URL(base).origin;
  let stage = 'login';
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    // Delay delivery of the real, unchanged homepage bundle only in this local
    // browser. Server/API timing stays independent of this user-visible fault.
    if (url.origin === origin && stage === 'home' && /\/AgentLauncherPage-[^/]+\.js$/.test(url.pathname)
        && result.browserInjection.delayMs > 0) {
      result.browserInjection.applied.push({ round, stage, asset: url.pathname, delayMs: result.browserInjection.delayMs });
      await pause(result.browserInjection.delayMs);
    }
    return url.origin === origin || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  // Fresh accounts see the real onboarding overlay. Dismiss it through its UI,
  // rather than injecting storage flags or forcing clicks through the overlay.
  await page.addLocatorHandler(page.getByRole('button', { name: '我已学会', exact: true }), async () => {
    await page.getByRole('button', { name: '我已学会', exact: true }).click();
  });
  const requests = [];
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/')) requests.push({ path: url.pathname, status: response.status(), stage, round });
  });
  const timed = async (name, task) => {
    stage = name;
    const start = performance.now(); await task();
    result.browser.samples[name].push(performance.now() - start);
    result.browser[name] = stats(result.browser.samples[name]).p95;
    await page.screenshot({ path: path.join(out, `browser-${name}-${round}.png`) });
  };
  try {
    const loginPage = await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
    if (loginPage?.status() !== 200) throw new Error(`登录页面 HTTP ${loginPage?.status()}`);
    await page.locator('input[autocomplete="username"]').first().fill('perfadmin');
    await page.locator('input[type="password"]').first().fill(password);
    await timed('home', async () => {
      const home = page.waitForResponse(r => r.url().includes('/api/home/recent-work') && r.ok());
      await page.getByRole('button', { name: '进入控制台', exact: true }).click();
      await page.waitForURL(url => !url.pathname.includes('/login'));
      await home;
      // The seeded recent-work cards must be usable in the actual homepage,
      // rather than treating the already-visible application sidebar as ready.
      await expect(page.locator('[aria-labelledby="home-continue-heading"] .home-desk-work-list button').first()).toBeVisible();
      await expect(page.getByText('知识库', { exact: true }).first()).toBeVisible();
    });
    await timed('knowledge-list', async () => {
      await page.getByText('知识库', { exact: true }).first().click();
      await expect(page.getByText('性能知识库-0', { exact: true }).first()).toBeVisible();
    });
    await timed('document-open', async () => {
      await page.getByText('性能知识库-0', { exact: true }).first().click();
      await page.getByText('性能文档-0-0', { exact: true }).first().click();
      await expect(page.getByText('MAP性能样例', { exact: true }).first()).toBeVisible();
    });
    await timed('write', async () => {
      await page.getByRole('button', { name: '编辑文档', exact: true }).click();
      const source = page.getByRole('button', { name: /源码/ });
      if (await source.count()) await source.first().click();
      const editor = page.locator('textarea[placeholder*="正文"], textarea[placeholder*="在此编辑"]');
      await editor.fill('# 浏览器写入验收\n\nMAP无模型写入已持久化');
      const saved = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith('/content') && r.ok());
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await saved;
      await expect(page.getByText('MAP无模型写入已持久化', { exact: true }).first()).toBeVisible();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByText('MAP无模型写入已持久化', { exact: true }).first()).toBeVisible();
      const persisted = (await api(`/api/document-store/entries/${fixture.entries[0]}/content`)).data;
      if (!persisted.content.includes('MAP无模型写入已持久化')) throw new Error('浏览器写入未持久化');
    });
  } catch (error) {
    await page.screenshot({ path: path.join(out, 'browser-failure.png') });
    await fs.writeFile(path.join(out, 'browser-failure.html'), await page.content());
    throw error;
  } finally {
    result.browser.requests = [...(result.browser.requests ?? []), ...requests];
    await browser.close(); browser = null;
    // Restore the deterministic read fixture before warm-up and measurement.
    await api(`/api/document-store/entries/${fixture.entries[0]}/content`, 'PUT', { content: documentContent('性能文档-0-0') });
  }
}
async function journey(vu, phase, iteration) {
  const rows = [], started = performance.now();
  let writeStart;
  const measured = async (name, route, method, body) => {
    try { const r = await api(route, method, body, name); rows.push(r.row); return r.data; }
    catch (error) { rows.push(error.sample); throw error; }
  };
  try {
    const home = await measured('home', '/api/home/recent-work?limit=24');
    if (!Array.isArray(home.items)) throw new Error('首页结构不正确');
    const list = await measured('knowledge-list', '/api/document-store/stores/with-preview?pageSize=500');
    if (!JSON.stringify(list).includes('性能知识库-0')) throw new Error('知识库内容缺失');
    const id = fixture.entries[(vu + iteration) % fixture.entries.length];
    const doc = await measured('document-open', `/api/document-store/entries/${id}/content`);
    if (!doc.content?.includes('MAP性能样例')) throw new Error('文档正文不正确');
    writeStart = performance.now();
    const docId = fixture.writers[vu];
    const marker = `${phase}-${vu}-${iteration}`;
    const content = payload.slice(0, -marker.length) + marker;
    await measured('write-save', `/api/document-store/entries/${docId}/content`, 'PUT', { content });
    const read = await measured('write-readback', `/api/document-store/entries/${docId}/content`);
    if (!read.content.endsWith(marker)) throw new Error('写后读取不一致');
    const versions = await measured('write-versions', `/api/document-store/entries/${docId}/versions`);
    if (versions.total < 1 || !versions.items?.[0]?.id) throw new Error('写入版本未生成');
    rows.push(sample({ name: 'write', ms: performance.now() - writeStart, ok: true }));
    rows.push(sample({ name: 'journey', ms: performance.now() - started, ok: true }));
  } catch (error) {
    if (writeStart !== undefined)
      rows.push(sample({ name: 'write', ms: performance.now() - writeStart, ok: false, error: error.message }));
    rows.push(sample({ name: 'journey', ms: performance.now() - started, ok: false, error: error.message }));
  }
  return rows;
}
async function phase(name, users, seconds, intervalMs) {
  activePhase = name;
  log(`${name}: ${users} VU, ${seconds}s`);
  const rows = [], start = performance.now();
  const startResources = result.resources.length;
  await Promise.all(Array.from({ length: users }, async (_, vu) => {
    let iteration = 0;
    while (performance.now() - start < seconds * 1000) {
      const due = performance.now() + intervalMs;
      rows.push(...await journey(vu, name, iteration++));
      if (intervalMs) await pause(Math.max(0, due - performance.now()));
    }
  }));
  const actualSeconds = (performance.now() - start) / 1000;
  const entry = { name, users, seconds: actualSeconds, metrics: summarize(rows, actualSeconds),
    resourceSampleStart: startResources, resourceSampleEnd: result.resources.length };
  result.phases.push(entry);
  log(`${name}: journey p95=${entry.metrics.journey.client.p95.toFixed(1)}ms, errors=${entry.metrics.journey.errors}`);
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
}

try {
  await docker(['info', '--format', '{{.ServerVersion}}']);
  try { await fs.access(path.join(build, 'complete')); log(`复用提交构建 ${commit.slice(0, 12)}`); }
  catch {
    log(`构建指定提交 ${commit.slice(0, 12)}`);
    await fs.mkdir(build, { recursive: true });
    const archive = path.join(build, 'source.tar');
    await command('git', ['archive', '--format=tar', `--output=${archive}`, commit]);
    await command('tar', ['-xf', archive, '-C', build]);
    await buildCommand(dotnet, ['publish', 'prd-api/src/PrdAgent.Api/PrdAgent.Api.csproj', '-c', 'Release', `-p:SourceRevisionId=${commit}`, '-o', path.join(build, 'api')], build, 'api-build.log');
    await buildCommand('pnpm', ['install', '--frozen-lockfile'], path.join(build, 'prd-admin'), 'web-install.log');
    await buildCommand('pnpm', ['build'], path.join(build, 'prd-admin'), 'web-build.log');
    await fs.writeFile(path.join(build, 'complete'), commit);
  }
  // Managed environments may start with umask 077; Nginx's worker must read
  // the public static bundle mounted at its document root.
  await command('chmod', ['-R', 'a+rX', path.join(build, 'prd-admin/dist')]);
  await buildCommand(dotnet, ['publish', path.join(here, 'probe/Map.PerformanceProbe.csproj'), '-c', 'Release', '-o', path.join(out, 'probe')], root, 'probe-build.log');
  const apiDir = path.join(out, 'api');
  await fs.cp(path.join(build, 'api'), apiDir, { recursive: true });
  await fs.copyFile(path.join(out, 'probe/Map.PerformanceProbe.dll'), path.join(apiDir, 'Map.PerformanceProbe.dll'));
  await fs.copyFile(path.join(out, 'probe/Map.PerformanceProbe.deps.json'), path.join(apiDir, 'Map.PerformanceProbe.deps.json'));
  for (const image of Object.values(images)) await docker(['image', 'inspect', image]).catch(() => docker(['pull', image]));
  const runtimeTag = `map-performance-runtime:${contract.runtimeRecipe.slice(0, 16)}`;
  await docker(['build', '-f', path.join(here, 'runtime.Dockerfile'), '-t', runtimeTag, here]);
  contract.runtimeImage = JSON.parse(await docker(['image', 'inspect', runtimeTag]))[0].Id;
  await docker(['network', 'create', '--internal', '--label', `map-perf=${runId}`, runId]);
  networks.push(runId);
  // Docker 29 does not publish ports for a container with only internal networks.
  // Only the fixed-route static Web proxy joins this second, dedicated network.
  await docker(['network', 'create', '--label', `map-perf=${runId}`, `${runId}-ingress`]);
  networks.push(`${runId}-ingress`);
  const network = JSON.parse(await docker(['network', 'inspect', runId]))[0];
  if (!network.Internal) throw new Error('测试网络未隔离');
  for (const [role, image] of [['mongo', images.mongo], ['redis', images.redis], ['api', runtimeTag], ['web', images.web]]) {
    const name = `${runId}-${role}`;
    const args = ['run', '-d', '--name', name, '--label', `map-perf=${runId}`, '--network', runId,
      '--network-alias', role, '--cpus', limits[role][0], '--memory', limits[role][1], '--memory-swap', limits[role][1],
      '-e', 'HTTP_PROXY=', '-e', 'HTTPS_PROXY=', '-e', 'ALL_PROXY=', '-e', 'http_proxy=', '-e', 'https_proxy=', '-e', 'all_proxy='];
    if (role === 'api') args.push('--user', `${process.getuid()}:${process.getgid()}`, '--entrypoint', '/dotnet/dotnet', '-w', '/app',
      '-v', `${sdkRoot}:/dotnet:ro`, '-v', `${apiDir}:/app`, '-e', 'DOTNET_ROOT=/dotnet',
      '-e', 'ASPNETCORE_URLS=http://+:8080', '-e', 'ASPNETCORE_ENVIRONMENT=Testing', '-e', `GIT_COMMIT=${commit}`,
      '-e', 'MongoDB__ConnectionString=mongodb://mongo:27017', '-e', 'MongoDB__DatabaseName=map_performance',
      '-e', 'LlmGateway__MongoConnectionString=mongodb://mongo:27017', '-e', 'LlmGateway__DatabaseName=perf_gateway',
      '-e', 'Redis__ConnectionString=redis:6379', '-e', 'MAP_INITIAL_ADMIN_USERNAME=perfadmin', '-e', `MAP_INITIAL_ADMIN_PASSWORD=${password}`,
      '-e', `Jwt__Secret=${randomBytes(32).toString('hex')}`, '-e', 'ASSETS_PROVIDER=local', '-e', 'ASSETS_LOCAL_DIR=/tmp/assets',
      '-e', 'LlmGateway__ServeBaseUrl=http://127.0.0.1:9', '-e', 'MAP_PERF_ISOLATED=1',
      '-e', `MAP_PERF_DELAY_MS=${result.injectionMs}`, '-e', 'ASPNETCORE_HOSTINGSTARTUPASSEMBLIES=Map.PerformanceProbe',
      '-e', 'DOTNET_ADDITIONAL_DEPS=/app/Map.PerformanceProbe.deps.json');
    if (role === 'web') args.push('--network', `${runId}-ingress`, '-p', '127.0.0.1::80',
      '-v', `${path.join(build, 'prd-admin/dist')}:/usr/share/nginx/html:ro`, '-v', `${path.join(here, 'nginx.conf')}:/etc/nginx/nginx.conf:ro`);
    args.push(image);
    if (role === 'api') args.push('PrdAgent.Api.dll');
    await docker(args); containers.push(name);
  }
  const web = JSON.parse(await docker(['inspect', `${runId}-web`]))[0];
  base = `http://127.0.0.1:${web.NetworkSettings.Ports['80/tcp'][0].HostPort}`;
  result.isolation = { networkInternal: true, publishedAddress: base, freshDatabases: true, persistentVolumes: false };
  const roots = JSON.parse(await docker(['inspect', ...containers])).map(c => ({
    role: c.Name.split('-').at(-1), pid: c.State.Pid,
  }));
  contract.effectiveCgroups = {};
  for (const name of containers) {
    const role = name.split('-').at(-1);
    const values = (await docker(['exec', name, 'sh', '-c', 'cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max'])).split('\n');
    contract.effectiveCgroups[role] = { cpuMax: values[0], memoryMax: values[1] };
  }
  result.resourceAccounting = { source: 'Linux /proc process tree; CPU ticks and summed RSS',
    requestedLimitsEnforced: Object.entries(limits).every(([role, [cpu, memory]]) => {
      const actual = contract.effectiveCgroups[role];
      const [quota, period] = actual.cpuMax.split(' ').map(Number);
      return quota / period === Number(cpu) && actual.memoryMax === String(Number.parseInt(memory, 10) * 1024 ** 2);
    }),
    clockTicksPerSecond: Number(await command('getconf', ['CLK_TCK'])),
    pageBytes: Number(await command('getconf', ['PAGESIZE'])) };
  if (!result.resourceAccounting.requestedLimitsEnforced)
    log('Docker未实施声明的容器配额；使用独立进程树资源统计，容量仅适用于记录的共享cgroup');
  await ready(); log('真实登录、知识库接口就绪，准备固定数据');
  const versionResponse = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (!versionResponse.ok) throw new Error(`API版本对账接口失败: HTTP ${versionResponse.status}`);
  const version = await versionResponse.json();
  const indexResponse = await fetch(`${base}/`, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (!indexResponse.ok) throw new Error(`Web版本对账页面失败: HTTP ${indexResponse.status}`);
  const indexHtml = await indexResponse.text();
  result.buildIdentity = { api: { actualCommit: version.actualCommit, expectedCommit: version.expectedCommit, commitMatch: version.commitMatch },
    webEntries: [...indexHtml.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map(match => match[1]) };
  const identityErrors = buildIdentityErrors(commit, result.buildIdentity);
  if (identityErrors.length) throw new Error(identityErrors.join('; '));
  log(`API实际编译SHA、运行声明SHA与Web构建SHA已对账: ${commit.slice(0, 12)}`);
  // All VUs share this isolated account. Keep the actual Redis admission path,
  // but raise only this disposable instance's limits through the supported API
  // so fixture creation and a shared identity do not masquerade as CPU capacity.
  result.admission = { original: (await api('/api/v1/admin/rate-limit/global')).data, applied: workload.rateLimit };
  await api('/api/v1/admin/rate-limit/global', 'PUT', workload.rateLimit);
  await seed();
  for (let round = 1; round <= workload.browserRepetitions; round++) {
    await browserJourney(round); log(`浏览器核心路径已通过 ${round}/${workload.browserRepetitions}`);
  }
  result.browser.pass = true;
  activePhase = 'warmup';
  for (let i = 0; i < 5; i++) {
    const warmed = await journey(0, 'warmup', i);
    if (warmed.some(row => !row.ok)) throw new Error(`预热路径失败: ${warmed.find(row => !row.ok).error}`);
  }
  sampling = true;
  monitor = (async () => {
    const previous = new Map();
    while (sampling) {
      const table = await readProcesses();
      const now = performance.now();
      const samples = roots.map(({ role, pid }) => {
        const current = processTree(table, pid), last = previous.get(role);
        if (!current.pids.length) throw new Error(`${role}进程已退出，无法采样`);
        const cpuPercent = last ? Math.max(0, current.ticks - last.ticks) / result.resourceAccounting.clockTicksPerSecond
          / ((now - last.at) / 1000) * 100 : null;
        previous.set(role, { ...current, at: now });
        return { role, cpuPercent, rssBytes: current.rssPages * result.resourceAccounting.pageBytes,
          cpuSeconds: current.ticks / result.resourceAccounting.clockTicksPerSecond, pids: current.pids };
      });
      result.resources.push({ at: new Date().toISOString(), samples });
      await pause(1000);
    }
  })().catch(error => { sampling = false; result.failure ??= `资源采样失败: ${error.message}`; });
  await phase('normal', workload.normal.users, workload.normal.seconds, workload.normal.intervalMs);
  if ((options.profile ?? 'all') === 'all') {
    for (const users of workload.ramp.users) {
      await phase(`ramp-${users}`, users, workload.ramp.seconds, 0);
      if (result.phases.at(-1).metrics.journey.errorRate > .1) break;
    }
    await phase('soak', workload.soak.users, workload.soak.seconds, workload.soak.intervalMs);
  }
  result.capacity = capacity(result.phases);
  if (!options.baseline && result.phases.some(p => !p.name.startsWith('ramp-') && Object.values(p.metrics).some(m => m.errors)))
    throw new Error('正常负载或持续运行发生错误');
} catch (error) {
  result.failure = error.stack;
  log(`失败: ${error.message}`);
} finally {
  sampling = false;
  await monitor?.catch(error => { result.failure ??= `资源采样失败: ${error.message}`; });
  await browser?.close();
  for (const name of containers) {
    // Logs contain no request credentials from this runner. Do not archive Docker inspect/env.
    await fs.writeFile(path.join(out, `${name.split('-').at(-1)}.log`), await docker(['logs', '--tail', '300', name]).catch(() => '日志不可用'));
  }
  raw.end();
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  for (const name of containers.reverse()) await docker(['rm', '-f', '-v', name]).catch(() => {
    result.failure ??= `本次测试容器清理失败: ${name}`;
  });
  for (const name of networks.reverse()) await docker(['network', 'rm', name]).catch(() => {
    result.failure ??= `本次测试网络清理失败: ${name}`;
  });
  // Do not leave binaries/logs with ephemeral secrets in report artifacts.
  await fs.rm(apiDirSafe(), { recursive: true, force: true }).catch(error => {
    result.failure ??= `清理构建目录失败: ${error.message}`;
  });
  result.finishedAt = new Date().toISOString();
  result.execution.state = result.failure ? 'failed' : 'complete';
  const incomplete = executionErrors(result);
  if (incomplete.length && !result.failure) {
    result.failure = incomplete.join('; ');
    result.execution.state = 'failed';
  }
  if (options.baseline) {
    try {
      result.comparison = compare(result, JSON.parse(await fs.readFile(path.resolve(root, options.baseline), 'utf8')));
    } catch (error) {
      result.failure ??= `读取或比较基线失败: ${error.message}`;
      result.execution.state = 'failed';
    }
  }
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
}
function apiDirSafe() { return path.join(out, 'api'); }
log(`结果: ${path.join(out, 'result.json')}`);
if (result.failure || result.comparison?.pass === false) process.exitCode = 1;
