/**
 * cds-prebuilt-runtime — CDS 自更新「极速版」的运行层：把 CI 预构建的 ghcr 产物镜像
 * `docker pull` 下来、`docker cp` 解出 /dist 与 /web-dist 到 staging，并校验 manifest。
 *
 * 安全设计：
 *  - 所有外部 I/O（docker exec / 读 manifest / 文件操作）经 deps 注入，可用 MockShell 单测，
 *    不依赖真实 Docker（CLAUDE §8.1）。
 *  - 任何一步失败 → 返回 { ok:false, reason }，**绝不抛**——调用方（self-update）据此**回退本机现编**，
 *    保证自更新永不因预构建拉取失败而卡死/变砖。
 *  - 只解出到 staging（dist.next / web-dist.next 之类），原子替换 + 重启仍由 self-update 既有
 *    安全流程完成；本模块不碰正在运行的 dist/。
 */

import type { CdsPrebuiltManifest } from './cds-prebuilt.js';
import { parseCdsPrebuiltManifest } from './cds-prebuilt.js';

export interface PrebuiltExecResult { stdout: string; stderr: string; exitCode: number }

export interface PrebuiltFetchDeps {
  /** 执行一条 docker 命令。 */
  exec: (cmd: string, opts?: { timeout?: number }) => Promise<PrebuiltExecResult>;
  /** 读取 staged manifest.json 文本（不存在返回 null）。 */
  readManifest: (manifestPath: string) => Promise<string | null>;
  /** 递归删除路径（清理 staging 残留）。 */
  rmrf: (p: string) => void;
  /** 递归建目录。 */
  mkdirp: (p: string) => void;
}

export interface PrebuiltFetchOutcome {
  ok: boolean;
  reason?: string;
  /** 解出的后端 dist 目录（成功时）。 */
  distDir?: string;
  /** 解出的前端 web/dist 目录（成功时）。 */
  webDistDir?: string;
  manifest?: CdsPrebuiltManifest;
}

/** 纯函数：staging 根目录下的产物布局（可单测，调用方据此原子替换）。 */
export function prebuiltStagingPaths(stagingRoot: string): { distDir: string; webDistDir: string; manifestPath: string } {
  const root = stagingRoot.replace(/\/+$/g, '');
  return { distDir: `${root}/dist`, webDistDir: `${root}/web-dist`, manifestPath: `${root}/manifest.json` };
}

/** 从 `docker create` 的 stdout 取容器 id（最后一行非空 token，12-64 hex）。非法返回 null。 */
export function parseDockerCreateId(stdout: string | null | undefined): string | null {
  const last = (stdout || '').trim().split('\n').map((s) => s.trim()).filter(Boolean).pop() || '';
  return /^[0-9a-f]{12,64}$/i.test(last) ? last.toLowerCase() : null;
}

/**
 * 拉取并解出预构建产物到 staging。成功返回 distDir/webDistDir 供调用方原子替换；
 * 任何失败返回 ok:false（调用方回退本机现编）。expectedSha 用于校验 manifest 与目标 commit 一致，
 * 杜绝拉到错 SHA 的镜像。
 */
export async function fetchCdsPrebuilt(
  deps: PrebuiltFetchDeps,
  imageRef: string,
  expectedSha: string,
  stagingRoot: string,
  opts?: { pullTimeoutMs?: number },
): Promise<PrebuiltFetchOutcome> {
  const { distDir, webDistDir, manifestPath } = prebuiltStagingPaths(stagingRoot);
  const pullTimeoutMs = opts?.pullTimeoutMs ?? 120_000;
  try {
    deps.rmrf(stagingRoot);
    deps.mkdirp(distDir);
    deps.mkdirp(webDistDir);

    const pull = await deps.exec(`docker pull ${imageRef}`, { timeout: pullTimeoutMs });
    if (pull.exitCode !== 0) return { ok: false, reason: `docker pull 失败: ${(pull.stderr || '').slice(0, 200)}` };

    const create = await deps.exec(`docker create ${imageRef}`, { timeout: 30_000 });
    if (create.exitCode !== 0) return { ok: false, reason: `docker create 失败: ${(create.stderr || '').slice(0, 200)}` };
    const cid = parseDockerCreateId(create.stdout);
    if (!cid) return { ok: false, reason: 'docker create 未返回有效容器 id' };

    try {
      const cpDist = await deps.exec(`docker cp ${cid}:/dist/. ${distDir}`, { timeout: 60_000 });
      const cpWeb = await deps.exec(`docker cp ${cid}:/web-dist/. ${webDistDir}`, { timeout: 60_000 });
      const cpMan = await deps.exec(`docker cp ${cid}:/manifest.json ${manifestPath}`, { timeout: 15_000 });
      if (cpDist.exitCode !== 0 || cpWeb.exitCode !== 0 || cpMan.exitCode !== 0) {
        return { ok: false, reason: 'docker cp 解出产物失败' };
      }
    } finally {
      await deps.exec(`docker rm -f ${cid}`, { timeout: 15_000 }).catch(() => undefined);
    }

    const manifest = parseCdsPrebuiltManifest(await deps.readManifest(manifestPath), expectedSha);
    if (!manifest) return { ok: false, reason: 'manifest 校验失败（SHA 不符 / schema 非 1 / 缺失）' };

    return { ok: true, distDir, webDistDir, manifest };
  } catch (e) {
    return { ok: false, reason: `预构建拉取异常: ${(e as Error).message}` };
  }
}
