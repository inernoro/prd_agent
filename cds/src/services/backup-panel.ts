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

import {
  backupKey, isAutoBackupFile, backupKindOf, classifyBackupCoverage, INFRA_BACKUP_INTERVAL_MS,
} from './infra-backup-schedule.js';
import { detectInfraKind } from './infra-exposure-audit.js';
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
 * - `unprotected` 这台服务**有数据**，而这套周期备份接不了它 → 得另想办法，等于没有备份
 * - `unsupported` 这类**没有需要备份的状态**（memcached 重启即空、没开 JetStream 的 nats）
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
 *
 * `unprotected` 与 `unsupported` 原来是同一档，那是**假绿灯**（Codex review 第五轮 P1）：
 * 一台跑着的 MinIO 有满桶对象、这套 dump 式备份接不了它，落盘时记的是一条 `blocksHealthy`
 * 的缺口——它拉低整轮健康，页脚的每日体检据此喊「覆盖不全」，而第一屏当时把它和
 * memcached 归成一句「这类还备不了」，然后照样报绿。同一屏自己打自己，而绿的那一半
 * 是错的：一个只有 MinIO 的项目，数据一份副本都没有，头条却写着「都有副本」。
 *
 * 分开的判据**不用新猜**：`classifyBackupCoverage` 早就把这件事算出来了（`blocksHealthy`
 * 为真 = 有数据没被保护，为假 = 本来就没有需要备份的状态）。这里之前是把那一位丢掉了
 * （形状 6：读到的不是真正生效的那个值）。
 */
export type BackupTargetStatus =
  | 'failed' | 'artifact-missing' | 'not-in-last-round' | 'offsite-only' | 'partial'
  | 'unprotected' | 'unsupported' | 'ok';

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
  /**
   * 此刻在不在跑。省略视为在跑。
   *
   * **停着的也要传进来**（Codex review 第八轮 P2）：只传正在跑的，判定这一侧就分不清
   * 「这个项目一台数据服务都没有」和「有，但此刻都停着」。前者可以放心说「没有需要
   * 周期备份的服务」，后者说这句话就是假绿灯——那台停着的库可能装着数据、且从没备过。
   * 停着的服务本身仍然不进目标清单（运维故意停掉的不该天天报警，见第三轮），
   * 但这一侧得知道它存在。
   */
  running?: boolean;
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
  /**
   * 这个项目压根没有需要周期备份的东西（只有无状态服务，或一台数据服务都没有）。
   *
   * 路由拿它决定页脚那几条体检结论**整段不出**：没有备份可言时，「读不到上一轮结果」
   * 与「从来没做过恢复演练」都无从谈起，而它们会以 critical 出现在一个头条写着
   * 「没有需要周期备份的服务」的页面上。算在这里、读在那边，不给它第二个口径。
   */
  nothingToBackUp: boolean;
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
  // 存量文件里可能没有 projectId（这个字段是 2026-08-28 才补的）。**不许猜**：
  // 猜错的后果是把别的项目的服务摆进这个项目的清单，而那正是要防的事。
  return String(entry.projectId || '') === projectId;
}

/**
 * 成功记录的项目归属。比 `sameProject` 多一条**证据**级的兜底（Codex review 第六轮 P2）。
 *
 * 升级后的第一次打开面板时，盘上那份健康文件还是旧代码写的：`objects[]` 有 `fileName`、
 * 没有 `projectId`。只按 `projectId` 筛的话，上一轮**所有成功的目标**会被整批丢掉，而清单
 * 又从台账把这些库原样加回来——于是每个项目在升级后的头一轮里，都会看到一屏「上一轮备份里
 * 没有它」。备份明明好好地跑着，面板张口就说没备到，这是升级即触发的假警报。
 *
 * 但也不能退回「没有 projectId 就当是我的」——那正是上面那条注释在防的事。所以这里用的不是
 * 猜测而是证据：`fileName` 从来就是带项目段的（`{project}--{id}-auto-{时间}.{ext}`，写入端
 * 一直如此），文件名自己说明了归属。只在 `projectId` **缺失**时才看它；`projectId` 明确写着
 * 别的项目时一律以它为准，文件名不许翻案。两条都无从判断的记录仍然丢弃。
 */
function ownedObject(
  entry: { id?: string; projectId?: string | null; fileName?: string },
  projectId: string,
): boolean {
  if (String(entry.projectId || '')) return sameProject(entry, projectId);
  const file = String(entry.fileName || '').trim();
  return Boolean(file) && isAutoBackupFile(file, projectId, String(entry.id || ''));
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

  // 成功记录多一条按文件名认领的兜底：升级后的第一轮里，旧格式的成功记录不能被整批
  // 丢掉，否则清单会把这些库当成「上一轮没备到」（见 ownedObject 的注释）。
  const objects = (health?.objects || []).filter((o) => o?.id && ownedObject(o, projectId));
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
  // 台账里这个项目的全部数据服务（含停着的）。**目标清单只并正在跑的**（第三轮：
  // 运维故意停掉的不该天天报「上轮没备到」），但「一台都没有」这件事要另算，
  // 见下面的 nothingToBackUp。
  const infraAll = (input.infra || []).filter((s) => s?.id);
  const infraById = new Map(
    infraAll.filter((s) => s.running !== false).map((s) => [String(s.id), s]),
  );
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
    const hints = { id, containerName: infraFact?.containerName };
    const image = String(infraFact?.dockerImage || '');
    const backupCapable = onlyInInventory ? Boolean(backupKindOf(image, hints)) : false;
    // 备不了的类型还要再分一次：**有数据没被保护** vs **本来就没有需要备份的状态**。
    // 判据不在这里另猜，问 classifyBackupCoverage 那一份（形状 3）。
    //
    // 落盘的 coverageGaps 已经被 `backupCoverageGaps` 按 `blocksHealthy` 筛过一遍，
    // 所以「上一轮记了缺口、又没有产物」这种目标**按构造就是有数据没被保护**，
    // 不必再判一次。台账里那些上一轮压根没出现的，才需要现算。
    //
    // 已知边界：现算时手上只有镜像名与 id/容器名，没有 env 与启动命令，于是一台
    // 开了 JetStream 的 nats 会被算成「没有持久状态」而不出声。只在「它还没进过任何
    // 一轮」的窗口里成立——进过一轮之后就走上面那条按构造的路。记在台账 E88。
    const inventoryBlocks = onlyInInventory && !backupCapable
      ? classifyBackupCoverage(detectInfraKind(image, hints)).blocksHealthy
      : false;
    const status: BackupTargetStatus = failedById.has(id)
      ? 'failed'
      : artifactMissing
        ? 'artifact-missing'
        : onlyInInventory
          ? (backupCapable ? 'not-in-last-round' : (inventoryBlocks ? 'unprotected' : 'unsupported'))
          : offsiteById.has(id)
            ? 'offsite-only'
            : gap
              ? (object ? 'partial' : 'unprotected')
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
            ? cleanReason(classifyBackupCoverage(detectInfraKind(image, hints)).reason)
              ?? `这个类型（${image || '未知镜像'}）目前还没有周期备份手段`
            : status === 'offsite-only'
          ? cleanReason(offsiteById.get(id)?.reason)
          : (status === 'partial' || status === 'unprotected')
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
  const nothingToBackUp = computeNothingToBackUp(targets, input.infra ? infraAll.length : null);

  return {
    lastRoundAt: health?.completedAt ?? null,
    nextRoundEstimatedAt: Number.isFinite(lastRoundMs)
      ? new Date(lastRoundMs + intervalMs).toISOString()
      : null,
    localVerifiedAt: health?.localVerifiedAt ?? null,
    remoteVerifiedAt: health?.remoteVerifiedAt ?? null,
    verdict: buildVerdict(targets, health, now, nothingToBackUp),
    /** 这个项目压根没有需要周期备份的东西——页脚据此整段不出，见 computeNothingToBackUp。 */
    nothingToBackUp,
    targets,
    files: {
      count: mine.length,
      bytes: mine.reduce((sum, f) => sum + (Number.isFinite(f.bytes) ? f.bytes : 0), 0),
    },
  };
}

/**
 * 这个项目**压根没有需要周期备份的东西**吗？
 *
 * 两种都算，判据不一样：
 *
 * - 有目标：**每一个**都得是「没有需要备份的状态」（memcached 重启即空、没开
 *   JetStream 的 nats）。只要有一个该备的目标，答案就是否。
 * - 一个目标都没有：台账里这个项目**一台数据服务都没有**时才算。有、只是此刻都停着
 *   的，不算——那台停着的库可能装着数据、且从没备过，说「没有需要周期备份的服务」
 *   就是假绿灯（Codex review 第八轮 P2 提的是「零目标也该豁免」，但照字面放开会
 *   踩这个坑，所以判据落在「台账里有没有」而不是「目标列表空不空」）。
 *
 * 算出来的结果**挂在 view 上**给页脚用，不导出一个让调用方各跑一遍的函数：第七轮
 * 页脚与第一屏各写一份语义，就是第六轮那条漂移的成因；一处算、一处读，才没有第二个口径。
 */
function computeNothingToBackUp(
  targets: readonly BackupPanelTarget[],
  infraCount: number | null,
): boolean {
  // `infraCount` 为 null = 调用方没给台账，也就是**不知道**这个项目有没有数据服务。
  // 不知道不等于没有：这种时候不下「没有需要备份的东西」这个结论（读不到就说读不到，
  // 是这套体检的第一条纪律）。只有台账真的报了「零台」才算。
  if (targets.length === 0) return infraCount === 0;
  return targets.every((t) => t.status === 'unsupported');
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
  nothingToBackUp: boolean,
): BackupPanelView['verdict'] {
  const count = (s: BackupTargetStatus): number => targets.filter((t) => t.status === s).length;
  const failed = count('failed');
  const missing = count('artifact-missing');
  const uncovered = count('not-in-last-round');
  const offsite = count('offsite-only');
  const partial = count('partial');
  const unprotected = count('unprotected');
  const unsupported = count('unsupported');
  const ok = count('ok');

  const rest: string[] = [];
  if (ok > 0) rest.push(`正常 ${ok} 个`);
  if (unprotected > 0) rest.push(`没有备份保护 ${unprotected} 个`);
  if (unsupported > 0) rest.push(`没有需要备份的状态 ${unsupported} 个`);
  const subline = rest.length > 0 ? rest.join(' · ') : null;

  // 全是「没有需要备份的状态」的项目，判在读不到之前（Codex review 第六轮 P2）。
  // 同一个结论也挂在 view 上给页脚用（`nothingToBackUp`）：各写一份就会出现
  // 「头条说不用管、页脚喊 critical」（Codex review 第七轮 P2）。
  // 一台只跑 memcached 的部署，排程压根没有目标、也没有阻塞缺口，于是**从来不写**
  // 那份结果文件；读不到是这种部署的常态，不是故障。判在后面的话，它会永远挂着
  // 一句「不确定这个项目备份过没有」——一盏永远亮着、又永远不用管的灯。
  //
  // 判据收得很紧：必须**有目标**且**每一个**都是「没有需要备份的状态」。只要有一个
  // 该备的目标，读不到结果就仍然是坏消息。
  if (nothingToBackUp) {
    return { tone: 'ok', headline: '这个项目没有需要周期备份的服务', subline: null };
  }
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
  // 时间读不出来（字段缺了、写坏了）**不能当没这回事**（Codex review 第五轮 P1）。
  // 上一版只在时间有效时才判陈旧，无效就直接落到绿色分支——而绿的那句话恰恰在说
  // 「都拿到了最近一轮的副本」，一个说不出年龄的轮次凭什么叫「最近」。每日体检对
  // 同一份记录报的是 critical 的 `backup.unknown`，这里必须同调。
  if (!Number.isFinite(roundAt)) {
    return {
      tone: 'bad',
      headline: '上一轮备份没有记下完成时间，说不出手上这批副本是什么时候的',
      subline,
    };
  }
  const staleBy = now.getTime() - roundAt;
  if (staleBy > BACKUP_STALE_AFTER_MS) {
    return {
      tone: 'bad',
      headline: `周期备份已经 ${Math.floor(staleBy / 3_600_000)} 小时没跑了，手上最新的副本就停在那一轮`,
      subline,
    };
  }
  // 排在陈旧之后：调度器死了是「这一轮出事了」，这条是「这台服务从来就不在保护范围里」，
  // 后者急不到前面去。但它必须在绿色之前——有数据没被保护，就不能报绿。
  if (unprotected > 0) {
    return {
      tone: 'warn',
      headline: `${unprotected} 个服务有数据，这套周期备份接不了它们，等于没有备份`,
      subline,
    };
  }

  const age = relativeAge(now, health.completedAt ?? null);
  if (ok === 0) {
    // 走到这里说明剩下的目标全是「没有需要备份的状态」那一类。原来这句会写成
    // 「0 个能备的目标都有 3 小时前的副本」——一句自己都不通的话。
    return { tone: 'ok', headline: '这个项目没有需要周期备份的服务', subline: null };
  }
  return {
    tone: 'ok',
    headline: age
      ? `${ok} 个能备的目标都有 ${age}的副本`
      : `${ok} 个能备的目标都拿到了最近一轮的副本`,
    subline: unsupported > 0 ? `没有需要备份的状态 ${unsupported} 个` : null,
  };
}
