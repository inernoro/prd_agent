import type { BuildProfile, IShellExecutor } from '../types.js';
import type { WorktreeService } from './worktree.js';
import { shellQuoteArg } from './secure-database-cli.js';
import {
  componentInputComparator, imageRepositoryOf, normalizeBuildScope, normalizeFallbackImages, normalizeImageRevision, proveFallbackImage,
  type ProveFallbackImageInput,
} from './prebuilt-reuse.js';

export type ArtifactWaitReason = 'target-unresolved' | 'image-unresolved' | 'missing' | 'access-denied'
  | 'verification-unavailable' | 'revision-mismatch' | 'platform-mismatch';

export interface VerifiedDeploymentArtifact {
  profileIds: string[];
  requestedImage: string;
  image: string;
  revision: string;
  platform: string;
  selectedImage?: string;
  proof?: { kind: 'exact-target' } | { kind: 'component-unchanged'; buildScope: string[] };
}

export interface ArtifactInspectionOptions {
  inspectLocalArtifacts?: boolean;
  isComponentUnchangedSince?: ProveFallbackImageInput['isComponentUnchangedSince'];
  remainingMs?: () => number;
}

/** 每轮一次封顶；旧无 owner 的执行器请求保留只读比较，不能借此取得 fetch 资格。 */
export function artifactInspectionContext(shell: IShellExecutor, worktree: Pick<WorktreeService, 'ensureCommitAvailable'> | undefined,
  repoRoot: string, assertCurrent: () => void, limitMs = 120_000): ArtifactInspectionOptions & { remainingMs: () => number } {
  if (!Number.isFinite(limitMs) || limitMs <= 0) throw new Error('产物核验剩余时间无效');
  const deadline = performance.now() + Math.min(limitMs, 120_000);
  const remainingMs = () => {
    assertCurrent(); const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw new Error('产物核验已超时，请稍后重试');
    return remaining;
  };
  const compare = componentInputComparator(shell, repoRoot, () => { remainingMs(); }, remainingMs);
  return { remainingMs, isComponentUnchangedSince: async (from, to, scope) => {
    if (worktree) for (const sha of [from, to]) await worktree.ensureCommitAvailable(repoRoot, sha, assertCurrent, remainingMs);
    return compare(from, to, scope);
  } };
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

function pullFailureReason(stdout: string, stderr: string, image: string): ArtifactWaitReason {
  const output = `${stderr}\n${stdout}`;
  // registry 明确拒绝与明确不存在分开；网络、超时、daemon等错误不得猜成镜像缺失。
  if (/unauthorized|authentication required|denied:|requested access.*denied|insufficient_scope/i.test(output)) return 'access-denied';
  if (/manifest unknown|manifest not found|name unknown|not found: manifest/i.test(output)) return 'missing';
  // Docker29/containerd uses this exact resolution diagnostic. Only match
  // the requested reference twice; unrelated "not found" stays unknown.
  if (output.trim().endsWith(`failed to resolve reference "${image}": ${image}: not found`)) return 'missing';
  return 'verification-unavailable';
}

/** 全部必需预构建角色检查通过才返回ready，共用引用只拉取和核验一次。 */
export async function inspectDeploymentArtifacts(
  shell: IShellExecutor, profiles: readonly BuildProfile[], targetCommitSha: string,
  assertCurrent: () => void = () => {},
  options: ArtifactInspectionOptions = {},
): Promise<ArtifactAdmission> {
  const target = targetCommitSha.toLowerCase();
  const checkedAt = new Date().toISOString();
  const required = profiles.filter(profile => profile.prebuiltImage && !profile.managedBuild && (options.inspectLocalArtifacts || !profile.localArtifact));
  const waiting = (reason: ArtifactWaitReason, profileIds?: string[]): ArtifactAdmission => ({
    state: 'waiting', targetCommitSha: target, checkedAt, reason, profileIds, artifacts: [],
  });
  if (!/^[0-9a-f]{40}$/.test(target)) return waiting('target-unresolved');
  for (const profile of required) {
    const image = profile.dockerImage?.trim();
    if (!image || image.includes('${')) return waiting('image-unresolved', [profile.id]);
  }
  if (!required.length) return { state: 'ready', targetCommitSha: target, checkedAt, artifacts: [] };
  const exec = async (command: string, timeout = 30_000) => {
    assertCurrent();
    const check = () => { assertCurrent(); options.remainingMs?.(); };
    const result = await shell.exec(command, { timeout: Math.min(timeout, options.remainingMs?.() ?? timeout), beforeStart: check });
    check();
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
  type Inspection = { reason: ArtifactWaitReason } | { image: string; revision: string; platform: string };
  const inspections = new Map<string, Promise<Inspection>>();
  const inspect = (image: string, needsPull: boolean, exactTarget = false): Promise<Inspection> => {
    const key = JSON.stringify([image, needsPull, exactTarget]);
    const cached = inspections.get(key); if (cached) return cached;
    const promise = (async (): Promise<Inspection> => {
      const pull = needsPull ? await exec(`docker pull ${shellQuoteArg(image)}`, 90_000).catch(() => undefined) : { exitCode: 0, stdout: '', stderr: '' };
      if (!pull) { assertCurrent(); return { reason: 'verification-unavailable' }; }
      if (pull.exitCode) return { reason: pullFailureReason(pull.stdout, pull.stderr, image) };
      const inspection = await exec(`docker image inspect ${shellQuoteArg(image)}`).catch(() => undefined);
      if (!inspection || inspection.exitCode) { assertCurrent(); return { reason: 'verification-unavailable' }; }
      const parsed = readJson(inspection.stdout);
      const metadata = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : undefined;
      const revision = normalizeImageRevision(metadata?.Config?.Labels?.['org.opencontainers.image.revision']);
      if (!revision || exactTarget && revision !== target) return { reason: 'revision-mismatch' };
      const imageArch = platformArchitecture(metadata?.Architecture);
      if (!imageArch || metadata?.Os !== system || imageArch !== arch) return { reason: 'platform-mismatch' };
      // 核验本地内容ID，并保存OCI固定digest用于运行及版本台账；不保存可变tag。
      const immutable = metadata?.Id;
      if (typeof immutable !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(immutable)) return { reason: 'verification-unavailable' };
      // 已按固定仓库digest查询并核验内容，保留可跨执行器取回的引用。
      const digest = /^.+@sha256:[0-9a-f]{64}$/.test(image) ? `${imageRepositoryOf(image)}@${image.split('@')[1]}`
        : !needsPull ? immutable : Array.isArray(metadata.RepoDigests)
        ? metadata.RepoDigests.find((value: unknown) => typeof value === 'string' && /^.+@sha256:[0-9a-f]{64}$/.test(value)
          && imageRepositoryOf(value) === imageRepositoryOf(image)) : undefined;
      if (!digest) return { reason: 'verification-unavailable' };
      return { image: digest, revision, platform: `${system}/${arch}` };
    })();
    inspections.set(key, promise); return promise;
  };
  for (const profile of required) {
    const primary = profile.dockerImage.trim(), scope = normalizeBuildScope(profile.buildScope);
    const candidates = [primary, ...normalizeFallbackImages(profile.fallbackImage).filter(image => image !== primary
      && !image.includes('${') && imageRepositoryOf(image) === imageRepositoryOf(primary))];
    let allowFallback = false, lastReason: ArtifactWaitReason = 'missing';
    let item: VerifiedDeploymentArtifact | undefined;
    for (let index = 0; index < candidates.length; index++) {
      if (index && !allowFallback) break;
      const selectedImage = candidates[index];
      const result = await inspect(selectedImage, index > 0 || !profile.localArtifact,
        !index && !profile.localArtifact && !primary.includes('@sha256:')); assertCurrent();
      if ('reason' in result) {
        if (result.reason !== 'missing') return waiting(result.reason, [profile.id]);
        if (!index) allowFallback = true;
        continue;
      }
      // 错标的sha目标不是“缺产物”；已固定的历史内容才可再次证明等价。
      if (!index && result.revision !== target && !profile.localArtifact && !primary.includes('@sha256:')) {
        return waiting('revision-mismatch', [profile.id]);
      }
      const proof = await proveFallbackImage({ revision: result.revision, targetSha: target,
        buildScope: scope, isComponentUnchangedSince: options.isComponentUnchangedSince });
      assertCurrent();
      if (!proof.accepted) { lastReason = 'revision-mismatch'; continue; }
      item = { profileIds: [profile.id], requestedImage: primary, selectedImage, image: result.image,
        revision: result.revision, platform: result.platform,
        proof: proof.reason === 'exact-target' ? { kind: 'exact-target' } : { kind: 'component-unchanged', buildScope: scope! } };
      break;
    }
    if (!item) return waiting(lastReason, [profile.id]);
    const existing = artifacts.find(artifact => JSON.stringify({ ...artifact, profileIds: [] }) === JSON.stringify({ ...item, profileIds: [] }));
    if (existing) existing.profileIds.push(profile.id); else artifacts.push(item);
  }
  assertCurrent();
  return { state: 'ready', targetCommitSha: target, checkedAt, artifacts };
}

/** Master独立证明远端回执的组件等价；布尔声明和远端传来的scope均不是信任根。 */
export async function verifyArtifactAdmission(profiles: readonly BuildProfile[], target: string, admission: ArtifactAdmission,
  compare: ArtifactInspectionOptions['isComponentUnchangedSince'], assertCurrent: () => void): Promise<boolean> {
  if (admission.state !== 'ready' || admission.targetCommitSha !== target || !Array.isArray(admission.artifacts)) return false;
  const required = profiles.filter(profile => profile.prebuiltImage && !profile.managedBuild && !profile.localArtifact);
  const roles = new Set(required.map(profile => profile.id));
  if (admission.artifacts.some(item => !Array.isArray(item?.profileIds) || !item.profileIds.length
    || new Set(item.profileIds).size !== item.profileIds.length || item.profileIds.some(role => !roles.has(role)))) return false;
  for (const profile of required) {
    const matches = admission.artifacts.filter(item => item.profileIds.includes(profile.id));
    if (matches.length !== 1) return false;
    const artifact = matches[0], selected = artifact.selectedImage || artifact.requestedImage;
    if (artifact.requestedImage !== profile.dockerImage || !normalizeImageRevision(artifact.revision)
      || !/^.+@sha256:[0-9a-f]{64}$/.test(artifact.image) || !/^linux\/(amd64|arm64|386|arm|ppc64le|s390x)$/.test(artifact.platform)
      || ![profile.dockerImage, ...normalizeFallbackImages(profile.fallbackImage)].includes(selected)
      || imageRepositoryOf(artifact.image) !== imageRepositoryOf(selected)
      || imageRepositoryOf(selected) !== imageRepositoryOf(profile.dockerImage)) return false;
    if (artifact.revision === target) {
      if (artifact.proof && artifact.proof.kind !== 'exact-target') return false;
      continue;
    }
    if (selected === profile.dockerImage && !profile.dockerImage.includes('@sha256:')) return false;
    const scope = normalizeBuildScope(profile.buildScope);
    if (!scope || artifact.proof?.kind !== 'component-unchanged'
      || JSON.stringify([...scope].sort()) !== JSON.stringify([...(normalizeBuildScope(artifact.proof.buildScope) || [])].sort())) return false;
    const proof = await proveFallbackImage({ revision: artifact.revision, targetSha: target, buildScope: scope, isComponentUnchangedSince: compare });
    assertCurrent(); if (!proof.accepted) return false;
  }
  assertCurrent(); return true;
}

function verifiedRuntimeImage(artifact: VerifiedDeploymentArtifact): string {
  // Docker 按 @digest 运行固定内容；提交标签只携带此前 OCI revision 已核验的身份。
  // 不从待发布目标或部署版本猜运行号，纯本机配置 ID 仍保持未知。
  const [repository, digest] = artifact.image.split('@');
  return digest && /^[0-9a-f]{40}$/.test(artifact.revision)
    ? `${repository.replace(/:[^/:]+$/, '')}:sha-${artifact.revision}@${digest}` : artifact.image;
}

/** 只在完整准入后物化本次已确认内容，原配置快照不被覆写。 */
export function admittedArtifactProfile(profile: BuildProfile, admission?: ArtifactAdmission): BuildProfile {
  if (!profile.prebuiltImage || profile.managedBuild || profile.localArtifact || !admission) return profile;
  if (admission.state !== 'ready') throw new Error('部署产物尚未完成核验');
  const artifact = admission.artifacts.find(item => item.profileIds.includes(profile.id)
    && [item.requestedImage, item.image, verifiedRuntimeImage(item)].includes(profile.dockerImage));
  if (!artifact) throw new Error('当前服务不在本次产物准入清单中');
  return { ...profile, dockerImage: verifiedRuntimeImage(artifact), localArtifact: true, fallbackImage: undefined,
    sourceFallbackProfile: undefined };
}
