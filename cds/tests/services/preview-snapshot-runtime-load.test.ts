import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('预览快照生产运行时加载', () => {
  it('编译产物不依赖 dist 内的 JSON 或 JSON import attribute', async () => {
    const sourcePath = path.resolve(__dirname, '../../src/services/preview-instance-seed.ts');
    const snapshotPath = path.resolve(__dirname, '../../src/services/preview-demo-snapshot.json');
    const source = readFileSync(sourcePath, 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: sourcePath,
    }).outputText;

    expect(compiled).not.toMatch(/import .*preview-demo-snapshot\.json/);

    const root = mkdtempSync(path.join(tmpdir(), 'cds-preview-snapshot-runtime-'));
    tempDirs.push(root);
    const distServices = path.join(root, 'dist/services');
    const srcServices = path.join(root, 'src/services');
    mkdirSync(distServices, { recursive: true });
    mkdirSync(srcServices, { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
    writeFileSync(path.join(distServices, 'preview-instance-seed.js'), compiled);
    writeFileSync(
      path.join(srcServices, 'preview-demo-snapshot.json'),
      readFileSync(snapshotPath),
    );

    const moduleUrl = pathToFileURL(path.join(distServices, 'preview-instance-seed.js'));
    const loaded = await import(`${moduleUrl.href}?t=${Date.now()}`);
    expect(loaded.seedPreviewInstanceSnapshot).toBeTypeOf('function');
  });
});
