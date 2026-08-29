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

import { backupKey, isAutoBackupFile, backupKindOf, INFRA_BACKUP_INTERVAL_MS } from './infra-backup-schedule.js';
// 陈旧阈值走每日体检那一份，不在这里另定一个数：两处各写一个数字，页脚说「已经陈旧」
// 而第一屏还是绿的，就是同一屏自相矛盾（形状 3）。
import { BACKUP_STALE_AFTER_MS } from './platform-daily-health.js';

/**
 * 一个目标这一轮的处境。**五档不能合并**——每一档要人做的事都不一样：
 *
 * - `failed`      本地就没导出来，手上没有它的新副本 → 得去修这台服务
 * - `artifact-missing` 那一轮导出成功了，但**产物此刻不在盘上** → 得去查文件哪去了
 * - `not-in-last-round` 这台服务现在跑着，但**上一轮备份里压根没有它** → 见下
 * - `offsite-only` 本地那份已过校验、就在盘上，只是离机没上去 → 得去修离机通道
 * - `partial`     备成功了，但导出脚本自报只覆盖到一部分（如 postgres 只导了一个库）
 * - `unsupported` 这个类型压根还备不了（如 MinIO 要桶到桶复制，不是一份 dump）
 * - `ok`          正常
 *
 * `failed` 与 `offsite-only` 合并过一次，后果是把运维支去找一份其实存在的备份
 * （见 platform-daily-health 里那两条 finding 的注释）。这里不再重犯。
 *
 * `artifact-missing` 是 Codex review P1 补的一档，它防的正是这一整批改动要治的病：
 * 健康文件说「这一轮导出成功了」，而那个文件已经被删掉/移走/盘坏了——只读健康记录
 * 就会把它报成「正常」，**等到真要恢复的那天才发现产物不在**。落盘记录只能证明
 * 当时产出过，证明不了此刻还在，所以要拿盘上的实际文件再核一遍。
 *
 * `not-in-last-round` 是同一个病的另一面（Codex review 第二轮 P1）：清单只从上一轮的
 * 记录来，于是**上一轮之后才建的库**、以及**当时容器停着的服务**，在这一屏上压根不存在，
 * 而第一屏还在宣布「N 个能备的目标都有 3 小时前的副本」。一台从没备过的库看不见，
 * 比看见它红着更危险。所以目标清单要并上**这个项目此刻真实跑着的数据服务**。
 */
export type BackupTargetStatus =
  | 'failed' | 'artifact-missing' | 'not-in-last-round' | 'offsite-only' | 'partial' | 'unsupported' | 'ok';

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

/**
 * 这个项目此刻真实存在的一台数据服务（取自基础设施台账）。
 *
 * 面板不能只看上一轮的记录：上一轮之后才建的库、当时容器停着的服务，在记录里
 * 一个字都没有，于是从清单上消失——而消失的东西没人会去管它。
 */
export interface BackupInfraFact {
  id: string;
  dockerImage?: string;
  containerName?: string;
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
  /**
   * 这个项目此刻跑着的数据服务。**要传**：不传的话清单只有上一轮记录里的那些，
   * 新建的库和当时停着的服务会从面板上整个消失（Codex review 第二轮 P1）。
   */
  infra?: readonly BackupInfraFact[];
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

  // 台账里此刻真实存在的服务。它和上一轮的记录**取并集**——只取记录会漏掉新建的库，
  // 只取台账会漏掉上一轮记过、此刻已不在台账里的那些。
  //
  // 并集里**没有**第三个来源：盘上的文件名。所以一个服务被删掉、之后又跑过一轮
  // （记录被重写、它不在里面了）时，它盘上留存的备份仍然会被页脚算进份数，却没有
  // 任何一行对应得上——文件在，说不出是谁的。这是已知边界，记在台账 E86，下面
  // 有一条用例把这个现状钉住：真去做的时候那条会红，逼人回来一起把「哪些目标该出现
  // 在这一屏」重新想一遍，而不是再补第四块补丁。
  const infraById = new Map((input.infra || []).filter((s) => s?.id).map((s) => [String(s.id), s]));
  const ids = [...new Set([
    ...objectById.keys(),
    ...failedById.keys(),
    ...offsiteById.keys(),
    ...gapById.keys(),
    ...infraById.keys(),
  ])].sort();

  // 盘上到底有哪些文件。**判据要拿这个再核一遍产物**，不能只信健康记录：
  // 记录只证明「那一轮产出过」，证明不了「此刻还在」（Codex review P1）。
  const present = new Set(mine.map((f) => f.name));

  const targets: BackupPanelTarget[] = ids.map((id) => {
    const object = objectById.get(id);
    const own = mine.filter((f) => isAutoBackupFile(f.name, projectId, id));
    const stamps = own.map((f) => parseAutoBackupStamp(f.name)).filter((s): s is string => Boolean(s));
    stamps.sort();
    // 优先级不能乱：一个目标同时出现在「失败」和「缺口」里时，要先说它没备成——
    // 「备到一部分」是成功之后才谈得上的事。
    const gap = gapById.get(id);
    // 产物不见了，只对「这一轮真的产出过一个文件」的目标才谈得上。
    // 记录里没有 fileName（早期格式）时**不下这个结论**：证明不了它不在，
    // 而把一整批存量记录误报成「产物不在了」，比漏报更糟——那种一响就响一片的
    // 告警没人会看，正是这套体检要避免的。
    const recordedFile = String(object?.fileName || '').trim();
    const artifactMissing = Boolean(recordedFile) && !present.has(recordedFile);
    // 上一轮的记录里一个字都没提到它。分两种：本来就备不了的类型（归「还备不了」，
    // 不必惊动人），和本该能备却没出现的（新建的库、当时容器停着的）——后者手上
    // 可能一份副本都没有，必须说出来。能不能备走 backupKindOf 这一份判据，
    // 不在这里另猜一套（形状 3）。
    const onlyInInventory = !object && !failedById.has(id) && !offsiteById.has(id) && !gap;
    const infraFact = infraById.get(id);
    const backupCapable = onlyInInventory
      ? Boolean(backupKindOf(String(infraFact?.dockerImage || ''), {
        id,
        containerName: infraFact?.containerName,
      }))
      : false;
    const status: BackupTargetStatus = failedById.has(id)
      ? 'failed'
      : artifactMissing
        ? 'artifact-missing'
        : onlyInInventory
          ? (backupCapable ? 'not-in-last-round' : 'unsupported')
          : offsiteById.has(id)
            ? 'offsite-only'
            : gap
              ? (object ? 'partial' : 'unsupported')
              : 'ok';
    const reason = status === 'failed'
      ? cleanReason(failedById.get(id)?.reason)
      : status === 'artifact-missing'
        ? `上一轮导出的产物 ${recordedFile} 现在不在备份目录里——被删了、被移走了，或者盘出了问题`
        : status === 'not-in-last-round'
          ? (stamps.length > 0
            ? '上一轮备份里没有它：可能当时容器没跑。盘上还留着更早的副本，但不是最新的'
            : '上一轮备份里没有它，盘上也没有任何副本——它可能是上一轮之后才建的，等下一轮；也可能一直没被备份到')
          : onlyInInventory
            ? `这个类型（${String(infraFact?.dockerImage || '未知镜像')}）目前还没有周期备份手段`
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
  const missing = count('artifact-missing');
  const uncovered = count('not-in-last-round');
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
  if (missing > 0) {
    return {
      // 与 failed 同一档：两者的结果一样——真要恢复的时候手上没有那份文件。
      tone: 'bad',
      headline: `${missing} 个目标上一轮备出来的产物，现在不在盘上了`,
      subline,
    };
  }
  if (uncovered > 0) {
    return {
      // 比「离机没上去」重：那类手上还有一份本地副本，这类可能一份都没有。
      tone: 'warn',
      headline: `${uncovered} 个正在跑的服务，上一轮备份里没有它们`,
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
  // **排程停摆要在第一屏说**（Codex review 第三轮 P1）。走到这里说明上一轮里每个目标
  // 都成了，但「那一轮」可能是几天前——调度器死了、容器没起来、机器关了都会这样。
  // 只看目标状态就会给出绿色大字，而页脚的每日体检同时在喊「已经陈旧」：同一屏
  // 自己打自己。判据与页脚共用 BACKUP_STALE_AFTER_MS，不另定一个数。
  const roundAt = Date.parse(String(health.completedAt || ''));
  const staleBy = Number.isFinite(roundAt) ? now.getTime() - roundAt : null;
  if (staleBy !== null && staleBy > BACKUP_STALE_AFTER_MS) {
    return {
      tone: 'bad',
      headline: `周期备份已经 ${Math.floor(staleBy / 3_600_000)} 小时没跑了，手上最新的副本就停在那一轮`,
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
