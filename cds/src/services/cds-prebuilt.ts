/**
 * cds-prebuilt — CDS 自更新「极速版」的纯函数决策/解析层（无 I/O，可单测）。
 *
 * 背景（用户 2026-06-27）：「既然代码被 CI 编译了，自更新就该拉现成的、不要本机再编一遍」。
 * CI（.github/workflows/cds-prebuilt.yml）把 CDS 编译好打成 ghcr 产物镜像
 * `cds-dist:sha-<40hex>`。自更新运行层（cds-prebuilt-runtime / self-update）据本层算出
 * 目标镜像 ref、判定 SHA 是否可用、校验 manifest，再决定走「拉产物」还是「本机现编」。
 *
 * 本文件**只做纯计算**——docker pull / cp / 原子替换 / 重启等危险 I/O 不在这里，
 * 以便核心逻辑脱离 Docker/真实环境单测（CLAUDE §8.1）。
 */

/** ghcr 产物镜像 tag 用的完整 40 位十六进制 SHA（与 CI `sha-${github.sha}` 同公式）。 */
export function isFullCommitSha(sha: string | null | undefined): boolean {
  return /^[0-9a-f]{40}$/i.test((sha || '').trim());
}

/**
 * 由仓库全名（owner/repo）+ 完整 SHA 算出预构建产物镜像 ref。
 * 与 CI 的 `IMAGE_NAME=${owner}/${repo}/cds-dist` + `tag=sha-${github.sha}` 严格对齐——
 * 改一边必须改另一边（SSOT 注释在两处互指）。registry 缺省 ghcr.io。
 * 入参非法（仓库名空 / 非全 SHA）返回 null：调用方据此**不**走预构建、回退本机现编。
 */
export function computeCdsPrebuiltImageRef(
  repoFullName: string | null | undefined,
  sha: string | null | undefined,
  registry = 'ghcr.io',
): string | null {
  const repo = (repoFullName || '').trim().replace(/^\/+|\/+$/g, '');
  const reg = (registry || 'ghcr.io').trim().replace(/\/+$/g, '');
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) return null; // 必须 owner/repo 两段
  if (!isFullCommitSha(sha)) return null;
  return `${reg}/${repo.toLowerCase()}/cds-dist:sha-${(sha as string).trim().toLowerCase()}`;
}

export interface CdsPrebuiltManifest {
  sha: string;
  ref?: string;
  builtAt?: string;
  runId?: string;
  schema: number;
}

/**
 * 解析并校验镜像里 /manifest.json 的内容。要求 schema===1 且 sha 为完整 40 hex，
 * 否则返回 null（视为产物不可信 → 回退本机现编）。可选地校验 manifest.sha 是否等于期望 SHA。
 */
export function parseCdsPrebuiltManifest(
  raw: string | null | undefined,
  expectedSha?: string,
): CdsPrebuiltManifest | null {
  if (!raw || !raw.trim()) return null;
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const m = obj as Record<string, unknown>;
  if (m.schema !== 1) return null;
  if (typeof m.sha !== 'string' || !isFullCommitSha(m.sha)) return null;
  if (expectedSha && m.sha.toLowerCase() !== expectedSha.trim().toLowerCase()) return null;
  return {
    sha: m.sha.toLowerCase(),
    ref: typeof m.ref === 'string' ? m.ref : undefined,
    builtAt: typeof m.builtAt === 'string' ? m.builtAt : undefined,
    runId: typeof m.runId === 'string' ? m.runId : undefined,
    schema: 1,
  };
}

/**
 * 是否应尝试预构建快路径。默认 false（灰度开关 CDS_SELFUPDATE_PREBUILT 显式开启才用），
 * 且必须能算出合法镜像 ref。纯判定，不做任何拉取——拉取失败的回退在运行层。
 */
export function shouldTryCdsPrebuilt(opts: {
  enabled: boolean;
  repoFullName: string | null | undefined;
  sha: string | null | undefined;
  registry?: string;
}): { use: false } | { use: true; imageRef: string } {
  if (!opts.enabled) return { use: false };
  const imageRef = computeCdsPrebuiltImageRef(opts.repoFullName, opts.sha, opts.registry);
  if (!imageRef) return { use: false };
  return { use: true, imageRef };
}
