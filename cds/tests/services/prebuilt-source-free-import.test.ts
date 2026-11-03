import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { it, expect } from 'vitest';

it('真实预构建在完全没有源码目录时也可导入快照模块', () => {
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
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const m=await import(${JSON.stringify(pathToFileURL(path.join(dist, 'services/preview-instance-seed.js')).href)});if(typeof m.seedPreviewInstanceSnapshot!=='function')process.exit(2);`],
    { cwd: root, encoding: 'utf8', timeout: 20_000 });
    expect(imported.status, imported.stderr).toBe(0);
    expect(fs.readFileSync(path.join(dist, 'services/preview-demo-snapshot.json')))
      .toEqual(fs.readFileSync(path.join(cdsRoot, 'src/services/preview-demo-snapshot.json')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 60_000);
