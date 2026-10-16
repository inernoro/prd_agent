import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const repository = 'inernoro/prd_agent';
const origins = new Set([
  'https://github.com/inernoro/prd_agent.git', 'https://github.com/inernoro/prd_agent',
  'git@github.com:inernoro/prd_agent.git', 'ssh://git@github.com/inernoro/prd_agent.git',
]);

export interface PlatformSourceArchive {
  file: 'candidate.tar' | 'rollback.tar';
  commitSha: string;
  sha256: string;
  bytes: number;
}
export interface PlatformReleasePreparation {
  schema: 1;
  repository: typeof repository;
  activationAllowed: false;
  kind: 'source-preparation-only';
  candidate: PlatformSourceArchive;
  rollback: PlatformSourceArchive;
}

async function git(repo: string, args: string[]): Promise<string> {
  // 不输出 Git 错误中的远端 URL、认证信息或环境内容。
  try {
    return (await exec('git', ['-C', repo, ...args], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
  } catch { throw new Error(`平台源码准备失败：git ${args[0]} 未通过`); }
}
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');

async function regularFile(file: string): Promise<Buffer> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('准备包只接受普通文件');
  return fs.readFile(file);
}

async function validateRevision(repo: string, sha: string): Promise<void> {
  if (!SHA.test(sha)) throw new Error('候选和回退版本必须使用完整的 40 位小写提交 SHA');
  if ((await git(repo, ['rev-parse', '--verify', `${sha}^{commit}`])).trim() !== sha) {
    throw new Error('版本不是指定的提交对象');
  }
  const entries = (await git(repo, ['ls-tree', '-r', '-z', sha, '--', 'cds/'])).split('\0').filter(Boolean);
  if (!entries.some(entry => entry.endsWith('\tcds/package.json'))
    || !entries.some(entry => entry.endsWith('\tcds/src/index.ts'))) throw new Error('版本缺少平台源码入口');
  for (const entry of entries) {
    const [metadata, file] = entry.split('\t');
    // 不把链接、submodule、运行状态或凭据打进源码包，也不复制工作区未提交内容。
    if (!/^100(644|755) blob /.test(metadata) || !file?.startsWith('cds/')
      || file.split('/').some(part => ['..', '.cds', '.cds-repos', '.cds-worktrees', 'node_modules', 'dist'].includes(part))
      || /(^|\/)(\.env($|\.)|\.cds\.env($|\.)|credentials\.json$)|\.(pem|key)$/.test(file)) {
      throw new Error('平台提交包含不允许导出的文件类型或运行资料');
    }
  }
}

/** 只准备源码：没有换盘、信号、Docker、HTTP 或应用部署能力。 */
export async function preparePlatformRelease(repoPath: string, candidateSha: string, rollbackSha: string): Promise<{
  directory: string; manifestSha256: string; manifest: PlatformReleasePreparation;
}> {
  const repo = await fs.realpath(repoPath);
  if ((await git(repo, ['rev-parse', '--show-toplevel'])).trim() !== repo) throw new Error('请传入 Git 仓库根目录');
  if (!origins.has((await git(repo, ['remote', 'get-url', 'origin'])).trim())) throw new Error('仓库来源必须是 inernoro/prd_agent');
  await validateRevision(repo, rollbackSha);
  await validateRevision(repo, candidateSha);
  await git(repo, ['merge-base', '--is-ancestor', rollbackSha, candidateSha]);

  const relative = 'cds/.cds/platform-release-preparation';
  // 仅写已忽略目录；拒绝通过符号链接写入别的项目或运行产物目录。
  await git(repo, ['check-ignore', '-q', '--', `${relative}/probe`]);
  let parent = repo;
  for (const part of relative.split('/')) {
    parent = path.join(parent, part);
    await fs.mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const stat = await fs.lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('准备目录不能使用符号链接');
  }
  const directory = await fs.mkdtemp(path.join(parent, `${candidateSha.slice(0, 12)}-`));
  try {
    const archive = async (file: PlatformSourceArchive['file'], commitSha: string): Promise<PlatformSourceArchive> => {
      const target = path.join(directory, file);
      await git(repo, ['archive', '--format=tar', `--output=${target}`, commitSha, '--', 'cds/']);
      await fs.chmod(target, 0o600);
      const data = await regularFile(target);
      return { file, commitSha, sha256: digest(data), bytes: data.length };
    };
    const manifest: PlatformReleasePreparation = {
      schema: 1, repository, activationAllowed: false, kind: 'source-preparation-only',
      candidate: await archive('candidate.tar', candidateSha),
      rollback: await archive('rollback.tar', rollbackSha),
    };
    const data = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await fs.writeFile(path.join(directory, 'manifest.json'), data, { flag: 'wx', mode: 0o600 });
    return { directory, manifestSha256: digest(data), manifest };
  } catch (error) {
    // 只清理本次创建的随机目录；不删除别的准备包、运行目录或进程。
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** 校验和须来自准备时独立保存的回执，不能从待校验 manifest 自证。 */
export async function verifyPlatformReleasePreparation(directory: string, expectedManifestSha256: string): Promise<PlatformReleasePreparation> {
  if (!DIGEST.test(expectedManifestSha256)) throw new Error('必须提供准备回执中的 manifest SHA-256');
  const data = await regularFile(path.join(directory, 'manifest.json'));
  if (digest(data) !== expectedManifestSha256) throw new Error('准备清单校验和不符');
  const manifest = JSON.parse(data.toString()) as PlatformReleasePreparation;
  if (manifest?.schema !== 1 || manifest.repository !== repository || manifest.activationAllowed !== false
    || manifest.kind !== 'source-preparation-only') throw new Error('准备清单格式不符');
  for (const [key, file] of [['candidate', 'candidate.tar'], ['rollback', 'rollback.tar']] as const) {
    const record = manifest[key];
    if (!record || record.file !== file || !SHA.test(record.commitSha) || !DIGEST.test(record.sha256)
      || !Number.isSafeInteger(record.bytes) || record.bytes <= 0) throw new Error('源码包记录不合法');
    const content = await regularFile(path.join(directory, file));
    if (content.length !== record.bytes || digest(content) !== record.sha256) throw new Error(`${file} 校验和不符`);
  }
  return manifest;
}
