import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { it, expect } from 'vitest';

it('真实预构建在没有源码目录时也可导入快照、通知、原型预览和验收门禁', () => {
  const cdsRoot = fileURLToPath(new URL('../..', import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-source-free-import-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    fs.symlinkSync(path.join(cdsRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    const dist = path.join(root, 'dist');
    const build = spawnSync(process.execPath, [path.join(cdsRoot, 'scripts/build-dist-esbuild.mjs')], {
      cwd: cdsRoot, env: { ...process.env, OUT_DIR: dist }, encoding: 'utf8', timeout: 30_000,
    });
    expect(build.status, build.stderr).toBe(0);
    expect(fs.existsSync(path.join(root, 'src'))).toBe(false);
    const moduleUrl = (file: string) => JSON.stringify(pathToFileURL(path.join(dist, file)).href);
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const seed = await import(${moduleUrl('services/preview-instance-seed.js')});
      if (typeof seed.seedPreviewInstanceSnapshot !== 'function') process.exit(2);
      const notifications = await import(${moduleUrl('shared/notification-templates.js')});
      if (notifications.renderNotification('MSG-02', { environment: 'test', system: 'cds' }).sentence !== '测试 CDS 手机通知测试') process.exit(3);
      const prototype = await import(${moduleUrl('services/design-prototype.js')});
      if (!prototype.designPrototypeCsp.includes('sandbox allow-scripts')
        || !prototype.decorateDesignPrototype('<html><head></head></html>').includes('cds-design-entry-result')) process.exit(4);
      const acceptance = await import(${moduleUrl('shared/design-acceptance-standard.mjs')});
      if (acceptance.designAcceptancePolicy.gate !== 'G-11'
        || !acceptance.inspectDesignAcceptance({}).some(issue => issue.code === 'missing_acceptance_plan')) process.exit(5);
    `], { cwd: root, encoding: 'utf8', timeout: 20_000 });
    expect(imported.status, imported.stderr).toBe(0);
    expect(fs.readFileSync(path.join(dist, 'shared/notification-templates.json'))).toEqual(fs.readFileSync(path.join(cdsRoot, 'src/shared/notification-templates.json')));
    expect(fs.readFileSync(path.join(dist, 'services/preview-demo-snapshot.json')))
      .toEqual(fs.readFileSync(path.join(cdsRoot, 'src/services/preview-demo-snapshot.json')));
    expect(fs.readFileSync(path.join(dist, 'shared/design-preview-contract.json')))
      .toEqual(fs.readFileSync(path.join(cdsRoot, 'src/shared/design-preview-contract.json')));
    expect(fs.readFileSync(path.join(dist, 'shared/design-acceptance-policy.json')))
      .toEqual(fs.readFileSync(path.join(cdsRoot, 'src/shared/design-acceptance-policy.json')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 60_000);
