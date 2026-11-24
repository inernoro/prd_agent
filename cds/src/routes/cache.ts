/** Cache diagnostics and explicit metadata retirement. Repair does not allocate,
 * recreate host bindings or mkdir user paths. Existing physical caches are kept. */
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { StateService } from '../services/state.js';
import type { IShellExecutor } from '../types.js';
import { combinedOutput } from '../types.js';
import { retireGeneratedCatalogCaches, mergeRetiredCatalogCaches } from '../services/cache-catalog.js';

// Security state is durable data even on installations that historically put it under CACHE_BASE.
const protectedCacheName=(name:string)=>name.toLowerCase()==='database-passes';

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
          if (mount.kind === 'volume' || protectedCacheName(path.relative(CACHE_BASE,path.resolve(CACHE_BASE,mount.hostPath)).split(path.sep)[0])) continue;
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
          if (!ent.isDirectory() || protectedCacheName(ent.name)) continue;
          if (profiles.some((profile) => profile.cacheMounts?.some((mount) =>
            mount.kind === 'volume' && mount.hostPath === ent.name))) continue;
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
      const actions: Array<{ profileId: string; action: string; count: number }> = [];
      for (const profile of stateService.getBuildProfiles()) {
        const result = retireGeneratedCatalogCaches(profile.dockerImage, stateService.getCacheBase(), profile.cacheMounts || []);
        if (!result.retired.length) continue;
        stateService.updateBuildProfile(profile.id, {
          cacheMounts: result.kept,
          retiredCatalogCacheMounts: mergeRetiredCatalogCaches(profile.retiredCatalogCacheMounts || [], result.retired),
        });
        actions.push({ profileId: profile.id, action: 'retire-generated-host-cache', count: result.retired.length });
      }
      if (actions.length) { stateService.save(); await stateService.flush(); }
      res.json({ repaired: actions.length > 0, actionsCount: actions.length, actions,
        cacheBackend: 'container-layer', message: '编译缓存使用容器可写层；重建时缓存为冷。原宿主目录和数据未移动或删除。' });
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
    if(protectedCacheName(name)){res.status(409).json({error:'数据库通行证包含持久账号回收与审计记录，不属于构建缓存。'});req.resume();return;}
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
    // 先按住请求流，**必须在任何 await 之前**（同 infra 恢复接口，E43）。
    // HTTP 日志中间件挂了 `req.on('data')`，请求流已经在 flowing 模式；本 handler
    // 要先 await（建目录、动态 import）才 `req.pipe(tar.stdin)`，等它 pipe 的时候
    // body 已经流完——tar 收到零字节，解压出一个空目录，接口照样回 200。
    // pipe 时会自动 resume。
    req.pause();
    const name = String(req.query.name || '').trim();
    if(protectedCacheName(name)){res.status(409).json({error:'数据库通行证包含持久账号回收与审计记录，不属于构建缓存。'});req.resume();return;}
    if (!name || !/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
      res.status(400).json({ error: '缺少或非法的 name 参数' });
      // 按住之后提前返回要把流放开，否则上传方看到的是卡住而不是这条 400。
      req.resume();
      return;
    }

    const CACHE_BASE = stateService.getCacheBase();
    await shell.exec(`mkdir -p "${CACHE_BASE}"`);

    const { spawn } = await import('node:child_process');
    const tar = spawn('tar', ['-xzf', '-', '--exclude=database-passes', '-C', CACHE_BASE], { stdio: ['pipe', 'pipe', 'pipe'] });
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
    if(protectedCacheName(name)){res.status(409).json({error:'数据库通行证包含持久账号回收与审计记录，不属于构建缓存。'});req.resume();return;}
    if (!name || !/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
      res.status(400).json({ error: '缺少或非法的 name 参数' });
      return;
    }
    if (stateService.getBuildProfiles().some((profile) =>
      profile.cacheMounts?.some((mount) => mount.kind === 'volume' && mount.hostPath === name))) {
      res.status(409).json({ error: '这是应用的 Docker 命名卷，不属于可清理的构建缓存。' });
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
