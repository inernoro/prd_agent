import { createHash } from 'node:crypto';
import path from 'node:path';
import type { BranchEntry, BuildProfile, IShellExecutor } from '../types.js';
import { computeCdsInstanceId } from './orphan-container-reaper.js';
import { profileHostsPreviewInstance } from './preview-instance.js';
import { shellQuoteArg } from './secure-database-cli.js';

/** The operator enables one exact scope in the parent process, never in a project profile. */
export async function preparePreviewCompatibilityAssets(input: {
  repo: string;
  entry: BranchEntry;
  profile: BuildProfile;
  shell: IShellExecutor;
  projectEnv?: Record<string, string>;
  scope?: string;
}): Promise<string | undefined> {
  const { repo, entry, profile, shell, projectEnv, scope } = input;
  if (scope !== [entry.projectId, entry.id, profile.id].join('/')) return;
  if (entry.executorId || !profile.prebuiltImage || !profileHostsPreviewInstance(profile, projectEnv)
      || !/^sha256:[a-f0-9]{64}$/.test(profile.dockerImage)) {
    throw new Error('静态兼容范围须使用宿主本地的固定 CDS 预览镜像');
  }
  const owner = [computeCdsInstanceId(repo), entry.projectId, entry.id, profile.id];
  const prior = entry.services[profile.id]?.servingRuntime;
  const args = ['python3', path.join(repo, 'scripts/lib/cds-preview-assets.py'), '--repo', repo,
    '--owner', ...owner, '--image', profile.dockerImage];
  if (prior?.containerId && /^[a-f0-9]{64}$/.test(prior.containerId)) args.push('--previous-container', prior.containerId);
  const result = await shell.exec(args.map(shellQuoteArg).join(' '), { timeout: 240_000, executionLane: 'operation' });
  if (result.exitCode !== 0) throw new Error('未能确认预览静态兼容资产，请核对镜像、保留预算及宿主执行记录');
  let prepared: { assetDirectory?: unknown; compatibilityDays?: unknown };
  try { prepared = JSON.parse(result.stdout); } catch { throw new Error('预览静态兼容回执无效'); }
  const root = path.join(repo, '.cds-preview-assets-v1', createHash('sha256').update(owner.join('\0')).digest('hex'), '.releases');
  const assetDirectory = prepared?.assetDirectory;
  if (typeof assetDirectory !== 'string' || prepared.compatibilityDays !== 30 || path.basename(assetDirectory) !== 'assets'
      || path.dirname(path.dirname(assetDirectory)) !== root
      || !new RegExp(`^${profile.dockerImage.slice(7)}-[0-9a-f]{32}$`).test(path.basename(path.dirname(assetDirectory)))) {
    throw new Error('预览静态兼容回执与当前镜像或归属不一致');
  }
  return assetDirectory;
}
