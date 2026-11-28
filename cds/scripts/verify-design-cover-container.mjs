import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesignAcceptanceContainer, createDesignCoverContainer, createDesignHandoffContainer, createDesignReferenceContainer } from '../dist/services/design-cover-container.js';
import { designPngDimensions } from '../dist/services/design-package.js';
import { IsolatedShellExecutor } from '../dist/services/isolated-shell-executor.js';
import { ShellExecutor } from '../dist/services/shell-executor.js';

const image = process.argv[2];
assert(image, 'Pass the image for this build');
const shell = new IsolatedShellExecutor(new ShellExecutor(), { isolatedLane: 'operation', concurrency: 2, reservedCleanup: 1 });
await shell.start();
try {
  await verify();
} finally {
  await shell.close();
}

async function verify() {
  let attaches = 0;
  const checkedShell = {
    async exec(command, options) {
      if (command.startsWith('docker start ')) attaches++;
      const result = await shell.exec(command, options);
      if (command.startsWith('docker create ') && result.exitCode === 0) {
        const id = result.stdout.trim();
        assert.match(id, /^[a-f0-9]{64}$/);
        const inspected = await shell.exec('docker inspect ' + id, { timeout: 5000 });
        assert.equal(inspected.exitCode, 0);
        const [container] = JSON.parse(inspected.stdout);
        const host = container.HostConfig;
        assert.equal(container.Config.User, '1000:1000');
        assert.equal(host.NetworkMode, 'none');
        assert.equal(host.ReadonlyRootfs, true);
        assert.equal(host.Privileged, false);
        assert.ok(host.CapDrop.includes('ALL'));
        assert.ok(host.SecurityOpt.some(value => /^no-new-privileges(?:[=:]true)?$/.test(value)));
        assert.ok(container.Mounts.every(mount => mount.Type === 'tmpfs'));
        assert.equal(host.LogConfig.Type, 'none');
        assert.equal(host.PidsLimit, 256);
        assert.equal(host.Memory, 768 * 1024 * 1024);
        assert.equal(host.MemorySwap, host.Memory);
        assert.equal(host.NanoCpus, 1_000_000_000);
      }
      return result;
    },
  };
  const resolveImage = async () => image;
  const capture = createDesignCoverContainer(checkedShell, resolveImage);
  const prototype = Buffer.from(`<!doctype html><html><body>
  <main hidden><h1>CDS 封面验证</h1><button type="button">显示首页</button></main>
  <script>
    const main = document.querySelector('main');
    if (location.hash === '#/home') main.hidden = false;
    document.querySelector('button').addEventListener('click', async () => {
      try { await fetch('https://example.invalid/cover'); }
      catch { main.dataset.coverReady = CSS.supports('display', 'grid') ? 'true' : 'false'; }
    });
  </script>
</body></html><!-- ${randomBytes(1536 * 1024).toString('base64')} -->`);
  const screen = { id: 'home', name: '首页', route: '#/home', viewport: 'desktop', themes: ['light', 'dark'], impl: null,
    entryActions: ['button'], entryReadySelector: '[data-cover-ready="true"]' };
  const bytes = await capture(prototype, { screen, theme: 'light' });
  assert(bytes, 'The disposable image must generate a cover from the declared entry');
  assert.deepEqual(designPngDimensions(bytes), { width: 1280, height: 800 });
  console.log('Verified a PNG cover using the published worker and offline prototype entry');

  const reference = createDesignReferenceContainer(checkedShell, resolveImage);
  const phone = { ...screen, id: 'phone', name: '手机首页', viewport: 'phone' };
  const refs = [];
  const beforeGallery = attaches;
  for await (const row of reference(prototype, [screen, phone].flatMap(scene =>
    scene.themes.map(theme => ({ screen: scene, theme }))))) {
    assert.deepEqual(designPngDimensions(row.bytes), row.screen.viewport === 'phone'
      ? { width: 375, height: 812 } : { width: 1280, height: 800 });
    refs.push(`${row.screen.id}/${row.theme}`);
  }
  assert.deepEqual(refs, ['home/light', 'home/dark', 'phone/light', 'phone/dark']);
  assert.equal(attaches - beforeGallery, 1, 'The production executor must complete the full gallery batch');
  const check = createDesignHandoffContainer(checkedShell, resolveImage);
  const cases = [
    { id: 'success', title: '显示实际文字', screenId: 'home', theme: 'light', ruleIds: ['A-01'],
      steps: [{ action: 'expect', check: 'text', selector: 'h1', equals: 'CDS 封面验证' }] },
    { id: 'blocked', title: '检测不符的内容', screenId: 'home', theme: 'dark', ruleIds: ['A-01'],
      steps: [{ action: 'expect', check: 'text', selector: 'h1', equals: '本内容不在原型中' }] },
  ];
  const receipt = await check({ prototype, screens: [screen], cases });
  assert.deepEqual(receipt, [
    { caseId: 'success', status: 'passed' },
    { caseId: 'blocked', status: 'failed', step: 1, code: 'expectation' },
  ]);
  console.log('Verified gallery batches and handoff outcomes using the same isolated renderer');
  await verifyInstalledAcceptance(checkedShell, resolveImage);
}

function installedCaptureFixture(commit) {
  const demo = 'fixture-evidence-demo';
  const projectId = 'fixture-evidence-project';
  const auth = { authenticated: true, mode: 'disabled' };
  const fixtures = {
    '/api/auth/status': auth,
    '/api/auth/public-status': auth,
    '/api/instance-mode': { previewInstance: false },
    '/api/projects': { projects: [{ id: demo, name: 'Fixture project' }] },
    ['/api/projects/' + demo + '/design']: {
      projectId: demo, designs: [], frameworks: [], permissions: { write: false, review: false, visual: false },
    },
  };
  const prototype = Buffer.from(`<!doctype html><html><body>
    <main data-cds-design-ready="fixture"><h1>Fixture design library</h1></main>
    <script>
      const fixtures = ${JSON.stringify(fixtures)};
      window.fetch = async path => {
        const key = new URL(path, location.href).pathname;
        return Object.hasOwn(fixtures, key)
          ? new Response(JSON.stringify(fixtures[key]), { headers: { 'content-type': 'application/json' } })
          : new Response('', { status: 404 });
      };
    </script>
  </body></html>`);
  const screen = { id: 'fixture-library', name: 'Fixture design library', route: '#/design?project=' + demo,
    viewport: 'desktop', themes: ['light'], impl: '/design?project=' + projectId,
    entryReadySelector: '[data-cds-design-ready="fixture"]' };
  return { prototype, screen, theme: 'light', commit, projectId, rules: [],
    version: { createdAt: '2026-11-28T00:00:00Z', delivery: { files: [{ path: 'src/fixtures.ts' }, { path: 'src/data-design.ts' }] } } };
}

async function verifyInstalledAcceptance(checkedShell, resolveImage) {
  const { sha } = JSON.parse(await readFile(new URL('../cds-prebuilt-manifest.json', import.meta.url), 'utf8'));
  const webDist = fileURLToPath(new URL('../web/dist', import.meta.url));
  const capture = createDesignAcceptanceContainer(checkedShell, resolveImage, webDist);
  const fixture = installedCaptureFixture(sha);
  const pair = await capture(fixture);
  assert.deepEqual(designPngDimensions(pair.reference), { width: 1280, height: 800 });
  assert.deepEqual(designPngDimensions(pair.implementation), { width: 1280, height: 800 });
  assert.match(pair.fixtureDigest, /^[a-f0-9]{64}$/);
  await assert.rejects(capture({ ...fixture, commit: '0'.repeat(40) }), { code: 'design_capture_commit_changed' });
  const mismatchedBuild = await mkdtemp(path.join(os.tmpdir(), 'cds-evidence-mismatch-'));
  try {
    await writeFile(path.join(mismatchedBuild, '.build-sha'), sha + '\n');
    await writeFile(path.join(mismatchedBuild, 'index.html'), '<!doctype html><title>Different deployed build</title>');
    const mismatched = createDesignAcceptanceContainer(checkedShell, resolveImage, mismatchedBuild);
    await assert.rejects(mismatched(fixture), { code: 'design_capture_build_mismatch' });
  } finally {
    await rm(mismatchedBuild, { force: true, recursive: true });
  }
  console.log('Verified paired acceptance of the deployed frontend, offline and pinned to the same build bytes');
}
