/**
 * Cache diagnostic & migration routes.
 *
 * 解决的实际问题：
 * 1) 用户观察到 CDS 在本服务器跑了上千次，`dotnet restore` 还要 35 秒 ——
 *    理论上 `/cache/nuget` 应该已经 warm 了。这说明**挂载失效或缓存路径不对**。
 *    `/api/cache/status` 让用户一眼看到所有 cacheMount 的实际目录大小、
 *    文件数、最后写入时间，能立刻定位是哪个 profile 没走到缓存。
 *
 * 2) `POST /api/cache/repair` —— 强制重跑 migrateCacheMounts 合并逻辑，
 *    补齐混合 profile（含 pnpm 但缺 nuget）等缺失挂载。
 *
 * 3) `GET /api/cache/export?name=nuget` + `POST /api/cache/import?name=nuget`
 *    —— 换服务器时把预热好的缓存 tar.gz 搬过去，避免新服务器首次冷下载。
 */
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { StateService } from '../services/state.js';
import type { IShellExecutor } from '../types.js';
import { combinedOutput } from '../types.js';

export interface CacheRouterDeps {
  stateService: StateService;
  shell: IShellExecutor;
}

interface CacheDirInfo {
  /** 缓存类型名（nuget / pnpm / npm / yarn） */
  name: string;
  /** 宿主机路径 */
  hostPath: string;
  /** 容器内路径 */
  containerPath: string;
  /** 目录是否存在 */
  exists: boolean;
  /** 字节数（递归汇总），仅目录存在时有值 */
  sizeBytes: number | null;
  /** 文件总数 */
  fileCount: number | null;
  /** 最近写入时间 ISO 字符串 */
  lastModified: string | null;
  /** 正在使用此挂载的 BuildProfile id 列表 */
  usedByProfiles: string[];
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function dirStats(shell: IShellExecutor, dir: string): Promise<{
  sizeBytes: number;
  fileCount: number;
  lastModified: string | null;
}> {
  // du 给字节精确数，find 算文件数，stat 拿最近 mtime
  const sizeResult = await shell.exec(`du -sb "${dir}" 2>/dev/null | awk '{print $1}'`);
  const countResult = await shell.exec(`find "${dir}" -type f 2>/dev/null | wc -l`);
  const mtimeResult = await shell.exec(
    `find "${dir}" -type f -printf '%T@\\n' 2>/dev/null | sort -nr | head -1`
  );
  const sizeBytes = parseInt((sizeResult.stdout || '0').trim(), 10) || 0;
  const fileCount = parseInt((countResult.stdout || '0').trim(), 10) || 0;
  const mtime = parseFloat((mtimeResult.stdout || '0').trim());
  const lastModified = mtime > 0 ? new Date(mtime * 1000).toISOString() : null;
  return { sizeBytes, fileCount, lastModified };
}

function cacheNameFromPath(hostPath: string): string {
  return path.basename(hostPath);
}

export function createCacheRouter(deps: CacheRouterDeps): Router {
  const { stateService, shell } = deps;
  const router = Router();

  /**
   * GET /api/cache/status
   * 列出所有 cacheMount 的诊断信息。用户打开 Settings → 缓存诊断 时调用。
   */
  router.get('/cache/status', async (_req, res) => {
    try {
      const CACHE_BASE = stateService.getCacheBase();
      const profiles = stateService.getBuildProfiles();

      const pathToInfo = new Map<string, CacheDirInfo>();

      for (const profile of profiles) {
        for (const mount of profile.cacheMounts || []) {
          let entry = pathToInfo.get(mount.hostPath);
          if (!entry) {
            entry = {
              name: cacheNameFromPath(mount.hostPath),
              hostPath: mount.hostPath,
              containerPath: mount.containerPath,
              exists: fs.existsSync(mount.hostPath),
              sizeBytes: null,
              fileCount: null,
              lastModified: null,
              usedByProfiles: [],
            };
            pathToInfo.set(mount.hostPath, entry);
          }
          if (!entry.usedByProfiles.includes(profile.id)) {
            entry.usedByProfiles.push(profile.id);
          }
        }
      }

      // 汇总磁盘 stat（仅对存在的目录）
      await Promise.all(
        Array.from(pathToInfo.values()).map(async (info) => {
          if (!info.exists) return;
          const stats = await dirStats(shell, info.hostPath);
          info.sizeBytes = stats.sizeBytes;
          info.fileCount = stats.fileCount;
          info.lastModified = stats.lastModified;
        })
      );

      // 也扫一下 CACHE_BASE 下的孤儿目录（有实物但没被任何 profile 挂载）
      const orphans: CacheDirInfo[] = [];
      if (fs.existsSync(CACHE_BASE)) {
        const entries = fs.readdirSync(CACHE_BASE, { withFileTypes: true });
        for (const ent of entries) {
          if (!ent.isDirectory()) continue;
          const full = path.join(CACHE_BASE, ent.name);
          if (pathToInfo.has(full)) continue;
          const stats = await dirStats(shell, full);
          orphans.push({
            name: ent.name,
            hostPath: full,
            containerPath: '(未挂载)',
            exists: true,
            sizeBytes: stats.sizeBytes,
            fileCount: stats.fileCount,
            lastModified: stats.lastModified,
            usedByProfiles: [],
          });
        }
      }

      const caches = Array.from(pathToInfo.values());
      const totalBytes = caches.reduce((sum, c) => sum + (c.sizeBytes || 0), 0)
        + orphans.reduce((sum, c) => sum + (c.sizeBytes || 0), 0);

      res.json({
        cacheBase: CACHE_BASE,
        projectSlug: stateService.projectSlug,
        caches,
        orphans,
        totalBytes,
        totalBytesHuman: humanSize(totalBytes),
        warnings: buildWarnings(caches, orphans),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * POST /api/cache/repair
   * 强制按 dockerImage 补齐 cacheMounts。幂等。
   * 返回修复前后的 profile 数量差异和修复动作。
   */
  router.post('/cache/repair', async (_req, res) => {
    try {
      const CACHE_BASE = stateService.getCacheBase();
      const IMAGE_CACHE_MAP: Record<string, Array<{ hostPath: string; containerPath: string }>> = {
        'dotnet': [{ hostPath: `${CACHE_BASE}/nuget`, containerPath: '/root/.nuget/packages' }],
        'node': [{ hostPath: `${CACHE_BASE}/pnpm`, containerPath: '/pnpm/store' }],
      };

      const actions: Array<{ profileId: string; action: string; added?: string; fixed?: string; error?: string }> = [];
      const profiles = stateService.getBuildProfiles();

      for (const profile of profiles) {
        const mounts = [...(profile.cacheMounts || [])];
        let touched = false;

        // 路径迁移（host slug 漂移 + pnpm 容器路径纠正）
        for (const cm of mounts) {
          const updated = stateService.normalizeCacheHostPath(cm.hostPath);
          if (updated !== cm.hostPath) {
            actions.push({ profileId: profile.id, action: 'rewrite-host-path', fixed: `${cm.hostPath} → ${updated}` });
            cm.hostPath = updated;
            touched = true;
          }
          if (cm.containerPath === '/root/.local/share/pnpm/store') {
            actions.push({ profileId: profile.id, action: 'fix-pnpm-container-path', fixed: '/root/.local/share/pnpm/store → /pnpm/store' });
            cm.containerPath = '/pnpm/store';
            touched = true;
          }
        }

        // 合并缺失的标准挂载
        const image = profile.dockerImage || '';
        for (const [key, templates] of Object.entries(IMAGE_CACHE_MAP)) {
          if (!image.includes(key)) continue;
          for (const template of templates) {
            const exists = mounts.some(cm => cm.containerPath === template.containerPath);
            if (!exists) {
              mounts.push({ ...template });
              actions.push({ profileId: profile.id, action: 'add-missing-mount', added: `${template.hostPath} → ${template.containerPath}` });
              touched = true;
            }
          }
        }

        if (touched) {
          stateService.updateBuildProfile(profile.id, { cacheMounts: mounts });
        }
      }

      if (actions.length > 0) stateService.save();

      // 确保所有 host 目录预创建好（避免容器首次启动因父目录缺失 mount 失败）
      let directoryFailures = 0;
      const allHostPaths = new Set<string>();
      for (const profile of stateService.getBuildProfiles()) {
        for (const cm of profile.cacheMounts || []) {
          allHostPaths.add(cm.hostPath);
        }
      }
      for (const hp of allHostPaths) {
        if (fs.existsSync(hp)) continue;
        const mkdir = await shell.exec(`mkdir -p "${hp}"`);
        if (mkdir.exitCode === 0 && fs.existsSync(hp)) {
          actions.push({ profileId: '(cache)', action: 'ensure-host-dir', added: hp });
        } else {
          directoryFailures += 1;
          actions.push({
            profileId: '(cache)',
            action: 'ensure-host-dir-failed',
            fixed: hp,
            error: combinedOutput(mkdir) || '目录创建失败',
          });
        }
      }

      res.json({
        repaired: actions.some(action => action.action !== 'ensure-host-dir-failed'),
        actionsCount: actions.length,
        actions,
        message: directoryFailures > 0
          ? `缓存挂载配置已检查，但 ${directoryFailures} 个宿主机目录创建失败`
          : actions.length === 0
          ? '所有 profile 的缓存挂载已正常，无需修复'
          : `已修复 ${actions.length} 个挂载问题`,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * GET /api/cache/export?name=nuget
   * 打包指定缓存目录为 tar.gz 流式下载。
   * 换服务器时用：在老机器下载 → 上传到新机器 /api/cache/import。
   */
  router.get('/cache/export', async (req, res) => {
    const name = String(req.query.name || '').trim();
    if (!name || !/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
      res.status(400).json({ error: '缺少或非法的 name 参数（只允许字母数字和连字符）' });
      return;
    }

    const CACHE_BASE = stateService.getCacheBase();
    const dir = path.join(CACHE_BASE, name);
    if (!fs.existsSync(dir)) {
      res.status(404).json({ error: `缓存目录不存在: ${dir}` });
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `cds-cache-${name}-${stateService.projectSlug}-${stamp}.tar.gz`;

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // 直接 spawn tar，不经过内存 buffer
    const { spawn } = await import('node:child_process');
    const tar = spawn('tar', ['-czf', '-', '-C', CACHE_BASE, name], { stdio: ['ignore', 'pipe', 'pipe'] });
    tar.stdout.pipe(res);
    tar.stderr.on('data', (chunk: Buffer) => {
      // tar 的 stderr 不算错，只是 verbose 信息；不打断
      console.error(`[cache-export] ${chunk.toString().trim()}`);
    });
    tar.on('error', (err) => {
      if (!res.headersSent) res.status(500).json({ error: err.message });
      else res.end();
    });
    tar.on('close', (code) => {
      if (code !== 0 && !res.writableEnded) res.end();
    });
  });

  /**
   * POST /api/cache/import?name=nuget
   * 接收 tar.gz 上传并解压到指定缓存目录。
   * body 是原始 tar.gz 字节流（Content-Type: application/gzip）。
   */
  router.post('/cache/import', async (req, res) => {
    const name = String(req.query.name || '').trim();
    if (!name || !/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
      res.status(400).json({ error: '缺少或非法的 name 参数' });
      return;
    }

    const CACHE_BASE = stateService.getCacheBase();
    await shell.exec(`mkdir -p "${CACHE_BASE}"`);

    const { spawn } = await import('node:child_process');
    const tar = spawn('tar', ['-xzf', '-', '-C', CACHE_BASE], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderrBuf = '';
    tar.stderr.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString(); });

    req.pipe(tar.stdin);
    req.on('error', () => { try { tar.kill(); } catch { /* noop */ } });

    tar.on('close', async (code) => {
      if (code !== 0) {
        res.status(500).json({ error: `tar 解压失败 (exit ${code}): ${stderrBuf}` });
        return;
      }
      const imported = path.join(CACHE_BASE, name);
      const stats = fs.existsSync(imported) ? await dirStats(shell, imported) : null;
      res.json({
        imported: true,
        path: imported,
        sizeBytes: stats?.sizeBytes ?? null,
        sizeBytesHuman: stats ? humanSize(stats.sizeBytes) : null,
        fileCount: stats?.fileCount ?? null,
        message: `缓存已解压到 ${imported}`,
      });
    });
  });

  /**
   * POST /api/cache/purge?name=nuget
   * 清空指定缓存目录。用于故障排查（比如怀疑缓存被污染）或节省磁盘。
   * 不会影响容器运行；下次 restore 会从 nuget.org 重新拉。
   */
  router.post('/cache/purge', async (req, res) => {
    const name = String(req.query.name || '').trim();
    if (!name || !/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
      res.status(400).json({ error: '缺少或非法的 name 参数' });
      return;
    }
    const CACHE_BASE = stateService.getCacheBase();
    const dir = path.join(CACHE_BASE, name);
    if (!fs.existsSync(dir)) {
      res.status(404).json({ error: `缓存目录不存在: ${dir}` });
      return;
    }

    const result = await shell.exec(`rm -rf "${dir}"`);
    if (result.exitCode !== 0) {
      res.status(500).json({ error: combinedOutput(result) });
      return;
    }
    // 重建空目录（容器启动时需要存在，否则 -v 挂载 docker 会创建为 root:root）
    await shell.exec(`mkdir -p "${dir}"`);

    res.json({ purged: true, path: dir, message: `已清空缓存目录 ${dir}` });
  });

  return router;
}

function buildWarnings(caches: CacheDirInfo[], orphans: CacheDirInfo[]): string[] {
  const warnings: string[] = [];
  for (const c of caches) {
    if (!c.exists) {
      warnings.push(`[${c.name}] 被 ${c.usedByProfiles.length} 个 profile 引用，但宿主机目录不存在：${c.hostPath}`);
      continue;
    }
    if (c.sizeBytes === 0 && (c.fileCount ?? 0) === 0) {
      warnings.push(`[${c.name}] 目录空的！${c.usedByProfiles.join(', ')} 在用，说明挂载没生效或缓存被清过`);
    } else if ((c.sizeBytes ?? 0) < 10 * 1024 * 1024 && c.name === 'nuget') {
      warnings.push(`[${c.name}] 只有 ${humanSize(c.sizeBytes ?? 0)}，.NET 项目正常应该几百 MB，可能挂载路径不对`);
    }
  }
  if (orphans.length > 0) {
    warnings.push(`发现 ${orphans.length} 个孤儿缓存目录（有数据但没被任何 profile 挂载），可能是 profile 改名或缓存路径漂移`);
  }
  return warnings;
}
