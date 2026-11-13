import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { qualifyNativeSource } from '../../scripts/native-source-qualification.js';
import { assertPinnedArtifactRuntime, assertPortableArtifactContents, fixtureContentReference } from '../../scripts/native-artifact-identity.js';
import { isOwnedRuntimeCleanup } from '../../scripts/owned-runtime-cleanup-guard.js';

describe('原生候选的独立源码与镜像资格', () => {
  it('清理复合命令只接受两个不同自有CID及原始存活保护，不接受追加命令', () => {
    const required = '1'.repeat(64), target = '2'.repeat(64), foreign = '3'.repeat(64);
    const ids = new Set([required, target]);
    const command = `if [ "$(docker inspect --format '{{.Id}} {{.State.Running}}' '${required}' 2>/dev/null)" != '${required} true' ]; then printf '%s\\n' 'CDS_OLD_RUNTIME_UNAVAILABLE' >&2; exit 125; fi; docker stop ${target}`;
    expect(isOwnedRuntimeCleanup(command, ids)).toBe(true);
    expect(isOwnedRuntimeCleanup(command.replace(`docker stop ${target}`, `docker rm ${target}`), ids)).toBe(true);
    for (const invalid of [command.replaceAll(required, foreign), command.replace(target, foreign),
      command.replace(target, required), command + '; true', command.replace('exit 125', 'exit 0')]) {
      expect(isOwnedRuntimeCleanup(invalid, ids)).toBe(false);
    }
  });
  it('跨daemon恢复核同仓库内容的完整配置、层及平台，不能只看相同标签', () => {
    const manifest = 'owned@sha256:' + 'a'.repeat(64);
    const original = { RepoDigests: [manifest], Config: { Cmd: ['node', '/server.cjs'], Labels: { revision: 'fixed' } },
      RootFS: { Type: 'layers', Layers: ['sha256:' + 'b'.repeat(64)] }, Os: 'linux', Architecture: 'amd64' };
    expect(() => assertPortableArtifactContents(original, structuredClone(original), manifest)).not.toThrow();
    for (const field of ['RepoDigests', 'Config', 'RootFS', 'Architecture'] as const) {
      const changed = structuredClone(original);
      if (field === 'RepoDigests') changed.RepoDigests = [];
      if (field === 'Config') changed.Config.Cmd = ['node', '/foreign.cjs'];
      if (field === 'RootFS') changed.RootFS.Layers = ['sha256:' + 'c'.repeat(64)];
      if (field === 'Architecture') changed.Architecture = 'arm64';
      expect(() => assertPortableArtifactContents(original, changed, manifest)).toThrow();
    }
  });
  it('隔离快照携带实际脚本的同目录直接依赖', async () => {
    const host = ts.createSourceFile('host.ts', await fs.readFile(new URL('../../scripts/application-docker-host-drill.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    let copied: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isForOfStatement(node) && ts.isArrayLiteralExpression(node.expression)) {
        const names = node.expression.elements.filter(ts.isStringLiteral).map(item => item.text);
        if (names.includes('application-docker-inner-drill.ts')) copied = names;
      }
      ts.forEachChild(node, visit);
    };
    visit(host); expect(copied).not.toHaveLength(0);
    for (const name of copied) {
      const source = ts.createSourceFile(name, await fs.readFile(new URL('../../scripts/' + name, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const specifier = statement.moduleSpecifier.text;
        if (specifier.startsWith('./')) expect(copied).toContain(specifier.slice(2).replace(/\.js$/, '.ts'));
      }
    }
  });
  it('只接受外部指定提交的准确字节，拒绝改锁、额外源和错误目标', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-native-source-'));
    const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    try {
      await fs.mkdir(path.join(root, 'cds/src'), { recursive: true });
      await fs.writeFile(path.join(root, 'cds/src/owned.ts'), 'export const owned = true;\n');
      await fs.writeFile(path.join(root, 'cds/pnpm-lock.yaml'), 'lockfileVersion: 9\n');
      git('init'); git('add', 'cds');
      git('-c', 'user.name=原生夹具', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'test(cds): 固定原生夹具源码');
      const head = git('rev-parse', 'HEAD');
      expect(await qualifyNativeSource(root, head)).toMatchObject({ expectedHead: head, fileCount: 2 });
      await expect(qualifyNativeSource(root, 'a'.repeat(40))).rejects.toThrow('准确目标');
      await fs.writeFile(path.join(root, 'cds/pnpm-lock.yaml'), 'lockfileVersion: 8\n');
      await expect(qualifyNativeSource(root, head)).rejects.toThrow('原生实际源字节不符');
      await fs.writeFile(path.join(root, 'cds/pnpm-lock.yaml'), 'lockfileVersion: 9\n');
      await fs.writeFile(path.join(root, 'cds/src/extra.ts'), 'extra');
      await expect(qualifyNativeSource(root, head)).rejects.toThrow('未提交输入');
      git('add', 'cds/src/extra.ts');
      await expect(qualifyNativeSource(root, head)).rejects.toThrow('暂存区');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  const revision = 'a'.repeat(40), digest = 'sha256:' + 'b'.repeat(64), id = 'sha256:' + 'c'.repeat(64);
  const repository = '127.0.0.1:43210/owned-api', owner = 'owned-fixture';
  const expected = { manifest: repository + '@' + digest, revision, platform: 'linux/amd64', owner };
  const image = () => ({ Id: id, RepoDigests: [expected.manifest], Os: 'linux', Architecture: 'amd64',
    Config: { Labels: { 'org.opencontainers.image.revision': revision, 'cds.acceptance.owner': owner } } });
  it('独立保留发布标签与manifest，将实际容器绑定到已验证的本地镜像ID', () => {
    expect(fixtureContentReference({ sha: revision, reference: repository + ':sha-' + revision, repoDigests: [expected.manifest] }))
      .toBe(repository + ':sha-' + revision + '@' + digest);
    expect(() => assertPinnedArtifactRuntime({ Image: id, Config: { Image: id } }, image(), expected)).not.toThrow();
    expect(() => fixtureContentReference({ sha: revision, reference: repository + ':latest', repoDigests: [expected.manifest] })).toThrow();
    expect(() => fixtureContentReference({ sha: revision, reference: repository + ':sha-' + revision, repoDigests: ['foreign@' + digest] })).toThrow();
  });
  it.each(['runtime', 'config', 'manifest', 'revision', 'owner', 'platform'] as const)('拒绝不一致的独立身份：%s', field => {
    const runtime = { Image: id, Config: { Image: id } }, inspected = image();
    if (field === 'runtime') runtime.Image = digest;
    if (field === 'config') runtime.Config.Image = expected.manifest;
    if (field === 'manifest') inspected.RepoDigests = ['foreign@' + digest];
    if (field === 'revision') inspected.Config.Labels['org.opencontainers.image.revision'] = 'd'.repeat(40);
    if (field === 'owner') inspected.Config.Labels['cds.acceptance.owner'] = 'foreign';
    if (field === 'platform') inspected.Architecture = 'arm64';
    expect(() => assertPinnedArtifactRuntime(runtime, inspected, expected)).toThrow();
  });
});
