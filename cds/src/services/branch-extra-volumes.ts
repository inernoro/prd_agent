import { createHash } from 'node:crypto';
import type { CacheMount } from '../types.js';

/** 额外服务只申请本分支命名卷；不开放任意宿主目录或其他项目的卷。 */
export function branchExtraVolumePrefix(projectId: string, branchId: string): string {
  return `cds-extra-${createHash('sha256').update(JSON.stringify([projectId, branchId])).digest('hex').slice(0, 20)}-`;
}

export function parseBranchExtraVolumes(projectId: string, branchId: string, raw: unknown, previous?: CacheMount[]): CacheMount[] | undefined {
  if (raw === undefined) return previous;
  if (!Array.isArray(raw) || raw.length > 8) throw new Error('持久卷必须是最多 8 项的数组');
  const prefix = branchExtraVolumePrefix(projectId, branchId);
  const targets = new Set<string>();
  return raw.map(item => {
    if (!item || typeof item !== 'object' || item.kind !== 'volume'
      || typeof item.hostPath !== 'string' || typeof item.containerPath !== 'string')
      throw new Error('额外服务仅支持本分支命名卷');
    const label = item.hostPath.startsWith(prefix) ? item.hostPath.slice(prefix.length) : item.hostPath;
    if ((!item.hostPath.startsWith(prefix) && item.hostPath.startsWith('cds-extra-'))
      || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(label))
      throw new Error('持久卷名称非法或属于其他分支');
    const target = item.containerPath;
    if (!/^\/[a-zA-Z0-9._/-]+$/.test(target) || target.split('/').includes('..') || target.includes('//') || target.endsWith('/'))
      throw new Error('持久卷目标必须是规范的容器内绝对目录');
    if (targets.has(target)) throw new Error('持久卷目标目录不能重复');
    targets.add(target);
    return { kind: 'volume', hostPath: `${prefix}${label}`, containerPath: target };
  });
}
