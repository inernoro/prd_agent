import type { BuildProfile, IShellExecutor } from '../types.js';
import { shellQuoteArg } from './secure-database-cli.js';

export type ArtifactWaitReason = 'target-unresolved' | 'image-unresolved' | 'missing' | 'access-denied'
  | 'verification-unavailable' | 'revision-mismatch' | 'platform-mismatch';

export interface VerifiedDeploymentArtifact {
  profileIds: string[];
  requestedImage: string;
  image: string;
  revision: string;
  platform: string;
}

/** 私有输入的一部分；公开事件只发等待原因，不发 registry 输出或认证细节。 */
export interface ArtifactAdmission {
  state: 'waiting' | 'ready';
  targetCommitSha: string;
  checkedAt: string;
  executorId?: string;
  reason?: ArtifactWaitReason;
  profileIds?: string[];
  artifacts: VerifiedDeploymentArtifact[];
}

function platformArchitecture(value: unknown): string | undefined {
  if (value === 'amd64' || value === 'x86_64') return 'amd64';
  if (value === 'arm64' || value === 'aarch64') return 'arm64';
  if (value === '386' || value === 'arm' || value === 'ppc64le' || value === 's390x') return value;
  return undefined;
}

function readJson(value: string): any {
  try { return JSON.parse(value); } catch { return undefined; }
}

function pullFailureReason(stdout: string, stderr: string): ArtifactWaitReason {
  const output = `${stderr}\n${stdout}`;
  // registry 明确拒绝与明确不存在分开；网络、超时、daemon等错误不得猜成镜像缺失。
  if (/unauthorized|authentication required|denied:|requested access.*denied|insufficient_scope/i.test(output)) return 'access-denied';
  if (/manifest unknown|manifest not found|name unknown|not found: manifest/i.test(output)) return 'missing';
  return 'verification-unavailable';
}

/** 全部必需预构建角色检查通过才返回ready，共用引用只拉取和核验一次。 */
export async function inspectDeploymentArtifacts(
  shell: IShellExecutor, profiles: readonly BuildProfile[], targetCommitSha: string,
  assertCurrent: () => void = () => {},
): Promise<ArtifactAdmission> {
  const target = targetCommitSha.toLowerCase();
  const checkedAt = new Date().toISOString();
  const required = profiles.filter(profile => profile.prebuiltImage && !profile.managedBuild && !profile.localArtifact);
  const waiting = (reason: ArtifactWaitReason, profileIds?: string[]): ArtifactAdmission => ({
    state: 'waiting', targetCommitSha: target, checkedAt, reason, profileIds, artifacts: [],
  });
  if (!/^[0-9a-f]{40}$/.test(target)) return waiting('target-unresolved');
  const images = new Map<string, string[]>();
  for (const profile of required) {
    const image = profile.dockerImage?.trim();
    if (!image || image.includes('${')) return waiting('image-unresolved', [profile.id]);
    const ids = images.get(image) || [];
    ids.push(profile.id); images.set(image, ids);
  }
  if (!required.length) return { state: 'ready', targetCommitSha: target, checkedAt, artifacts: [] };
  const exec = async (command: string, timeout = 30_000) => {
    assertCurrent();
    const result = await shell.exec(command, { timeout, beforeStart: assertCurrent });
    assertCurrent();
    return result;
  };
  // 实际Docker daemon平台，不能用Master进程或开发者电脑的架构代替执行器。
  const daemon = await exec("docker info --format '{{json .}}'").catch(() => undefined);
  if (!daemon || daemon.exitCode) return waiting('verification-unavailable');
  const info = readJson(daemon.stdout);
  const arch = platformArchitecture(info?.Architecture);
  const system = info?.OSType;
  if (!arch || typeof system !== 'string' || !system) return waiting('verification-unavailable');
  const artifacts: VerifiedDeploymentArtifact[] = [];
  for (const [image, profileIds] of images) {
    assertCurrent();
    const pull = await exec(`docker pull ${shellQuoteArg(image)}`, 90_000).catch(() => undefined);
    if (!pull) { assertCurrent(); return waiting('verification-unavailable', profileIds); }
    if (pull.exitCode) return waiting(pullFailureReason(pull.stdout, pull.stderr), profileIds);
    const inspection = await exec(`docker image inspect ${shellQuoteArg(image)}`).catch(() => undefined);
    if (!inspection || inspection.exitCode) { assertCurrent(); return waiting('verification-unavailable', profileIds); }
    const parsed = readJson(inspection.stdout);
    const metadata = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : undefined;
    const revision = metadata?.Config?.Labels?.['org.opencontainers.image.revision'];
    if (typeof revision !== 'string' || revision.toLowerCase() !== target) return waiting('revision-mismatch', profileIds);
    const imageArch = platformArchitecture(metadata?.Architecture);
    if (!imageArch || metadata?.Os !== system || imageArch !== arch) return waiting('platform-mismatch', profileIds);
    // 核验本地内容ID，并保存OCI固定digest用于运行及版本台账；不保存可变tag。
    const immutable = metadata?.Id;
    if (typeof immutable !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(immutable)) return waiting('verification-unavailable', profileIds);
    const digest = Array.isArray(metadata.RepoDigests)
      ? metadata.RepoDigests.find((value: unknown) => typeof value === 'string' && /^.+@sha256:[0-9a-f]{64}$/.test(value)) : undefined;
    if (!digest) return waiting('verification-unavailable', profileIds);
    artifacts.push({ profileIds, requestedImage: image, image: digest, revision: target, platform: `${system}/${arch}` });
  }
  assertCurrent();
  return { state: 'ready', targetCommitSha: target, checkedAt, artifacts };
}

/** 只在完整准入后物化本次已确认内容，原配置快照不被覆写。 */
export function admittedArtifactProfile(profile: BuildProfile, admission?: ArtifactAdmission): BuildProfile {
  if (!profile.prebuiltImage || profile.managedBuild || profile.localArtifact || !admission) return profile;
  if (admission.state !== 'ready') throw new Error('部署产物尚未完成核验');
  const artifact = admission.artifacts.find(item => item.profileIds.includes(profile.id) && (item.requestedImage === profile.dockerImage || item.image === profile.dockerImage));
  if (!artifact) throw new Error('当前服务不在本次产物准入清单中');
  return { ...profile, dockerImage: artifact.image, localArtifact: true, fallbackImage: undefined,
    sourceFallbackProfile: undefined };
}
