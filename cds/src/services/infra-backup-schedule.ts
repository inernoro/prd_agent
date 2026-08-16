/**
 * 基础设施周期备份的判定层。
 *
 * ## 为什么要有
 *
 * 备份此前只能手工点一下。手工备份的实际含义是「出事那天正好没人点」——
 * 一份都没有的时候，任何数据丢失都是不可恢复的，而且恢复窗口关掉之后才发现。
 *
 * ## 为什么第一版就要有保留策略与磁盘闸
 *
 * 无限攒备份会把根盘写满，而根盘写满会**同时**打死所有分支预览、构建和 CDS 自己——
 * 那比没有备份更糟。所以「转起来」和「不撑爆」必须一起落地，不能先跑起来再说。
 *
 * 本模块只做判定（选谁备份、删哪些旧的、够不够磁盘），不碰 docker、不碰文件系统，
 * 这样能拿真实数值写回归。执行侧在 index.ts。
 */

export type BackupKind = 'mongo' | 'redis';

export interface BackupCandidate {
  id: string;
  projectId: string;
  containerName: string;
  dockerImage: string;
  running?: boolean;
  env?: Record<string, string> | null;
}

export interface BackupTarget extends BackupCandidate {
  kind: BackupKind;
  /** 落盘文件名（不含目录）。 */
  fileName: string;
}

export interface BackupPlan {
  targets: BackupTarget[];
  /** 跳过的原因，逐条可解释——「这次没备份什么」和「备份了什么」同样重要。 */
  skipped: Array<{ id: string; reason: string }>;
}

/** 默认保留：每个服务最近 7 份，且不超过 14 天。 */
export const DEFAULT_KEEP_COUNT = 7;
export const DEFAULT_KEEP_DAYS = 14;

/**
 * 磁盘下限。低于这个可用空间就不备份——宁可这一轮没有新备份，也不能把根盘写满
 * 拖垮整台机器。2 GiB 是「一份 mongodump 加解压余量」的保守估计。
 */
export const DEFAULT_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

/** 只有这两类有成熟的一致性导出手段；其余类型不假装能备。 */
export function backupKindOf(dockerImage: string): BackupKind | null {
  const l = (dockerImage || '').toLowerCase();
  if (l.includes('mongo')) return 'mongo';
  if (l.includes('redis')) return 'redis';
  return null;
}

/**
 * 备份文件名。
 *
 * 时间戳用 ISO 去掉分隔符，保证**字典序等于时间序**——保留策略靠排序选旧的，
 * 名字排不出顺序就会删错。`auto` 段把周期备份和 restore 前的 `pre-restore`
 * 快照区分开：后者是救命用的，不该被周期清理顺手删掉。
 */
export function backupFileName(id: string, kind: BackupKind, iso: string): string {
  const stamp = iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const ext = kind === 'mongo' ? 'archive.gz' : 'rdb';
  return `${id}-auto-${stamp}.${ext}`;
}

/** 是不是本模块产出的周期备份。保留策略只处理自己产的，不碰别人的文件。 */
export function isAutoBackupFile(name: string, id: string): boolean {
  return name.startsWith(`${id}-auto-`);
}

export function planInfraBackups(
  candidates: readonly BackupCandidate[],
  opts: { now: Date },
): BackupPlan {
  const targets: BackupTarget[] = [];
  const skipped: BackupPlan['skipped'] = [];
  const iso = opts.now.toISOString();
  for (const c of candidates) {
    if (c.running === false) {
      skipped.push({ id: c.id, reason: '容器未运行' });
      continue;
    }
    const kind = backupKindOf(c.dockerImage);
    if (!kind) {
      skipped.push({ id: c.id, reason: `暂不支持自动备份的类型（${c.dockerImage}）` });
      continue;
    }
    targets.push({ ...c, kind, fileName: backupFileName(c.id, kind, iso) });
  }
  return { targets, skipped };
}

export interface ExistingBackup {
  name: string;
  mtimeMs: number;
}

/**
 * 选出该删的旧备份。
 *
 * 两条规则同时生效：超出份数的删、超过天数的删。但**永远保留最新一份**——
 * 一台闲置很久的实例，所有备份都会超期，按天数规则会被清空，那等于回到零备份。
 */
export function selectExpiredBackups(
  files: readonly ExistingBackup[],
  opts: { id: string; now: Date; keepCount?: number; keepDays?: number },
): string[] {
  const keepCount = Math.max(1, opts.keepCount ?? DEFAULT_KEEP_COUNT);
  const keepDays = Math.max(1, opts.keepDays ?? DEFAULT_KEEP_DAYS);
  const mine = files
    .filter((f) => isAutoBackupFile(f.name, opts.id))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);   // 新 → 旧
  if (mine.length === 0) return [];

  const cutoff = opts.now.getTime() - keepDays * 24 * 60 * 60_000;
  const doomed: string[] = [];
  mine.forEach((f, idx) => {
    if (idx === 0) return;                    // 最新一份永不删
    if (idx >= keepCount || f.mtimeMs < cutoff) doomed.push(f.name);
  });
  return doomed;
}

/** 磁盘够不够。读不到可用空间时按「不够」处理——不确定就不写。 */
export function shouldSkipForDiskPressure(
  freeBytes: number | null | undefined,
  minFreeBytes: number = DEFAULT_MIN_FREE_BYTES,
): boolean {
  if (freeBytes == null || !Number.isFinite(freeBytes)) return true;
  return freeBytes < minFreeBytes;
}

/** `df -Pk <dir>` 的输出里抠可用字节数。解析不出返回 null（上游按不够处理）。 */
export function parseDfAvailableBytes(dfOutput: string): number | null {
  const lines = (dfOutput || '').trim().split('\n');
  if (lines.length < 2) return null;
  const cols = lines[lines.length - 1].trim().split(/\s+/);
  // POSIX 格式：Filesystem 1024-blocks Used Available Capacity Mounted-on
  const availKb = Number(cols[3]);
  if (!Number.isFinite(availKb)) return null;
  return availKb * 1024;
}

export interface BackupOutcome {
  id: string;
  ok: boolean;
  fileName?: string;
  bytes?: number;
  error?: string;
  pruned?: string[];
}

/** 一轮结果的一句话结论。全成功也要说清备了几个——静默成功等于没有反馈。 */
export function summarizeBackupRound(outcomes: readonly BackupOutcome[], skipped: number): string {
  const ok = outcomes.filter((o) => o.ok);
  const failed = outcomes.filter((o) => !o.ok);
  const parts: string[] = [];
  if (ok.length) parts.push(`成功 ${ok.length} 个`);
  if (failed.length) parts.push(`失败 ${failed.length} 个（${failed.map((f) => f.id).join('、')}）`);
  if (skipped) parts.push(`跳过 ${skipped} 个`);
  return parts.length ? `基础设施自动备份：${parts.join('，')}` : '基础设施自动备份：没有可备份的目标';
}
