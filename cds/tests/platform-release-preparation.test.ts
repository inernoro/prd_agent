import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { preparePlatformRelease, verifyPlatformReleasePreparation } from '../src/services/platform-release-preparation.js';

describe('平台发布源码准备（真实 Git 与文件系统）', () => {
  let repo: string, baseline: string, candidate: string;
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const commit = (message: string) => {
    git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'cbd-release-prepare-'));
    git('init', '-q'); git('remote', 'add', 'origin', 'https://github.com/inernoro/prd_agent.git');
    await fs.mkdir(path.join(repo, 'cds/src'), { recursive: true });
    await fs.writeFile(path.join(repo, '.gitignore'), 'cds/.cds/\ncds/dist/\n');
    await fs.writeFile(path.join(repo, 'cds/package.json'), '{}');
    await fs.writeFile(path.join(repo, 'cds/src/index.ts'), 'baseline');
    await fs.writeFile(path.join(repo, 'application.txt'), 'application unchanged');
    baseline = commit('基线');
    await fs.writeFile(path.join(repo, 'cds/src/index.ts'), 'candidate');
    candidate = commit('候选');
  });
  afterEach(async () => { await fs.rm(repo, { recursive: true, force: true }); });

  it('打包指定提交及回退版本，排除未提交修改和应用；不会换盘或改变分支', async () => {
    await fs.writeFile(path.join(repo, 'cds/src/index.ts'), 'dirty workspace');
    await fs.mkdir(path.join(repo, 'cds/.cds'), { recursive: true });
    await fs.writeFile(path.join(repo, 'cds/.cds/credentials.json'), 'private test fixture');
    await fs.mkdir(path.join(repo, 'cds/dist'));
    await fs.writeFile(path.join(repo, 'cds/dist/index.js'), 'running artifacts');
    const status = git('status', '--porcelain');
    const branch = git('symbolic-ref', 'HEAD');
    const result = await preparePlatformRelease(repo, candidate, baseline);
    const manifest = await verifyPlatformReleasePreparation(result.directory, result.manifestSha256);
    expect(manifest.activationAllowed).toBe(false);
    for (const [file, expected] of [['candidate.tar', 'candidate'], ['rollback.tar', 'baseline']]) {
      const archive = path.join(result.directory, file);
      const listing = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' });
      expect(listing).not.toMatch(/application|credentials|dist\//);
      expect(execFileSync('tar', ['-xOf', archive, 'cds/src/index.ts'], { encoding: 'utf8' })).toBe(expected);
    }
    expect(git('status', '--porcelain')).toBe(status);
    expect(git('symbolic-ref', 'HEAD')).toBe(branch);
    expect(await fs.readFile(path.join(repo, 'cds/dist/index.js'), 'utf8')).toBe('running artifacts');
    expect(await fs.readFile(path.join(repo, 'cds/.cds/credentials.json'), 'utf8')).toBe('private test fixture');
    expect((await fs.stat(path.join(result.directory, 'manifest.json'))).mode & 0o777).toBe(0o600);
  });
  it('拒绝不同来源、短 SHA 和未继承线上版本的候选', async () => {
    await expect(preparePlatformRelease(repo, candidate.slice(0, 8), baseline)).rejects.toThrow('40 位');
    await expect(preparePlatformRelease(repo, baseline, candidate)).rejects.toThrow('merge-base');
    git('remote', 'set-url', 'origin', 'https://github.com/example/other.git');
    await expect(preparePlatformRelease(repo, candidate, baseline)).rejects.toThrow('来源');
    await expect(fs.stat(path.join(repo, 'cds/.cds'))).rejects.toThrow();
  });
  it.each(['cds/.env', 'cds/credentials.json', 'cds/private.pem'])('拒绝提交中的敏感资料 %s', async file => {
    await fs.writeFile(path.join(repo, file), 'sensitive fixture');
    const sha = commit('拒绝导出测试');
    await expect(preparePlatformRelease(repo, sha, baseline)).rejects.toThrow('不允许导出');
  });
  it('拒绝源码中的链接，不导出链接指向的内容', async () => {
    await fs.symlink('../application.txt', path.join(repo, 'cds/link'));
    const sha = commit('链接测试');
    await expect(preparePlatformRelease(repo, sha, baseline)).rejects.toThrow('不允许导出');
  });
  it('拒绝非忽略目录和运行目录链接', async () => {
    await fs.writeFile(path.join(repo, '.gitignore'), '');
    await expect(preparePlatformRelease(repo, candidate, baseline)).rejects.toThrow('check-ignore');
    await fs.writeFile(path.join(repo, '.gitignore'), 'cds/.cds/\n');
    await fs.symlink('src', path.join(repo, 'cds/.cds'));
    // Git 也可能先拒绝穿越符号链接；不依赖两层保护中谁先报错。
    await expect(preparePlatformRelease(repo, candidate, baseline)).rejects.toThrow();
    await expect(fs.stat(path.join(repo, 'cds/src/platform-release-preparation'))).rejects.toThrow();
  });
  it('并发准备不覆盖已有包', async () => {
    const [a, b] = await Promise.all([preparePlatformRelease(repo, candidate, baseline), preparePlatformRelease(repo, candidate, baseline)]);
    expect(a.directory).not.toBe(b.directory);
    await expect(verifyPlatformReleasePreparation(a.directory, a.manifestSha256)).resolves.toEqual(a.manifest);
    await expect(verifyPlatformReleasePreparation(b.directory, b.manifestSha256)).resolves.toEqual(b.manifest);
  });
  it.each(['candidate.tar', 'rollback.tar', 'manifest.json'])('检测 %s 被篡改', async file => {
    const result = await preparePlatformRelease(repo, candidate, baseline);
    await fs.appendFile(path.join(result.directory, file), 'tampered');
    await expect(verifyPlatformReleasePreparation(result.directory, result.manifestSha256)).rejects.toThrow('校验和不符');
  });
  it('拒绝伪造的发布许可和路径，不把校验成功当作发布批准', async () => {
    const result = await preparePlatformRelease(repo, candidate, baseline);
    for (const changed of [
      { ...result.manifest, activationAllowed: true },
      { ...result.manifest, candidate: { ...result.manifest.candidate, file: '../candidate.tar' } },
    ]) {
      const data = JSON.stringify(changed);
      await fs.writeFile(path.join(result.directory, 'manifest.json'), data);
      const checksum = createHash('sha256').update(data).digest('hex');
      await expect(verifyPlatformReleasePreparation(result.directory, checksum)).rejects.toThrow();
    }
  });
});
