/**
 * 项目设置里「周期备份」面板的判据。
 *
 * 面板要回答的第一件事是「**这个项目的备份，要不要我管**」。所以这里把上一轮落盘的
 * 那份健康文件，按项目拆成一行一个目标：它这一轮成没成、成的那份多大、有没有离机副本、
 * 最近一次真的成功是什么时候。
 *
 * 三条纪律写在前面，因为它们都是这条链路上真出过事的形状：
 *
 * 1. **按项目筛，不按裸 id 筛。** infra id 只在项目内唯一，真机一轮里有六个叫 `redis`
 *    的目标。少了这一步，别的项目的服务会出现在这个项目的清单里
 *    （cross-project-isolation：标识要带作用域）。
 * 2. **「最近一次成功」从磁盘上的文件名推，不从这一轮的结果编。** 健康文件只记得住
 *    最近一轮；一个连续失败三天的目标，它这一轮当然没有产物，但盘上还躺着三天前那份。
 *    答「三天前」可以行动，答「未知」只会让人怀疑面板本身。
 * 3. **本模块不碰文件系统、不碰 docker**，只做判定，这样能拿真实数值写回归。
 *    取数在路由层。
 */

import { backupKey, isAutoBackupFile, INFRA_BACKUP_INTERVAL_MS } from './infra-backup-schedule.js';

/**
 * 一个目标这一轮的处境。**五档不能合并**——每一档要人做的事都不一样：
 *
 * - `failed`      本地就没导出来，手上没有它的新副本 → 得去修这台服务
 * - `offsite-only` 本地那份已过校验、就在盘上，只是离机没上去 → 得去修离机通道
 * - `partial`     备成功了，但导出脚本自报只覆盖到一部分（如 postgres 只导了一个库）
 * - `unsupported` 这个类型压根还备不了（如 MinIO 要桶到桶复制，不是一份 dump）
 * - `ok`          正常
 *
 * 前两档合并过一次，后果是把运维支去找一份其实存在的备份（见 platform-daily-health
 * 里那两条 finding 的注释）。这里不再重犯。
 */
export type BackupTargetStatus = 'failed' | 'offsite-only' | 'partial' | 'unsupported' | 'ok';

export interface BackupPanelTarget {
  id: string;
  status: BackupTargetStatus;
  /** 为什么是这个状态。正常时为 null——正常不需要解释。 */
  reason: string | null;
  /** 这一轮产物的字节数；这一轮没有产物时为 null（不要拿 0 顶替）。 */
  bytes: number | null;
  /** 这一轮有没有离机副本。 */
  offsite: boolean;
  /** 最近一次成功备份的时间，从盘上的文件名推；推不出来就是 null，不编。 */
  lastSuccessAt: string | null;
  /** 盘上属于这个目标的周期备份份数。 */
  fileCount: number;
}

/** 落盘的那份健康文件（`.cds-backup-health.json`）里，面板要用到的字段。 */
export interface BackupHealthRecord {
  completedAt?: string | null;
  localVerifiedAt?: string | null;
  remoteVerifiedAt?: string | null;
  coverageGaps?: Array<{ id?: string; projectId?: string | null; reason?: string }> | null;
  failedTargets?: Array<{ id?: string; projectId?: string | null; reason?: string }> | null;
  offsiteOnlyTargets?: Array<{ id?: string; projectId?: string | null; reason?: string }> | null;
  objects?: Array<{
    id?: string;
    projectId?: string | null;
    fileName?: string;
    remoteObjectKey?: string | null;
    bytes?: number | null;
  }> | null;
}

/** 备份目录里的一个文件（路由层 `ls` 出来的）。 */
export interface BackupFileEntry {
  name: string;
  bytes: number;
}

export interface BackupPanelView {
  /** 上一轮周期备份跑完的时间。只回答「跑没跑」。 */
  lastRoundAt: string | null;
  /**
   * 下一轮**大概**什么时候。上一轮时刻 + 备份周期推出来的**预估**，不是排程表里的真值
   * （定时器是从进程启动算起的，中间跳过一轮就会有偏差）。所以界面上必须写「约」——
   * 给不出确切值时给范围可以，把预估说成确切值不行。
   */
  nextRoundEstimatedAt: string | null;
  /** 本地副本最近一次**全都成**的时间。 */
  localVerifiedAt: string | null;
  /** 离机副本最近一次**全都成**的时间。 */
  remoteVerifiedAt: string | null;
  verdict: {
    tone: 'ok' | 'warn' | 'bad';
    /** 第一屏那句话：一句挂着数字的判断，不是一排让人自己算的指标。 */
    headline: string;
    /** 补一句其余目标的处境；没有可补的就是 null。 */
    subline: string | null;
  };
  targets: BackupPanelTarget[];
  /** 这个项目在备份目录里占了多少个文件、多少字节。 */
  files: { count: number; bytes: number };
}

/**
 * 周期备份文件名里的那个时间戳（`…-auto-20260828T131500Z.archive.gz`）。
 *
 * 与 `backupFileName` 的写法一一对应：ISO 去掉 `-` 与 `:`，毫秒段压成 `Z`。
 * 认不出就返回 null——宁可少一个「最近一次成功」，也不要按文件 mtime 猜一个
 * （mtime 会被拷贝、同步、恢复操作改写，它回答的不是「这份备份是什么时候的」）。
 */
export function parseAutoBackupStamp(name: string): string | null {
  const m = /-auto-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\./.exec(name);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/**
 * 这个文件是不是**这个项目**产的（不限定是哪个目标）。
 *
 * 用来数「这个项目一共占了多少份备份」。文件名前缀走 `backupKey` 这一份 SSOT，
 * 不在这里重抄一遍 id 的清洗规则（形状 3）。
 *
 * 后面那个 `!== '-'` 是防前缀撞车：项目 `a` 的前缀是 `a--`，而项目 `a-` 的文件名
 * 以 `a---` 开头，裸前缀匹配会把后者的备份算进前者。
 */
export function isProjectOwnedBackupFile(name: string, projectId: string): boolean {
  const prefix = backupKey(projectId, '');
  return name.startsWith(prefix) && name.charAt(prefix.length) !== '-';
}

function sameProject(entry: { projectId?: string | null }, projectId: string): boolean {
  // 存量文件里可能没有 projectId（这个字段是 2026-08-28 才补的）。**不许当成命中**：
  // 猜错的后果是把别的项目的服务摆进这个项目的清单，而那正是要防的事。
  return String(entry.projectId || '') === projectId;
}

function cleanReason(value: unknown): string | null {
  const s = String(value || '').trim();
  return s || null;
}

/**
 * 一段人能读的相对时间（「3 小时前」）。
 *
 * 不做「昨天 / 上周」这类日历口径：备份的周期是 6 小时，读者要的是「隔了多久」，
 * 不是「哪一天」。
 */
export function relativeAge(now: Date, iso: string | null): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const ms = now.getTime() - at;
  if (ms < 0) return '刚刚';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/**
 * 把一份健康文件 + 一份备份目录清单，算成这个项目的面板视图。
 *
 * `health` 为 null = 一份结果都读不到。**不要读成「没问题」**：一份从没跑成过的备份
 * 和一份跑得好好的备份，在「没有结果文件」这件事上长得一模一样。
 */
export function buildBackupPanel(input: {
  projectId: string;
  health: BackupHealthRecord | null;
  files: readonly BackupFileEntry[];
  now: Date;
  /** 备份周期。默认取真实排程的那个常量，用例可以覆盖。 */
  intervalMs?: number;
}): BackupPanelView {
  const { projectId, health, files, now } = input;
  const intervalMs = input.intervalMs ?? INFRA_BACKUP_INTERVAL_MS;
  const mine = files.filter((f) => isProjectOwnedBackupFile(f.name, projectId));

  const objects = (health?.objects || []).filter((o) => o?.id && sameProject(o, projectId));
  const failed = (health?.failedTargets || []).filter((t) => t?.id && sameProject(t, projectId));
  const offsiteOnly = (health?.offsiteOnlyTargets || []).filter((t) => t?.id && sameProject(t, projectId));
  const gaps = (health?.coverageGaps || []).filter((g) => g?.id && sameProject(g, projectId));

  const objectById = new Map(objects.map((o) => [String(o.id), o]));
  const failedById = new Map(failed.map((t) => [String(t.id), t]));
  const offsiteById = new Map(offsiteOnly.map((t) => [String(t.id), t]));
  const gapById = new Map(gaps.map((g) => [String(g.id), g]));

  const ids = [...new Set([
    ...objectById.keys(),
    ...failedById.keys(),
    ...offsiteById.keys(),
    ...gapById.keys(),
  ])].sort();

  const targets: BackupPanelTarget[] = ids.map((id) => {
    const object = objectById.get(id);
    const own = mine.filter((f) => isAutoBackupFile(f.name, projectId, id));
    const stamps = own.map((f) => parseAutoBackupStamp(f.name)).filter((s): s is string => Boolean(s));
    stamps.sort();
    // 优先级不能乱：一个目标同时出现在「失败」和「缺口」里时，要先说它没备成——
    // 「备到一部分」是成功之后才谈得上的事。
    const gap = gapById.get(id);
    const status: BackupTargetStatus = failedById.has(id)
      ? 'failed'
      : offsiteById.has(id)
        ? 'offsite-only'
        : gap
          ? (object ? 'partial' : 'unsupported')
          : 'ok';
    const reason = status === 'failed'
      ? cleanReason(failedById.get(id)?.reason)
      : status === 'offsite-only'
        ? cleanReason(offsiteById.get(id)?.reason)
        : (status === 'partial' || status === 'unsupported')
          ? cleanReason(gap?.reason)
          : null;
    return {
      id,
      status,
      reason,
      bytes: typeof object?.bytes === 'number' ? object.bytes : null,
      offsite: Boolean(object?.remoteObjectKey),
      lastSuccessAt: stamps.length > 0 ? stamps[stamps.length - 1] : null,
      fileCount: own.length,
    };
  });

  const lastRoundMs = Date.parse(String(health?.completedAt || ''));
  return {
    lastRoundAt: health?.completedAt ?? null,
    nextRoundEstimatedAt: Number.isFinite(lastRoundMs)
      ? new Date(lastRoundMs + intervalMs).toISOString()
      : null,
    localVerifiedAt: health?.localVerifiedAt ?? null,
    remoteVerifiedAt: health?.remoteVerifiedAt ?? null,
    verdict: buildVerdict(targets, health, now),
    targets,
    files: {
      count: mine.length,
      bytes: mine.reduce((sum, f) => sum + (Number.isFinite(f.bytes) ? f.bytes : 0), 0),
    },
  };
}

/**
 * 第一屏那句话。
 *
 * 只回答一件事：**要不要我管**。所以按严重度取一句，不把五个数字并排摆出来让人自己算
 * （conclusion-before-numbers）。其余目标的处境退到 subline。
 */
function buildVerdict(
  targets: readonly BackupPanelTarget[],
  health: BackupHealthRecord | null,
  now: Date,
): BackupPanelView['verdict'] {
  const count = (s: BackupTargetStatus): number => targets.filter((t) => t.status === s).length;
  const failed = count('failed');
  const offsite = count('offsite-only');
  const partial = count('partial');
  const unsupported = count('unsupported');
  const ok = count('ok');

  const rest: string[] = [];
  if (ok > 0) rest.push(`正常 ${ok} 个`);
  if (unsupported > 0) rest.push(`这类还备不了 ${unsupported} 个`);
  const subline = rest.length > 0 ? rest.join(' · ') : null;

  if (!health) {
    return {
      tone: 'bad',
      // 读不到不等于没问题——这句话是这套体检的第一条纪律。
      headline: '读不到上一轮周期备份的结果，不确定这个项目备份过没有',
      subline: null,
    };
  }
  if (targets.length === 0) {
    return { tone: 'warn', headline: '这个项目还没有一条周期备份记录', subline: null };
  }
  if (failed > 0) {
    return {
      tone: 'bad',
      headline: `${failed} 个目标本地就没备出来，手上没有它们的新副本`,
      subline,
    };
  }
  if (offsite > 0) {
    return {
      tone: 'warn',
      headline: `${offsite} 个目标只备在本机，离机副本没上去`,
      subline,
    };
  }
  if (partial > 0) {
    return {
      tone: 'warn',
      headline: `${partial} 个目标只备到了一部分`,
      subline,
    };
  }
  const age = relativeAge(now, health.completedAt ?? null);
  return {
    tone: 'ok',
    headline: age
      ? `${ok} 个能备的目标都有 ${age}的副本`
      : `${ok} 个能备的目标都拿到了最近一轮的副本`,
    subline: unsupported > 0 ? `这类还备不了 ${unsupported} 个` : null,
  };
}
