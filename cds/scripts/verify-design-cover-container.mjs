import assert from 'node:assert/strict';
import { createDesignCoverContainer, createDesignHandoffContainer, createDesignReferenceContainer } from '../dist/services/design-cover-container.js';
import { designPngDimensions } from '../dist/services/design-package.js';
import { ShellExecutor } from '../dist/services/shell-executor.js';

const image = process.argv[2];
assert(image, 'Pass the image for this build');
const shell = new ShellExecutor();
const checkedShell = {
  async exec(command, options) {
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
</body></html>`);
const screen = { id: 'home', name: '首页', route: '#/home', viewport: 'desktop', themes: ['light', 'dark'], impl: null,
  entryActions: ['button'], entryReadySelector: '[data-cover-ready="true"]' };
const bytes = await capture(prototype, { screen, theme: 'light' });
assert(bytes, 'The disposable image must generate a cover from the declared entry');
assert.deepEqual(designPngDimensions(bytes), { width: 1280, height: 800 });
console.log('Verified a PNG cover using the published worker and offline prototype entry');

const reference = createDesignReferenceContainer(checkedShell, resolveImage);
const refs = [];
for await (const row of reference(prototype, [{ screen, theme: 'light' }, { screen, theme: 'dark' }])) {
  assert.deepEqual(designPngDimensions(row.bytes), { width: 1280, height: 800 });
  refs.push(row.theme);
}
assert.deepEqual(refs, ['light', 'dark']);
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
