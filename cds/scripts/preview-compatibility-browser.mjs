import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { preparePreviewCompatibilityAssets } from '../dist/services/preview-compatibility-assets.js';
import { profileStoragePlan, withPreviewCompatibilityAssets } from '../dist/services/deployment-storage-plan.js';
import { nativeBindMountInspector } from '../dist/services/deployment-bind-mount-proof.js';

// Build the backend first. Run with a local Docker daemon and cached node:20-bookworm-slim.
const cds = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const repo = path.dirname(cds);
const runId = randomUUID().replaceAll('-', '');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-preview-compat-'));
const owner = [createHash('sha1').update(root).digest('hex').slice(0, 12), 'compat-probe', runId, 'cds'];
const ownership = 'cds.compat.probe=' + runId;
const records = [];
const images = [];
const containers = new Set();
const commands = [];
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const mount = (source, target) => `type=bind,src=${source},dst=${target},readonly`;

function image(version, extraAssets = {}) {
  const context = path.join(root, version);
  fs.mkdirSync(path.join(context, 'dist', 'assets'), { recursive: true });
  const href = name => `/assets/${name}-${version.repeat(8)}`;
  fs.writeFileSync(path.join(context, 'dist', 'index.html'), `<html><body><button>加载报告</button><article></article><script type="module" src="${href('entry')}.js"></script></body></html>`);
  fs.writeFileSync(path.join(context, 'dist', href('entry').slice(1) + '.js'), `
    document.querySelector('button').onclick = async () => {
      const { title } = await import('${href('report')}.js');
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = '${href('report')}.css';
      const ready = new Promise((resolve, reject) => { link.onload = resolve; link.onerror = reject; });
      document.head.append(link); await ready;
      document.querySelector('article').textContent = title;
    };
  `);
  fs.writeFileSync(path.join(context, 'dist', href('report').slice(1) + '.js'), `export const title = '报告 ${version}';`);
  fs.writeFileSync(path.join(context, 'dist', href('report').slice(1) + '.css'), `article { color: rgb(${version === 'a' ? '11, 22, 33' : '33, 22, 11'}); }`);
  for (const [name, contents] of Object.entries(extraAssets)) fs.writeFileSync(path.join(context, 'dist', 'assets', name), contents);
  fs.writeFileSync(path.join(context, 'Dockerfile'), `FROM node:20-bookworm-slim\nCOPY --chown=${process.getuid()}:${process.getgid()} dist /app/cds/web/dist\n`);
  const tag = `cds-preview-compat-probe:${runId}-${version}`;
  docker('build', '--pull=false', '--label', ownership, '-t', tag, context);
  const id = docker('image', 'inspect', '--format', '{{.Id}}', tag);
  images.push({ tag, id });
  return id;
}

async function prepare(imageId, prior, scope = owner.slice(1).join('/')) {
  const entry = { projectId: owner[1], id: owner[2], worktreePath: root, services: { cds: { servingRuntime: { containerId: prior } } } };
  const profile = { id: 'cds', projectId: owner[1], prebuiltImage: true, dockerImage: imageId, env: { CDS_PREVIEW_INSTANCE: '1' } };
  const assetDirectory = await preparePreviewCompatibilityAssets({ repo: root, entry, profile, scope, shell: {
    async exec(command, options) {
      commands.push(command);
      try {
        return { exitCode: 0, stdout: execFileSync('sh', ['-c', command], { encoding: 'utf8', timeout: options.timeout, stdio: ['ignore', 'pipe', 'pipe'] }) };
      } catch (error) {
        return { exitCode: error.status ?? 1, stdout: '', stderr: error.stderr };
      }
    },
  } });
  if (!assetDirectory) return undefined;
  const plan = withPreviewCompatibilityAssets(profileStoragePlan(entry, profile, {}), assetDirectory);
  return { assetDirectory, bind: plan.mounts[0], check: nativeBindMountInspector(plan) };
}

function stop(id) {
  assert.equal(docker('container', 'inspect', '--format', '{{index .Config.Labels "cds.compat.probe"}}', id), runId);
  docker('rm', '-f', id);
  containers.delete(id);
}

function start(id, port, compatibility) {
  compatibility?.check();
  const labels = ['cds.instance', 'cds.project.id', 'cds.branch.id', 'cds.profile.id'];
  const started = docker('run', '--pull=never', '--detach', '--cap-drop=ALL', '--memory=768m', '--cpus=1', '--pids-limit=64',
    '--user', `${process.getuid()}:${process.getgid()}`, '--env', 'CDS_PREVIEW_INSTANCE=1',
    '--label', ownership, '--label', 'cds.type=app', ...labels.flatMap((label, i) => ['--label', `${label}=${owner[i]}`]),
    '-p', `127.0.0.1:${port}:9900`, '--mount', mount(cds, '/code'),
    ...(compatibility ? ['--mount', mount(compatibility.bind.source, compatibility.bind.target)] : []), id,
    'node', '--input-type=module', '-e', `import express from '/code/node_modules/express/index.js';
    import { installSpaFallback } from '/code/dist/server.js';
    const app = express(); installSpaFallback(app, undefined, '/app/cds/web/dist'); app.listen(9900, '0.0.0.0');`);
  containers.add(started);
  return started;
}

async function ready(url, entry) {
  for (let i = 0; i < 50; i++) {
    const result = await fetch(url, { signal: AbortSignal.timeout(1000) }).catch(() => undefined);
    if (result?.ok && (await result.text()).includes(`/assets/entry-${entry.repeat(8)}.js`)) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`preview ${entry} did not start`);
}

async function lateLoad(page, version) {
  const previousNavigation = await page.evaluate(() => performance.timeOrigin);
  const css = page.waitForResponse(res => res.url().endsWith(`/assets/report-${version.repeat(8)}.css`));
  const js = page.waitForResponse(res => res.url().endsWith(`/assets/report-${version.repeat(8)}.js`));
  await page.getByRole('button', { name: '加载报告' }).click();
  const [cssResponse, jsResponse] = await Promise.all([css, js]);
  assert.equal(cssResponse.status(), 200);
  assert.equal(jsResponse.status(), 200);
  assert.match(cssResponse.headers()['content-type'], /^text\/css/);
  assert.match(jsResponse.headers()['content-type'], /javascript/);
  await page.getByText(`报告 ${version}`, { exact: true }).waitFor();
  assert.equal(await page.locator('article').evaluate(node => getComputedStyle(node).color), version === 'a' ? 'rgb(11, 22, 33)' : 'rgb(33, 22, 11)');
  assert.equal(await page.evaluate(() => performance.timeOrigin), previousNavigation);
  records.push({ version, js: 200, css: 200, sameDocument: true });
}

const server = net.createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const url = `http://127.0.0.1:${port}/branch-list`;
let browser;
const keepAlive = setInterval(() => {}, 1000);
try {
  fs.mkdirSync(path.join(root, 'scripts/lib'), { recursive: true });
  for (const file of ['cds-preview-assets.py', 'static-asset-retention.py', 'static-release.sh']) {
    fs.copyFileSync(path.join(repo, 'scripts/lib', file), path.join(root, 'scripts/lib', file));
  }
  const oldImage = image('a');
  const newImage = image('b');
  const differentBytes = image('c', { 'report-aaaaaaaa.js': 'export const title = "unexpected";' });
  const databasePayload = image('d', { WiredTiger: 'synthetic database marker' });
  let running = start(oldImage, port);
  await ready(url, 'a');
  console.error('旧容器与页面入口已就绪');
  // CI installs the Chromium build pinned by Playwright. Local probes can select another executable explicitly.
  const executablePath = process.env.CDS_CHROMIUM_PATH || undefined;
  browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
  const oldTab = await browser.newPage();
  await oldTab.goto(url);
  console.error('浏览器已打开旧标签页');
  assert.equal(await prepare(newImage, running, 'other-project/other-branch/cds'), undefined);
  assert.equal(commands.length, 0);
  const next = await prepare(newImage, running);
  const scopeDigest = createHash('sha256').update(owner.join('\0')).digest('hex');
  const exporterName = 'cds-preview-assets-' + scopeDigest;
  const priorExporter = docker('create', '--name', exporterName, '--network=none', '--read-only', '--label', ownership,
    '--label', `cds.preview-assets.export=${scopeDigest}`, '--label', `cds.preview-assets.image=${newImage}`, newImage);
  containers.add(priorExporter);
  await prepare(newImage, running);
  assert.equal(docker('ps', '-aq', '--filter', `name=^/${exporterName}$`), '');
  containers.delete(priorExporter);
  const unknownExporter = docker('create', '--name', exporterName, '--network=none', '--label', ownership, newImage);
  containers.add(unknownExporter);
  await assert.rejects(prepare(newImage, running), /未能确认预览静态兼容资产/);
  assert.equal(docker('container', 'inspect', '--format', '{{.Id}}', unknownExporter), unknownExporter);
  stop(unknownExporter);
  await assert.rejects(prepare(differentBytes, running), /未能确认预览静态兼容资产/);
  await assert.rejects(prepare(databasePayload, running), /未能确认预览静态兼容资产/);
  await ready(url, 'a');
  const assetsBefore = fs.statSync(next.assetDirectory);
  assert.equal((await prepare(newImage)).assetDirectory, next.assetDirectory, 'same image must reuse the existing generation');
  assert.equal(fs.statSync(next.assetDirectory).ino, assetsBefore.ino);
  const moved = next.assetDirectory + '.moved';
  fs.renameSync(next.assetDirectory, moved);
  fs.symlinkSync(root, next.assetDirectory);
  try { assert.throws(next.check, /identity-unconfirmed/); }
  finally { fs.unlinkSync(next.assetDirectory); fs.renameSync(moved, next.assetDirectory); }
  stop(running);
  running = start(newImage, port, next);
  await ready(url, 'b');
  assert.equal(docker('container', 'inspect', '--format', '{{range .Mounts}}{{if eq .Destination "/app/cds/web/dist.previous/assets"}}{{.RW}}{{end}}{{end}}', running), 'false');
  await lateLoad(oldTab, 'a');
  const newTab = await browser.newPage({ hasTouch: true, isMobile: true });
  await newTab.goto(url);
  const rollback = await prepare(oldImage, running);
  const olderModule = 'report-aaaaaaaa.js';
  assert.equal(fs.statSync(path.join(next.assetDirectory, olderModule)).ino, fs.statSync(path.join(rollback.assetDirectory, olderModule)).ino);
  stop(running);
  running = start(oldImage, port, rollback);
  await ready(url, 'a');
  await lateLoad(newTab, 'b');
  const missing = await fetch(new URL('/assets/unknown-00000000.js', url));
  assert.equal(missing.status, 404);
  assert.doesNotMatch(missing.headers.get('content-type') || '', /text\/html/);
  const protectedAsset = path.join(rollback.assetDirectory, 'report-aaaaaaaa.js');
  const protectedBytes = fs.readFileSync(protectedAsset);
  fs.writeFileSync(protectedAsset, 'corrupt test fixture');
  await assert.rejects(prepare(oldImage), /未能确认预览静态兼容资产/);
  assert.equal(fs.readFileSync(protectedAsset, 'utf8'), 'corrupt test fixture');
  fs.writeFileSync(protectedAsset, protectedBytes);
  records.push({ changedAssetReuseRefused: true, missingAsset404: true, readOnlyMount: true, sameImageReused: true,
    rollbackAssetLinked: true, unrelatedScopeUntouched: true, replacedDirectoryRefused: true, collisionAndDataPayloadRefusedBeforeReplacement: true,
    verifiedAbandonedExporterRetired: true, unknownExporterRetained: true });
} finally {
  clearInterval(keepAlive);
  if (browser) await browser.close();
  for (const id of containers) stop(id);
  for (const { tag, id } of images) {
    assert.equal(docker('image', 'inspect', '--format', '{{.Id}}', tag), id);
    assert.equal(docker('image', 'inspect', '--format', '{{index .Config.Labels "cds.compat.probe"}}', id), runId);
    docker('image', 'rm', tag);
  }
  fs.rmSync(root, { recursive: true });
}
console.log(JSON.stringify({ compatibilityDays: 30, actualDocker: true, actualChromium: true, observations: records }));
