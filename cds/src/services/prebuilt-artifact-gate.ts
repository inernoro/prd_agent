import { assertProfileDeploymentScopes, type DeploymentScopeContext } from './branch-extra-services.js';
import type { BuildProfile, IShellExecutor } from '../types.js';

export interface ArtifactAdmissionOptions {
  branch?: DeploymentScopeContext;
  signal?: AbortSignal;
  assertCurrent?: (stage: string) => void;
  onProgress?: (profileId: string, stage: string) => void;
}
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const architecture = (value: string) => ({ x86_64: 'amd64', aarch64: 'arm64' }[value] || value);

/** 仅准备精确制品：鉴权由实际docker pull验证，不改变运行容器/网络/路由。 */
export async function prepareExactPrebuiltArtifacts(
  shell: IShellExecutor, profiles: BuildProfile[], commitSha: string,
  options: ArtifactAdmissionOptions = {},
): Promise<BuildProfile[]> {
  if (!/^[a-f0-9]{40}$/i.test(commitSha)) throw new Error('artifact_target_invalid: 需要完整40位目标提交');
  const assertCurrent = (stage: string) => {
    assertProfileDeploymentScopes(profiles, options.branch);
    if (options.signal?.aborted) throw new Error('artifact_cancelled');
    options.assertCurrent?.(stage);
  };
  assertCurrent('artifact-admission');
  assertProfileDeploymentScopes(profiles, options.branch);
  const needed = profiles.filter(profile => profile.prebuiltImage && !profile.localArtifact);
  if (!needed.length) return profiles.map(profile => ({ ...profile }));
  const host = await shell.exec("docker version --format '{{.Server.Arch}}'", { priority: 'health', timeout: 10_000, signal: options.signal });
  const hostArch = architecture(host.stdout.trim());
  if (host.exitCode !== 0 || !['amd64', 'arm64', 'arm', 'ppc64le', 's390x'].includes(hostArch)) throw new Error('artifact_host_architecture_unknown');
  const admitted = new Map<string, BuildProfile>();
  // 两个制品并行，独立于源码构建槽；同worker镜像只拉一次。
  const prepared = new Map<string, Promise<{ id: string; image: string; ref: string; source: unknown }>>();
  let cursor = 0;
  const prepare = async (profile: BuildProfile) => {
    assertCurrent(`artifact-before-${profile.id}`);
    if (profile.managedBuild) throw new Error(`artifact_source_build_forbidden: ${profile.id}`);
    const original = (profile.dockerImage || '').trim();
    const match = original.match(/^(.*):sha-[a-f0-9]{7,40}$/i);
    const digest = original.match(/^(.*)@sha256:[a-f0-9]{64}$/i);
    if ((!match && !digest) || /[\s'"\$`]/.test(original)) throw new Error(`artifact_image_identity_invalid: ${profile.id}`);
    // 固定版本的digest保持原身份；仅普通sha标签按本轮目标展开。
    const image = digest ? original : `${match![1]}:sha-${commitSha.toLowerCase()}`;
    const repository = digest?.[1] || match![1];
    const cachedId = profile.preparedCommitSha === commitSha.toLowerCase() && /^sha256:[a-f0-9]{64}$/i.test(profile.preparedArtifactId || '') ? profile.preparedArtifactId : undefined;
    const key = `${cachedId || ''}|${image}`;
    let ready = prepared.get(key);
    if (!ready) {
      ready = (async () => {
        if (!cachedId) {
          options.onProgress?.(profile.id, 'pull');
          const pull = await shell.exec(`docker pull ${quote(image)}`, { timeout: 120_000, signal: options.signal, priority: 'delivery', schedulingGroup: profile.projectId });
          assertCurrent(`artifact-after-pull-${profile.id}`);
          if (pull.exitCode !== 0) throw new Error(`artifact_pull_failed: ${profile.id}；目标制品不可拉取，请检查CI制品与registry权限`);
        }
        const format = '{"architecture":{{json .Architecture}},"os":{{json .Os}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"source":{{json (index .Config.Labels "org.opencontainers.image.source")}},"id":{{json .Id}},"repoDigests":{{json .RepoDigests}}}';
        const inspect = await shell.exec(`docker image inspect --format ${quote(format)} ${quote(cachedId || image)}`, { timeout: 10_000, signal: options.signal, priority: 'delivery', schedulingGroup: profile.projectId });
        let metadata: Record<string, unknown> = {};
        try { metadata = JSON.parse(inspect.stdout.trim()); } catch { /* fail closed below */ }
        if (inspect.exitCode !== 0 || metadata.os !== 'linux' || metadata.architecture !== hostArch || metadata.revision !== commitSha.toLowerCase() || (digest && (!Array.isArray(metadata.repoDigests) || !metadata.repoDigests.includes(image))) || typeof metadata.id !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(metadata.id)) {
          throw new Error(`artifact_identity_mismatch: ${profile.id}；架构、OCI提交或镜像ID不匹配`);
        }
        const registryRef = digest ? image : Array.isArray(metadata.repoDigests)
          ? metadata.repoDigests.find((ref: unknown): ref is string => typeof ref === 'string'
            && ref.startsWith(`${repository}@sha256:`) && /@sha256:[a-f0-9]{64}$/i.test(ref)) || image
          : image;
        return { id: metadata.id, image, ref: registryRef, source: metadata.source };
      })();
      prepared.set(key, ready);
    }
    const artifact = await ready;
    // Check per-profile expectations even when the image pull/inspect promise was shared.
    if (profile.artifactSource && artifact.source !== profile.artifactSource) throw new Error(`artifact_source_mismatch: ${profile.id}`);
    assertCurrent(`artifact-ready-${profile.id}`);
    admitted.set(profile.id, { ...profile, dockerImage: artifact.image,
      preparedArtifactId: artifact.id, preparedArtifactRef: artifact.ref, preparedCommitSha: commitSha.toLowerCase(),
      sourceFallbackProfile: undefined, fallbackImage: undefined,
    });
    options.onProgress?.(profile.id, 'ready');
  };
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(2, needed.length) }, async () => {
    while (cursor < needed.length) await prepare(needed[cursor++]);
  }));
  const failed = outcomes.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
  assertCurrent('artifact-collection-ready');
  return profiles.map(profile => admitted.get(profile.id) || { ...profile });
}

/** 显式短SHA先在已拉取仓库解析为完整对象ID，绝不把另一提交贴成目标。 */
export async function resolveExactArtifactTargetSha(shell: IShellExecutor, candidate: string, cwd: string): Promise<string> {
  const sha = candidate.trim().toLowerCase();
  if (/^[a-f0-9]{40}$/.test(sha)) return sha;
  if (!/^[a-f0-9]{7,39}$/.test(sha)) throw new Error('artifact_target_invalid: 无可核验的目标提交');
  const resolved = await shell.exec(`git rev-parse --verify '${sha}^{commit}'`, { cwd, timeout: 10_000, priority: 'delivery' });
  const full = resolved.stdout.trim().toLowerCase();
  if (resolved.exitCode !== 0 || !/^[a-f0-9]{40}$/.test(full) || !full.startsWith(sha)) throw new Error('artifact_target_invalid: 无法核验显式短提交');
  return full;
}
