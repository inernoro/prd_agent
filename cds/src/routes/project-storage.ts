// 项目存储面板路由 (2026-05-29)
//
// feature-emerge 第二波 E7「项目存储面板」：让用户在项目设置里看到该项目每个
// 基础设施服务的 docker named volume 大小、磁盘占用、挂载关系。
//
// 设计：
//   - infra 服务列表从 stateService.getInfraServicesForProject(projectId) 拿，
//     每个 service 的 .volumes(InfraVolume[]) 给出本项目用到的卷名 + 容器内路径 + 类型。
//   - 卷大小一次性用 `docker system df -v` 拿全量卷大小，按本项目的卷名过滤；
//     比起对每个卷 `docker run --rm -v ...:/v alpine du -sb`（精确但要为每个卷起容器、
//     很慢），`docker system df -v` 一条命令拿到所有卷的近似大小，足够面板展示。
//   - bind mount(type=bind)不查大小（宿主机路径不是 docker named volume，
//     du 风险大且语义不同），sizeBytes 置 null + note。
//   - shell 查询失败时优雅降级：sizeBytes=null + note，不抛 500。
//
// API:
//   GET /api/projects/:id/storage
//     → 200 {
//         volumes: [{ name, sizeBytes, sizeHuman, mountedBy[], containerPath, type, note? }],
//         totalBytes, totalHuman,
//         diskInfo?: { filesystem, totalBytes, usedBytes, availBytes, usePercent, ... },
//         note?: string                 // 全局降级提示（如 docker 不可用）
//       }
//     老项目无 infra → volumes: [], totalBytes: 0。

import { Router } from 'express';
import type { StateService } from '../services/state.js';
import type { InfraVolume, IShellExecutor } from '../types.js';
import {
  parseDockerSystemDfVolumes,
  parseDfOutput,
  formatBytes,
  type HostDiskInfo,
} from '../services/volume-size.js';

/** 单个卷在面板上的展示行。 */
export interface ProjectStorageVolume {
  /** docker named volume 名（type=volume）或宿主机路径（type=bind） */
  name: string;
  /** 卷大小（bytes）。bind / 查询失败 / docker 不可用时为 null */
  sizeBytes: number | null;
  /** 人类可读大小（如 "45.2 MB"），null 时为 '未知' */
  sizeHuman: string;
  /** 挂载该卷的 infra 服务 id 列表（同名卷可被多个服务共享） */
  mountedBy: string[];
  /** 容器内挂载路径（多个服务挂同名卷时取第一个，列出全部见 mounts） */
  containerPath: string;
  /** volume（docker named volume）或 bind（宿主机目录） */
  type: 'volume' | 'bind';
  /** 该卷为什么没大小（bind / 未在 docker df 中找到 等），可选 */
  note?: string;
}

export interface ProjectStorageResponse {
  volumes: ProjectStorageVolume[];
  totalBytes: number;
  totalHuman: string;
  diskInfo?: HostDiskInfo;
  note?: string;
}

export interface ProjectStorageDeps {
  stateService: StateService;
  /** docker 命令执行通道（与 cache.ts / infra-backup 同源 deps.shell） */
  shell: IShellExecutor;
  assertProjectAccess: (req: any, projectId: string) => { status: number; body: unknown } | null;
}

/**
 * 把本项目 infra 服务的 volumes 聚合成「卷名 → {type, containerPath, mountedBy[]}」。
 * 同名卷被多个服务挂载时合并 mountedBy；containerPath 取第一个出现的。
 * 纯函数，便于单测。
 */
export function collectProjectVolumes(
  infraServices: Array<{ id: string; volumes?: InfraVolume[] }>,
): Map<string, { type: 'volume' | 'bind'; containerPath: string; mountedBy: string[] }> {
  const map = new Map<string, { type: 'volume' | 'bind'; containerPath: string; mountedBy: string[] }>();
  for (const svc of infraServices) {
    for (const vol of svc.volumes || []) {
      if (!vol.name || !vol.name.trim()) continue;
      const existing = map.get(vol.name);
      if (existing) {
        if (!existing.mountedBy.includes(svc.id)) existing.mountedBy.push(svc.id);
      } else {
        map.set(vol.name, {
          type: vol.type === 'bind' ? 'bind' : 'volume',
          containerPath: vol.containerPath || '',
          mountedBy: [svc.id],
        });
      }
    }
  }
  return map;
}

export function createProjectStorageRouter(deps: ProjectStorageDeps): Router {
  const router = Router();
  const { stateService, shell } = deps;

  router.get('/projects/:id/storage', async (req, res) => {
    const projectId = req.params.id;
    const access = deps.assertProjectAccess(req, projectId);
    if (access) { res.status(access.status).json(access.body); return; }
    const project = stateService.getProject(projectId);
    if (!project) { res.status(404).json({ error: '项目不存在' }); return; }

    const infraServices = stateService.getInfraServicesForProject(projectId) || [];
    const volMap = collectProjectVolumes(infraServices);

    // 老项目无 infra（或 infra 不挂卷）→ 空列表，不报错。
    if (volMap.size === 0) {
      const body: ProjectStorageResponse = { volumes: [], totalBytes: 0, totalHuman: formatBytes(0) };
      res.json(body);
      return;
    }

    // 一次性拿全量卷大小。任意环节失败都降级为「大小未知」而非 500。
    let sizeByVolume = new Map<string, number | null>();
    let globalNote: string | undefined;
    try {
      const r = await shell.exec('docker system df -v', { timeout: 20000 });
      if (r.exitCode === 0 && r.stdout) {
        sizeByVolume = parseDockerSystemDfVolumes(r.stdout);
      } else {
        globalNote = '无法读取 docker 卷大小（docker system df 返回非零），大小显示为未知。';
      }
    } catch (err) {
      globalNote = `读取卷大小失败：${(err as Error).message}。大小显示为未知。`;
    }

    const volumes: ProjectStorageVolume[] = [];
    let totalBytes = 0;
    for (const [name, info] of volMap) {
      let sizeBytes: number | null = null;
      let note: string | undefined;
      if (info.type === 'bind') {
        note = '宿主机目录挂载（bind），不统计大小';
      } else if (sizeByVolume.has(name)) {
        sizeBytes = sizeByVolume.get(name) ?? null;
        if (sizeBytes == null) note = 'docker 未报告该卷大小';
      } else {
        // 卷在 state 里登记但 docker 里还没创建（infra 未启动过）
        note = globalNote ? undefined : '该卷尚未在 docker 中创建';
      }
      if (sizeBytes != null) totalBytes += sizeBytes;
      volumes.push({
        name,
        sizeBytes,
        sizeHuman: formatBytes(sizeBytes),
        mountedBy: info.mountedBy,
        containerPath: info.containerPath,
        type: info.type,
        ...(note ? { note } : {}),
      });
    }
    // 大卷在前，便于用户一眼看出谁占地方；无大小的排后面。
    volumes.sort((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1));

    // 可选：宿主机磁盘信息（df -kP 该分区），失败静默忽略。
    let diskInfo: HostDiskInfo | undefined;
    try {
      const dr = await shell.exec('df -kP /', { timeout: 8000 });
      if (dr.exitCode === 0 && dr.stdout) {
        const parsed = parseDfOutput(dr.stdout);
        if (parsed) diskInfo = parsed;
      }
    } catch { /* 磁盘信息是锦上添花，失败不影响主流程 */ }

    const body: ProjectStorageResponse = {
      volumes,
      totalBytes,
      totalHuman: formatBytes(totalBytes),
      ...(diskInfo ? { diskInfo } : {}),
      ...(globalNote ? { note: globalNote } : {}),
    };
    res.json(body);
  });

  return router;
}
