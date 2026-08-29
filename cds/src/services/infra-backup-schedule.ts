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

import { detectInfraKind, type InfraKindHints } from './infra-exposure-audit.js';
import { maskSecrets } from './secret-masker.js';

/**
 * 每一轮周期备份的结果文件，落在备份目录里。
 *
 * 放在这里是因为它已经有**三个**消费者：写它的 index.ts、每日体检读它、项目设置的
 * 备份面板读它。各写各的字面量的话，谁改一个字母，其余两处会静默读不到——
 * 而「读不到」和「没备份过」长得一模一样，正是这条链路上最不该再犯的错。
 */
export const INFRA_BACKUP_HEALTH_FILE = '.cds-backup-health.json';

/**
 * 基础设施自动备份间隔。手工备份的实际含义是「出事那天正好没人点」。
 * 6 小时一轮：mongodump 有成本，但一天四份 + 保留策略的磁盘占用是可控的。
 *
 * 放在这里是因为它有第二个消费者：备份面板要按它推「下一轮大概什么时候」。
 * 两边各写一个 6，改一处忘一处，面板就会给出一个与实际节奏对不上的预估。
 */
export const INFRA_BACKUP_INTERVAL_MS = 6 * 60 * 60_000;

export type BackupKind = 'mongo' | 'redis' | 'mysql' | 'postgres' | 'rabbitmq' | 'nacos';

export interface BackupCandidate {
  id: string;
  projectId: string;
  containerName: string;
  dockerImage: string;
  running?: boolean;
  env?: Record<string, string> | null;
  /**
   * CDS 当初用来**启动**这个容器的命令。redis 的口令常常只存在于这里
   * （容器里扫不到——redis 会改写自己的 argv），所以它是凭据的权威来源之一。
   * 必须显式声明：靠 `{...s}` 展开把它带进来是「碰巧能跑」，
   * 字段一旦改名，编译器一声不吭，凭据静默变空。
   */
  command?: string[] | string | null;
  /**
   * `docker run --entrypoint` 覆盖。和 `command` 一样必须**显式声明**，理由同上。
   *
   * 为什么备份判据要看它：一个自定义 nats 完全可以只写
   * `entrypoint: ['nats-server', '--jetstream']` 而不写 `command`。判据只看
   * command 和 env 的话，这台开着 JetStream 的 nats 会被判成「没有持久状态」
   * ——不进缺口、不挡健康位，于是**整轮备份报健康，而它的流和消费者位点一份
   * 备份都没有**（Codex review P1）。
   */
  entrypoint?: string[] | string | null;
}

export interface BackupTarget extends BackupCandidate {
  kind: BackupKind;
  /** 落盘文件名（不含目录）。 */
  fileName: string;
}

export interface BackupPlan {
  targets: BackupTarget[];
  /**
   * 跳过的原因，逐条可解释——「这次没备份什么」和「备份了什么」同样重要。
   *
   * 带 projectId：infra id 只在项目内唯一。项目设置里的备份面板要按项目筛，
   * 不带作用域就会把别的项目的 minio 摆到这个项目的清单里（同 BackupOutcome）。
   */
  skipped: Array<{ id: string; projectId?: string; reason: string; blocksHealthy: boolean }>;
}

/** 默认保留：每个服务最近 7 份，且不超过 14 天。 */
export const DEFAULT_KEEP_COUNT = 7;
export const DEFAULT_KEEP_DAYS = 14;

/**
 * 磁盘下限。低于这个可用空间就不备份——宁可这一轮没有新备份，也不能把根盘写满
 * 拖垮整台机器。2 GiB 是「一份 mongodump 加解压余量」的保守估计。
 */
export const DEFAULT_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * 备份落盘目录的候选，按优先级排列。
 *
 * 原来写死 `/data/cds/<slug>/backups`。那个路径在部分宿主上**根本不存在**，
 * 而手工备份那条路径的 `ls` 带着 `2>/dev/null`，目录不存在时返回的是「没有备份」
 * ——和「备份过但列表为空」长得一模一样。于是「一份备份都没有」这件事可以一直
 * 不被发现，直到真的需要恢复。
 *
 * 现在给一串候选让调用方逐个试写，并把**实际选中的那个**报出来：
 *
 * 1. `CDS_BACKUP_DIR` —— 运维显式指定，优先级最高
 * 2. `/data/cds/<slug>/backups` —— 历史路径，存量部署继续用它
 * 3. `<repoRoot>/../cds-backups` —— 兜底。repoRoot 是 CDS 必然可写的地方，
 *    放在它旁边而不是里面，避免被 git 操作和自更新波及
 *
 * 自动备份与手工备份必须走同一份候选，否则两边落在不同目录，
 * 「备份历史」会看不见自动备份——那又是一次「以为有、其实没有」。
 */
export function backupDirCandidates(opts: {
  slug: string;
  repoRoot?: string;
  env?: Record<string, string | undefined>;
}): string[] {
  const env = opts.env ?? process.env;
  const out: string[] = [];
  const explicit = (env.CDS_BACKUP_DIR || '').trim();
  if (explicit) out.push(explicit.replace(/\/+$/, ''));
  out.push(`/data/cds/${opts.slug}/backups`);
  if (opts.repoRoot) {
    const parent = opts.repoRoot.replace(/\/+$/, '').replace(/\/[^/]*$/, '');
    if (parent) out.push(`${parent}/cds-backups/${opts.slug}`);
  }
  return [...new Set(out)];
}

/** 有成熟一致性导出手段的类型。不在这个集合里的，不假装能备。 */
const BACKUP_CAPABLE_KINDS = new Set<string>(['mongo', 'redis', 'mysql', 'postgres', 'rabbitmq', 'nacos']);

/**
 * 没被周期备份覆盖的服务，究竟属于哪一类。
 *
 * ## 为什么要分类
 *
 * 原来所有备不了的类型共用一句「暂不支持自动备份的类型」，并且一律 `blocksHealthy`。
 * 这一句话把三件完全不同的事说成了同一件：
 *
 * - memcached 压根没有持久化功能，重启即空**是它的设计**，没有东西可丢；
 * - MinIO 里放着真实文件，它需要的是桶到桶复制，不是一份 dump；
 * - SQL Server 有标准的 `BACKUP DATABASE`，只是我们还没接。
 *
 * 后果不只是措辞难看。任何项目只要跑着一个 memcached 或 nats，
 * `isBackupRoundHealthy` 就**永远为假**——于是这个健康位从上线那天起就是红的，
 * 红了几个月和绿了几个月对磁盘上的备份份数没有任何区别，没人会因为它去补什么。
 * 这正是 postgres 那条（E48）被埋了三个月的形状：一个长期红着、没人当真的灯。
 *
 * 所以现在分开：**真的有东西可丢**才算缺口（红灯），没有持久状态的不算，
 * 而算缺口的那些要在原地说清「缺的是哪一套手段」，让看到的人知道下一步该做什么。
 */
export type BackupCoverageBucket =
  /** 有成熟导出手段并且已经接上。 */
  | 'covered'
  /** 有持久数据，但要用另一套机制（不是一份 dump 文件）。 */
  | 'different-mechanism'
  /** 有标准 dump 手段，只是还没接。 */
  | 'not-yet'
  /** 没有需要备份的持久状态。 */
  | 'no-durable-state'
  /** 认不出是什么。未知一律从严。 */
  | 'unknown';

export interface BackupCoverageVerdict {
  bucket: BackupCoverageBucket;
  /** 一句话说清「为什么没备 + 该用什么」，直接进跳过原因。 */
  reason: string;
  /** 算不算真实缺口——只有它为真才拖垮整轮健康状态。 */
  blocksHealthy: boolean;
}

/** JetStream 一开，nats 就有了落盘的流和消费者位点，「没有持久状态」立刻不成立。 */
function natsHasJetStream(
  env?: Record<string, string> | null,
  command?: string[] | string | null,
  entrypoint?: string[] | string | null,
): boolean {
  // 三处都要看：JetStream 的开关写在 command、entrypoint、env 里都合法，
  // 少看一处就是一台真开着 JetStream 的 nats 被判成「没有持久状态」。
  const flatten = (v?: string[] | string | null) => (Array.isArray(v) ? v.join(' ') : String(v || ''));
  const envText = Object.entries(env || {}).map(([k, v]) => `${k}=${v}`).join(' ');
  const joined = `${flatten(command)} ${flatten(entrypoint)} ${envText}`;
  // 命令行开关、配置块、以及官方镜像认的那个环境变量，三种写法都要认。
  return /(^|\s)(-js|--jetstream)(\s|$)/.test(joined)
    || /jetstream\s*[{:]/i.test(joined)
    || /\bJS_ENABLED=(1|true|yes)\b/i.test(joined);
}

/**
 * 这个服务在备份上处于什么位置。
 *
 * 判据只看类型（外加 nats 的 JetStream 开关），不看镜像名——「这是什么库」那份判据
 * 已经收敛到 `detectInfraKind`，这里不再开第二个口径（形状 3）。
 */
export function classifyBackupCoverage(
  kind: string,
  opts: {
    env?: Record<string, string> | null;
    command?: string[] | string | null;
    entrypoint?: string[] | string | null;
  } = {},
): BackupCoverageVerdict {
  if (BACKUP_CAPABLE_KINDS.has(kind)) {
    return { bucket: 'covered', reason: '已纳入周期备份', blocksHealthy: false };
  }
  switch (kind) {
    // 'nacos' 走上面的 covered 分支，这里不再列——它一度被归进「认不出的服务」，
    // 而线上真有两台在跑、零备份，靠的正是「认不出就当有数据」那条兜底把它留在缺口里。
    case 'minio':
      return {
        bucket: 'different-mechanism',
        blocksHealthy: true,
        reason: 'MinIO 里是对象文件，导不成一份 dump：要的是桶到桶复制（`mc mirror` 到另一个'
          + '端点或另一台机器）。这条不是「还没做」，是需要另立一套离机复制，本周期备份不覆盖',
      };
    case 'kafka':
      return {
        bucket: 'different-mechanism',
        blocksHealthy: true,
        reason: 'Kafka 的数据是分区日志加消费位点，没有一致性快照命令：要的是 MirrorMaker 2 '
          + '往另一个集群持续复制。这条同样是另一套机制，不是本周期备份能接的',
      };
    case 'elasticsearch':
      return {
        bucket: 'different-mechanism',
        blocksHealthy: true,
        reason: 'Elasticsearch 只能走快照 API，而快照要先注册一个仓库（本地路径或 S3）并写进'
          + '节点配置，容器里一条命令做不到。要备它得先把仓库配起来',
      };
    case 'sqlserver':
      return {
        bucket: 'not-yet',
        blocksHealthy: true,
        reason: 'SQL Server 有标准的 `BACKUP DATABASE ... TO DISK`，只是还没接进来——这条是欠账，不是做不到',
      };
    case 'clickhouse':
      return {
        bucket: 'not-yet',
        blocksHealthy: true,
        reason: 'ClickHouse 有 `BACKUP TABLE ... TO Disk()`，只是还没接进来——这条是欠账，不是做不到',
      };
    case 'memcached':
      return {
        bucket: 'no-durable-state',
        blocksHealthy: false,
        reason: 'memcached 没有持久化功能，重启即空是它的设计，没有需要备份的状态',
      };
    case 'nats':
      return natsHasJetStream(opts.env, opts.command, opts.entrypoint)
        ? {
          bucket: 'not-yet',
          blocksHealthy: true,
          reason: '这个 nats 开了 JetStream，流和消费者位点是会落盘的持久状态，需要单独备份（还没接）',
        }
        : {
          bucket: 'no-durable-state',
          blocksHealthy: false,
          reason: '这个 nats 没开 JetStream，消息只在内存里中转，没有需要备份的持久状态',
        };
    default:
      // 认不出来就当它有数据。把未知当安全是这类判定最常见的失效方式。
      return {
        bucket: 'unknown',
        blocksHealthy: true,
        reason: '认不出这是什么服务，无法判断有没有需要备份的数据——按「有」处理',
      };
  }
}

/**
 * 这个服务该用哪种方式备份。
 *
 * ## 为什么不自己再判一遍镜像名
 *
 * 「这是个什么库」这件事，本仓库一度有三份各自演化的判据：本函数、下载端点里的
 * `detectKind`、以及暴露面自检的 `detectInfraKind`。三份都靠 `image.includes(...)`，
 * 但覆盖的类型各不相同——postgres 在自检里认得出、在这里认不出，于是同一台库
 * 「安全面知道它是 postgres」而「备份面把它当不认识的类型跳过」。
 * 这正是 predicate-and-wiring-discipline 形状 3（判据分裂后各自漂移）。
 *
 * 现在只保留一份判据（`detectInfraKind`，它还能用 id / 容器名兜底，认得出私有仓库
 * 那种名字里不含产品名的镜像），本函数只负责回答「这个类型我们有没有导出手段」。
 */
export function backupKindOf(dockerImage: string, hints: InfraKindHints = {}): BackupKind | null {
  const kind = detectInfraKind(dockerImage, hints);
  return BACKUP_CAPABLE_KINDS.has(kind) ? (kind as BackupKind) : null;
}

/**
 * 备份文件名。
 *
 * 时间戳用 ISO 去掉分隔符，保证**字典序等于时间序**——保留策略靠排序选旧的，
 * 名字排不出顺序就会删错。`auto` 段把周期备份和 restore 前的 `pre-restore`
 * 快照区分开：后者是救命用的，不该被周期清理顺手删掉。
 */
const BACKUP_EXT: Record<BackupKind, string> = {
  mongo: 'archive.gz',
  redis: 'rdb',
  mysql: 'sql.gz',
  postgres: 'sql.gz',
  // definitions 是 JSON，不是 SQL。扩展名要能让人一眼知道这份东西该怎么灌回去。
  rabbitmq: 'json.gz',
  // 每个命名空间一个 zip，打成一包再压——`.gz` 结尾还顺带让上游的 `gzip -t`
  // 完整性校验自动生效（那一步只对 `.gz` 跑）。
  nacos: 'tar.gz',
};

/**
 * 备份文件的项目内唯一前缀。
 *
 * **infra id 只在项目内唯一，不是全局唯一**——这台机器上六个项目各有一个叫
 * `redis` 的服务。只用 id 命名，一轮备份里它们算出的文件名完全相同（同一轮共用
 * 一个时间戳），后写的直接覆盖先写的，而保留策略还把它们当同一组算份数。
 * 结果是日志显示「成功 6 个」、磁盘上只有 1 个，另外五个项目实际零备份。
 *
 * 首轮实跑的输出里就有这个形状（四条同名 `redis`），当时没看出来。
 */
/**
 * 一条能写进健康文件、也能端到用户面前的失败原因。
 *
 * 两件事必须做，缺一件都不该落盘：
 *
 * - **脱敏**：原文是 `docker exec` 的合并输出，里面可能带着容器 env 打出来的口令。
 *   健康文件是 0600，但它会经备份面板端点回到浏览器——换个地方泄漏还是泄漏。
 * - **截尾不截头**：失败原因永远在输出末尾，`slice(0, N)` 会把它整段切掉，
 *   只留一堆启动噪音（本仓库同一个口径分散过七处，见 infra-backup 路由的 outputTail）。
 *
 * 空字符串返回 undefined：「没有原因」和「原因是空字符串」在界面上是两种东西，
 * 前者该什么都不显示，后者会渲染出一个空的展开区。
 */
export function backupFailureReason(error: string | undefined | null): string | undefined {
  const masked = maskSecrets(String(error || '').trim(), { mask: true }).trim();
  if (!masked) return undefined;
  return masked.length > 300 ? `…（前文截断）${masked.slice(-300)}` : masked;
}

export function backupKey(projectId: string, id: string): string {
  const safe = (v: string): string => String(v || '').replace(/[^a-zA-Z0-9._-]/g, '-');
  return `${safe(projectId)}--${safe(id)}`;
}

export function backupFileName(projectId: string, id: string, kind: BackupKind, iso: string): string {
  const stamp = iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${backupKey(projectId, id)}-auto-${stamp}.${BACKUP_EXT[kind]}`;
}

/**
 * 是不是**这个项目的这个服务**产出的周期备份。
 *
 * 只认自己那一组：既不碰别人的文件，也不碰别的项目同名服务的文件——后者会让
 * A 项目的清理把 B 项目的备份算进份数一起删掉。
 */
export function isAutoBackupFile(name: string, projectId: string, id: string): boolean {
  return name.startsWith(`${backupKey(projectId, id)}-auto-`);
}

/**
 * 文件名里 key 之后的那一段，标明这份备份是怎么来的。
 *
 * 必须是一份**闭合的枚举**，不能拿 `${key}-` 当前缀了事：id 之间会互相撞前缀，
 * `proj-a--redis-` 正好是 `proj-a--redis-cache-auto-…` 的前缀，于是 `redis` 的
 * 备份历史里会混进邻居服务 `redis-cache` 的文件。新增备份种类时加在这里，
 * 让写入端和读取端只有这一处需要同步。
 */
const BACKUP_KIND_SEGMENTS = ['auto', 'pre-restore'] as const;

/**
 * 备份目录里，哪些文件是**这个项目的这个服务**的（周期的、恢复前快照的，都算）。
 *
 * 写入端已经按项目限定了文件名，读取端却还在用 `grep <id>` 扫共享目录——两个项目
 * 各有一个 `redis` 时，A 的备份历史里会混进 B 的文件名、大小和时间；`grep` 还是
 * 子串匹配，`redis` 会连 `redis-cache` 一起捞出来。写入端修了、读取端没跟上，
 * 这是同一处漏洞的另一半（Codex review P2，2026-08-16）。
 *
 * 判据只有这一份，读写共用，避免下一次只改一边。
 */
export function isProjectBackupFile(name: string, projectId: string, id: string): boolean {
  const key = backupKey(projectId, id);
  return BACKUP_KIND_SEGMENTS.some((seg) => name.startsWith(`${key}-${seg}-`));
}

/**
 * 项目限定命名之前留下的旧文件（`<id>-pre-restore-<时间戳>`）。
 *
 * 这些名字里没有项目段，**没法判断到底属于谁**。既不能装作不存在（那是操作员
 * 恢复前留的救命快照，正需要的时候消失最糟），也不能不打招呼就混进列表冒充自己的。
 * 所以照列但标出来，让调用方能把它们和已归属的文件区分开。
 */
export function isLegacyUnscopedBackupFile(name: string, id: string): boolean {
  const safe = String(id || '').replace(/[^a-zA-Z0-9._-]/g, '-');
  return name.startsWith(`${safe}-pre-restore-`);
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
      skipped.push({ id: c.id, projectId: c.projectId, reason: '容器未运行', blocksHealthy: false });
      continue;
    }
    // id / 容器名一起交给判据：私有仓库或摘要镜像的名字里可能一个产品名都没有，
    // 只看 image 会把一台真库判成「不认识的类型」并跳过——那是静默零备份。
    const hints = { id: c.id, containerName: c.containerName };
    const kind = backupKindOf(c.dockerImage, hints);
    if (!kind) {
      // 分类而不是一句「暂不支持」：没有持久状态的不该算缺口（否则健康位从上线
      // 那天起就永远红着），真算缺口的要当场说清缺的是哪一套手段。
      const verdict = classifyBackupCoverage(detectInfraKind(c.dockerImage, hints), {
        env: c.env,
        command: c.command,
        entrypoint: c.entrypoint,
      });
      skipped.push({
        id: c.id,
        projectId: c.projectId,
        reason: `${verdict.reason}（${c.dockerImage}）`,
        blocksHealthy: verdict.blocksHealthy,
      });
      continue;
    }
    targets.push({ ...c, kind, fileName: backupFileName(c.projectId, c.id, kind, iso) });
  }
  return { targets, skipped };
}

/** 正在运行却没有进入备份目标的服务，必须让整轮健康状态失败。 */
export function backupCoverageGaps(plan: BackupPlan): BackupPlan['skipped'] {
  return plan.skipped.filter((item) => item.blocksHealthy);
}

/**
 * 备成了、但**只备到了一部分**的那些缺口。
 *
 * postgres 是最典型的：脚本只导 `POSTGRES_DB` 那一个库，同实例其它库一条都没带走，
 * 于是导出脚本往 stderr 报一行 `cds-backup-scope:`。原来这行只挂在 outcome 的 `note` 上，
 * 而 `note` 没有任何判据在读——`ok` 仍是 true，于是整轮判成 coverageComplete，
 * 备份健康时间照常刷新，每日体检也报不出缺口。**那几个库一份备份都没有，而灯是绿的。**
 *
 * 这正是这一整批改动要治的病（一盏说谎的灯比一盏红着的灯更糟），不能自己先犯
 *（Codex review P1）。所以把运行时发现的范围限制升级成正式缺口：既进持久化的
 * coverageGaps 给每日体检看，也拉低整轮健康。
 *
 * 注意它和 `ok` 的分工：那份单库产物**本身是有效备份**，不该被判成失败——失败会让
 * 「导出崩了」和「导出成功但只覆盖一部分」混成一件事。所以 ok 保持 true，只算缺口。
 */
export function backupScopeGaps(outcomes: readonly BackupOutcome[]): BackupPlan['skipped'] {
  const gaps: BackupPlan['skipped'] = [];
  for (const o of outcomes) {
    // 只认 gapNote。**不能读 note**：那是纯说明，而 rabbitmq 与 nacos 每轮都会
    // 无条件报一行，读它等于让任何装了这两者的部署健康位永远刷不新（见 gapNote 的注释）。
    if (!o.ok || !o.gapNote) continue;
    gaps.push({ id: o.id, projectId: o.projectId, reason: o.gapNote, blocksHealthy: true });
  }
  return gaps;
}

/**
 * 只有每个运行中目标都得到可校验副本、且没有任何覆盖缺口时，整轮才允许刷新健康时间。
 *
 * 缺口有两种来源，缺一种都会让健康位说谎：**计划阶段**就知道备不了的（backupCoverageGaps，
 * 按服务类型判），和**跑完才知道只备到一部分**的（backupScopeGaps，按导出脚本的实际报告判）。
 */
export function isBackupRoundHealthy(plan: BackupPlan, outcomes: readonly BackupOutcome[]): boolean {
  return outcomes.length > 0
    && outcomes.every((outcome) => outcome.ok)
    && backupCoverageGaps(plan).length === 0
    && backupScopeGaps(outcomes).length === 0;
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
  opts: { projectId: string; id: string; now: Date; keepCount?: number; keepDays?: number },
): string[] {
  const keepCount = Math.max(1, opts.keepCount ?? DEFAULT_KEEP_COUNT);
  const keepDays = Math.max(1, opts.keepDays ?? DEFAULT_KEEP_DAYS);
  const mine = files
    .filter((f) => isAutoBackupFile(f.name, opts.projectId, opts.id))
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

/**
 * 给单次导出套一个**写入上限**，超限即失败。
 *
 * 只在导出前查一次可用空间是不够的：闸放行只证明「此刻还有 2 GiB」，而接下来那次
 * 写入是**无界**的——一个 50 GiB 的库照样能把最后一个字节吃掉。等 `docker exec` 或
 * `gzip` 报错时，宿主根盘已经满了，而根盘满会同时打死所有预览、构建和 CDS 自己；
 * 事后删残骸也来不及。逐目标复查保护的是**后面**的目标，救不了正在写的这一个。
 *
 * `ulimit -f` 是 POSIX shell 自带的硬上限：超过就给写进程 SIGXFSZ，写失败、命令
 * 非零退出，我们既有的失败路径顺手把残骸删掉。单位是 512 字节块，所以要换算。
 *
 * 留出 `reserveBytes` 不用满：压缩临时缓冲、日志、别的进程都还要写盘，把可用空间
 * 掐到零和写满没有区别。
 *
 * 设不上限（某些精简 shell 不支持 `ulimit -f`）时**不阻断导出**——那会让备份从
 * 「可能撑爆」退化成「必然不跑」。此时退回只有前置闸的旧行为，由调用方记一条警告。
 */
export function buildSizeCappedCommand(
  cmd: string,
  freeBytes: number,
  reserveBytes: number = DEFAULT_MIN_FREE_BYTES,
): { command: string; capBytes: number } | null {
  const capBytes = Math.floor(freeBytes - reserveBytes);
  if (!Number.isFinite(capBytes) || capBytes <= 0) return null;
  const blocks = Math.max(1, Math.floor(capBytes / 512));
  // `ulimit` 失败不能连累导出：分号而不是 &&，配 2>/dev/null 吞掉不支持时的噪音。
  return { command: `ulimit -f ${blocks} 2>/dev/null; ${cmd}`, capBytes };
}

export interface BackupOutcome {
  id: string;
  /**
   * 它属于哪个项目。**报错时必须带**：infra id 只在项目内唯一。
   *
   * 真机一轮里同时有**六个**叫 `redis` 的目标（各项目一个），其中一个因为拿不到
   * 认证凭据一直备不成。只报裸 id 的告警会说「redis 没备成」，运维面对六个 redis
   * 无从下手——一条路由不到人的告警，等于没有这条告警
   * （cross-project-isolation：标识要带作用域）。
   */
  projectId?: string;
  ok: boolean;
  fileName?: string;
  bytes?: number;
  error?: string;
  pruned?: string[];
  remoteObjectKey?: string;
  sha256?: string;
  /**
   * 本地副本已落地并通过校验，只是离机那一程没成。
   *
   * 这类**不算成功**（`ok` 仍为 false，健康状态照样不刷新），但和「什么都没备成」
   * 是两码事：手上有一份能用的同机副本。两者混在一起报，等于把「还有救」和
   * 「彻底没有」说成同一件事。
   */
  localOnly?: boolean;
  /**
   * 这份备份**覆盖到哪**的说明，由导出脚本自己报。
   *
   * 和 `error` 分开：它不表示失败，它表示「成功了，但别把它当成全量」。
   * 两者混在一个字段里，要么把一次正常备份报成故障，要么让范围缺口彻底消失。
   *
   * **纯说明，不拉低健康位**——拉低健康的是下面的 `gapNote`。
   */
  note?: string;
  /**
   * 这一轮**真的少备了东西**时的说明（`cds-backup-gap:`）。只有它算覆盖缺口。
   *
   * 与 `note` 分家是因为上一版把两者混成了一个：任何 `cds-backup-scope:` 行都被
   * 升级成阻塞缺口，而 rabbitmq 与 nacos 是**每轮无条件**报一行说明的（讲清楚
   * definitions 不含消息、配置导出不含服务注册）。于是任何装了这两者的部署，
   * 备份健康位从此永远刷不新、每日体检天天报「读不到上一轮备份」——一次成功的
   * 备份被说成了不知道有没有备（Codex review P1）。
   *
   * 判据因此改成问一句：**这一行说的是「机制本来就不含」，还是「这次本可以带走
   * 却没带走」？** 只有后者是缺口。
   */
  gapNote?: string;
}

/**
 * 离机连续失败到什么程度就别在这一轮里继续试了。
 *
 * ## 为什么要有
 *
 * 离机失败时保留本地副本（用户 2026-08-19 决定）之后，多出一个新风险：离机一旦
 * 长期挂掉，每一轮都会对**每一个**目标重试一次上传。一轮二十来个库、单个动辄几十上百
 * MB，全是注定失败的重传——白烧带宽和时间，还把整轮拖长。
 *
 * 判据很简单：**同一轮里连续失败到阈值，就认定离机这条路当前不通**，本轮剩下的目标
 * 直接跳过上传、只留本地副本。跨轮不做惩罚——下一轮照常再试一次，这样离机恢复时
 * 能自己好起来，不需要人工干预。
 *
 * 注意这里数的是**连续**失败：中间只要成功过一次就归零，避免个别大文件超时误伤整轮。
 */
export const OFFSITE_ROUND_FAILURE_THRESHOLD = 2;

export function shouldSkipOffsiteThisRound(
  consecutiveFailures: number,
  threshold: number = OFFSITE_ROUND_FAILURE_THRESHOLD,
): boolean {
  return consecutiveFailures >= Math.max(1, threshold);
}

/** 一轮结果的一句话结论。全成功也要说清备了几个——静默成功等于没有反馈。 */
export function summarizeBackupRound(outcomes: readonly BackupOutcome[], skipped: number): string {
  const ok = outcomes.filter((o) => o.ok);
  const failed = outcomes.filter((o) => !o.ok);
  // 「只有本地副本」要单独说：它和「彻底没备成」的处置完全不同，
  // 混成一个数字会让人以为手上什么都没有。
  const localOnly = failed.filter((o) => o.localOnly);
  const hardFailed = failed.filter((o) => !o.localOnly);
  const parts: string[] = [];
  if (ok.length) parts.push(`成功 ${ok.length} 个`);
  if (localOnly.length) {
    parts.push(`仅本地副本 ${localOnly.length} 个（离机未上传：${localOnly.map((f) => f.id).join('、')}）`);
  }
  if (hardFailed.length) {
    parts.push(`失败 ${hardFailed.length} 个（${hardFailed.map((f) => f.id).join('、')}）`);
  }
  if (skipped) parts.push(`跳过 ${skipped} 个`);
  // 范围说明必须进这句话。它只活在 outcome 对象里的话，「这份 dump 没带走另外两个库」
  // 就没有任何一个人会看到——那正是「备了」被读成「备全了」的路径。
  const noted = outcomes.filter((o) => o.note);
  if (noted.length) {
    parts.push(`范围提示 ${noted.length} 条（${noted.map((o) => `${o.id}：${o.note}`).join('；')}）`);
  }
  return parts.length ? `基础设施自动备份：${parts.join('，')}` : '基础设施自动备份：没有可备份的目标';
}

/**
 * Redis 备份前的探测脚本（在容器内跑）。
 *
 * 做成一个可导出的值，是为了让回归**拿到真正会执行的那段脚本**去做语法检查和判据
 * 断言——扫源码只能证明字面量还在，证明不了拼出来的东西能跑。
 *
 * 三件事必须都成立才敢认这份备份：
 *
 * 1. **连得上且认证通过**。配了 requirepass 的实例会让裸 redis-cli 返回 NOAUTH。
 *    忽略返回值的话，`docker cp` 会拷走一个**旧的** dump.rdb 还报成功——
 *    「以为有、其实是几天前的」，比没有备份更危险。密码优先取 env，取不到就从
 *    容器内进程的命令行里扫 `--requirepass`（compose 导入最常见的配法，env 里
 *    一个字都没有）。全程在容器内展开，不进宿主命令行、不进日志。
 * 2. **BGSAVE 真的完成**。判据是 `rdb_bgsave_in_progress` + `rdb_last_bgsave_status`
 *    ——redis 文档给的那两个。**不能比 LASTSAVE 前后是否变化**：它的粒度是秒，
 *    小库的 BGSAVE 常在同一秒内跑完，时间戳不动，于是白等到超时再把一份完全
 *    有效的备份判成失败。
 * 3. **文件确实被这次写过**。完成了不等于写的是这个文件：路径不对、save 被禁用
 *    都会留下一个旧文件。用 mtime 与探测开始时间比一下，取容器自己的时钟。
 */
/**
 * 「这个 redis 的快照文件在哪」——**唯一**判定源。
 *
 * 三处要用：周期备份的探测、手工下载、手工恢复。写死 `/data/dump.rdb` 的话，
 * 配了非默认 `dir` / `dbfilename` 的实例会各错各的：备份判每次失败、下载给出
 * 陈旧文件、恢复写到一个 redis 根本不读的路径却报「已恢复」。抄三份的下场是
 * 改一处漏两处，所以这里只留一份，谁要用谁拼进自己的脚本。
 *
 * 约定：执行后 `$RDB` 就是快照的绝对路径（`$D` 目录、`$F` 文件名）。
 */
export const REDIS_RDB_PATH_LINES: readonly string[] = [
  // 问不出来就**报错**，不许退回 `/data/dump.rdb`。
  //
  // CONFIG 可能被 rename-command 改名、被 ACL 拒绝、或者实例压根连不上；这些情况下
  // 「猜一个默认路径」正好在最危险的场景里给出最坏结果：恢复流程会把上传的快照写到
  // 一个 redis 不读的文件，重启，然后报「已恢复」——用户以为数据回来了，其实没有。
  // 默认值只在「问到了、但值确实是默认」时才出现，那由 redis 自己回答，不由我们假设。
  'dirOut=$(redis-cli CONFIG GET dir 2>&1) || { echo "CONFIG GET dir 调用失败: $dirOut" >&2; exit 27; }',
  `D=$(printf '%s\\n' "$dirOut" | sed -n '2p' | tr -d '\\r')`,
  '[ -n "$D" ] || { echo "CONFIG GET dir 返回空，拒绝猜默认路径" >&2; exit 28; }',
  'fileOut=$(redis-cli CONFIG GET dbfilename 2>&1) || { echo "CONFIG GET dbfilename 调用失败: $fileOut" >&2; exit 29; }',
  `F=$(printf '%s\\n' "$fileOut" | sed -n '2p' | tr -d '\\r')`,
  '[ -n "$F" ] || { echo "CONFIG GET dbfilename 返回空，拒绝猜默认路径" >&2; exit 30; }',
  'RDB="$D/$F"',
];

/**
 * 「连上这个 redis 并把认证配好」——**唯一**判定源，探测与路径解析都从这里进。
 *
 * 顺序是这条规则的全部内容：**先裸连，只有服务器真的要求认证才去找凭据**。
 *
 * 反过来写（先从 env 取一个密码、export 了再连）在线上炸过一次，2026-08-17：
 * 容器 env 里的 `REDIS_PASSWORD` 往往是 **CDS 注入给应用用的连接串变量**，
 * 它的存在只说明「有人打算用这个口令连」，**不说明这个 redis 真开了 requirepass**。
 * 拿它去 AUTH，无口令的服务器会明确拒绝（`ERR AUTH <password> called without any
 * password configured`），而 PING 本身其实是通的——于是判据把一台健康的 redis
 * 判成「连不上」，全站 redis 备份一轮全红。
 *
 * 另外两处形状同样是那次的教训：
 *
 * - **判据不能要求输出恰好等于 `PONG`**。redis-cli 会把 AUTH 的抱怨和 PONG 一起吐出来，
 *   多一行就整体判死。这里改成「输出里有任意一行是 PONG」。
 * - **候选凭据要拿服务器验，不能拿「env 里有没有」当验**。env 里那个可能是错的
 *   （线上就有一台是 WRONGPASS），而进程命令行里躺着对的。所以逐个候选真连一次，
 *   谁能换回 PONG 就用谁。
 */
export const REDIS_CONNECT_LINES: readonly string[] = [
  // 先把继承来的 REDISCLI_AUTH 收起来：它也只是个候选，不该在裸连那一步生效。
  'CDS_ORIG_AUTH="${REDISCLI_AUTH:-}"',
  'unset REDISCLI_AUTH',
  // CDS 自己存的那份口令（见 redisAuthFromServiceDefinition）由调用方经 stdin 送进来，
  // 在这个位置被赋值。没送就是空，整段照常走。
  'CDS_STDIN_AUTH="${CDS_STDIN_AUTH:-}"',
  "cds_is_pong() { printf '%s\\n' \"$1\" | grep -qx PONG; }",
  'cds_try_auth() { [ -n "$1" ] || return 1; REDISCLI_AUTH="$1" redis-cli PING 2>&1 | grep -qx PONG; }',
  // 从进程命令行里扫 --requirepass。**这条路只在少数情况下有效，别把它当主力**：
  // redis 默认 `set-proc-title yes`，启动后会把自己的 argv 整个改写成 `redis-server *:6379`，
  // 命令行里的口令连同其它参数一起消失（拿真 redis 量过：默认配置扫不到，
  // 显式 `--set-proc-title no` 才扫得到）。所以它只兜得住关了 proc-title 的实例；
  // 「密码既不在 env、redis 又开着认证」的一般情形仍会走到下面的 exit 22，
  // 那是如实报缺凭据，不是静默拷走旧文件。真正的解法是让 CDS 用自己存的那份
  // 密码（infraServices 的 secrets）经 stdin 喂进来——见 doc/debt.cds.md E34。
  //
  // PROCDIR 只是给回归留的注入点（容器里没人会设它）。这段 awk 是最容易写错的地方，
  // 必须能拿真 shell 对着真的 NUL 分隔 cmdline 跑一遍，而不是断言「源码里有这行」——
  // 那种断言在这段代码变成死分支时照样是绿的。
  'cds_scan_requirepass() {',
  '  PROCDIR="${CDS_BACKUP_PROC_DIR:-/proc}"',
  '  for c in "$PROCDIR"/[0-9]*/cmdline; do',
  '    [ -r "$c" ] || continue',
  `    v=$(tr '\\0' '\\n' < "$c" | awk '/^--requirepass=/{sub(/^--requirepass=/,"");print;exit} /^--requirepass$/{getline;print;exit}')`,
  '    [ -n "$v" ] && { printf %s "$v"; return 0; }',
  '  done',
  '  return 1',
  '}',
  'cds_hello=$(redis-cli PING 2>&1)',
  'if ! cds_is_pong "$cds_hello"; then',
  // 只有服务器明说「要认证」才去翻凭据；连不上就是连不上，别拿密码去治网络问题。
  '  case "$cds_hello" in',
  '    *NOAUTH*|*WRONGPASS*|*"Authentication required"*) ;;',
  '    *) echo "redis 连不上: $cds_hello" >&2; exit 21;;',
  '  esac',
  '  CDS_AUTH=""',
  // CDS 自己的服务定义排第一：那是它当初用来**启动**这个容器的口令，
  // 比容器 env 里那个「给应用连的连接串变量」权威。
  '  if cds_try_auth "$CDS_STDIN_AUTH"; then CDS_AUTH="$CDS_STDIN_AUTH"',
  '  elif cds_try_auth "${REDIS_PASSWORD:-}"; then CDS_AUTH="$REDIS_PASSWORD"',
  '  elif cds_try_auth "${REDIS_PASS:-}"; then CDS_AUTH="$REDIS_PASS"',
  '  elif cds_try_auth "$CDS_ORIG_AUTH"; then CDS_AUTH="$CDS_ORIG_AUTH"',
  '  else',
  '    CDS_SCANNED=$(cds_scan_requirepass || true)',
  '    cds_try_auth "$CDS_SCANNED" && CDS_AUTH="$CDS_SCANNED"',
  '  fi',
  '  [ -n "$CDS_AUTH" ] || { echo "redis 要求认证，但没有找到能通过认证的凭据" >&2; exit 22; }',
  // 密码只在容器内展开，不进宿主命令行、不进日志。
  '  export REDISCLI_AUTH="$CDS_AUTH"',
  'fi',
];

/**
 * 从 **CDS 自己的服务定义**里取这个 redis 的口令。
 *
 * 为什么这才是权威来源：这些 infra 容器就是 CDS 起的，启动命令与 env 都存在它的
 * state 里。容器里反而不一定看得到——redis 默认会把自己的 argv 改写掉（见上面
 * `cds_scan_requirepass` 的注释），env 里那个又可能只是给应用用的连接串变量。
 * 2026-08-18 实测：线上 6 个 redis 里唯一还失败的那个，口令原原本本写在
 * CDS 存的 `command` 里，容器里却哪儿都扫不到。
 *
 * 只做解析，不决定怎么送进去——送法见 {@link redisProbeStdin}。
 */
export function redisAuthFromServiceDefinition(svc: {
  env?: Record<string, string> | null;
  command?: string[] | string | null;
}): string {
  const env = svc.env || {};
  // 注意：这里取到的**可能是错的**（env 里放过期口令的情况线上就有一台）。
  // 所以它只是个候选，最终由容器里那次真实的 PING 说了算。
  const fromEnv = env.REDIS_PASSWORD || env.REDIS_PASS || '';
  if (fromEnv) return fromEnv;
  const parts = Array.isArray(svc.command)
    ? svc.command
    : String(svc.command || '').split(/\s+/).filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    if (p.startsWith('--requirepass=')) return p.slice('--requirepass='.length);
    if (p === '--requirepass' && i + 1 < parts.length) return parts[i + 1];
    // compose 常把整条命令塞进一个 `sh -c '...'` 元素里，参数没被拆开。
    const inline = /--requirepass[= ]+("([^"]*)"|'([^']*)'|(\S+))/.exec(p);
    if (inline) return inline[2] ?? inline[3] ?? inline[4] ?? '';
  }
  return '';
}

/**
 * 把脚本和口令一起打包成**送进 stdin** 的内容。
 *
 * 关键约束：口令绝不能出现在宿主命令行上。`docker exec -e PW=...` 和
 * `sh -c '...口令...'` 都会把明文摆进 argv，同机任何人 `ps` 一眼就看到。
 * 所以调用方一律走 `docker exec -i <容器> sh -s`，argv 里只剩 `sh -s`，
 * 脚本连同口令都从这里进去。
 *
 * 没有口令时返回脚本本身——行为与从前完全一致，不为「统一形状」引入新语义。
 */
export function redisProbeStdin(script: string, password: string): string {
  if (!password) return script;
  // 单引号里只有 `'` 需要处理，其余字符（含 $ ` \ 换行）都是字面量。
  const quoted = `'${password.replace(/'/g, `'"'"'`)}'`;
  return `CDS_STDIN_AUTH=${quoted}\n${script}`;
}

/**
 * 问 redis 有没有开 AOF（只回 `yes` / `no`）。
 *
 * 恢复流程必须先问这一句：开着 AOF 的实例**启动时读 AOF、不读 RDB**，
 * 把快照写进去再重启，加载到的还是原来的数据，而接口会回「已恢复」。
 * 这种谎话在恢复场景里代价最大，所以宁可明确拒绝也不假装成功。
 */
export function buildRedisAppendOnlyScript(): string {
  return [
    ...REDIS_CONNECT_LINES,
    'out=$(redis-cli CONFIG GET appendonly 2>&1) || { echo "CONFIG GET appendonly 调用失败: $out" >&2; exit 31; }',
    `v=$(printf '%s\\n' "$out" | sed -n '2p' | tr -d '\\r')`,
    '[ -n "$v" ] || { echo "CONFIG GET appendonly 返回空" >&2; exit 32; }',
    'printf "%s" "$v"',
  ].join('\n');
}

/**
 * Redis 恢复的动作顺序——**顺序本身就是这个函数存在的全部理由**。
 *
 * 上一版是「往**运行中**的容器写 RDB，然后 `docker restart`」，这会静默丢数据：
 * redis 收到 SIGTERM 时按 save 点把**当前**数据存一次盘，正好覆盖掉刚上传的快照，
 * 重启加载到的是覆盖后的内容，而接口回「已恢复」。默认配置就带 save 点，所以这
 * 不是边角情况；只有恰好是空库时才看不出来（2026-08-18 收窄端口时就是这么侥幸
 * 躲过去的）。
 *
 * 正确顺序把关闭时那次 save 变成**帮手**而不是对手：
 *
 * 1. `stop` —— 让 redis 自己把当前数据落盘，之后没有任何进程会再碰这个文件
 * 2. `cp` 出来 —— 这时拷到的才是**准确的**恢复前状态，用作撤销快照
 *    （上一版 redis 分支压根没有撤销快照，恢复错了就回不去了）
 * 3. `cp` 进去 —— 覆盖，此刻无人竞争
 * 4. `start` —— 启动时读到的就是上传的那份
 *
 * `docker cp` 对已停止的容器同样有效，这是这套顺序成立的前提。
 */
export function buildRedisRestorePlan(opts: {
  containerName: string;
  rdbPath: string;
  /** 宿主上暂存的上传文件 */
  uploadPath: string;
  /** 撤销快照要写到哪 */
  preBackupPath: string;
}): Array<{ id: 'stop' | 'save-current' | 'overwrite' | 'start'; argv: string[] }> {
  const c = opts.containerName;
  return [
    { id: 'stop', argv: ['docker', 'stop', c] },
    { id: 'save-current', argv: ['docker', 'cp', `${c}:${opts.rdbPath}`, opts.preBackupPath] },
    { id: 'overwrite', argv: ['docker', 'cp', opts.uploadPath, `${c}:${opts.rdbPath}`] },
    { id: 'start', argv: ['docker', 'start', c] },
  ];
}

/**
 * 只解析路径并打印出来（不触发 BGSAVE）。恢复流程要知道「该往哪写」，
 * 但不该顺手给人家存一次盘。连接与认证沿用同一份判定源。
 */
export function buildRedisRdbPathScript(): string {
  return [...REDIS_CONNECT_LINES, ...REDIS_RDB_PATH_LINES, 'printf "%s" "$RDB"'].join('\n');
}

export function buildRedisBackupProbeScript(): string {
  return [
  ...REDIS_CONNECT_LINES,
  // 落盘时间的下界。容器自己的时钟，避免宿主与容器时钟不一致。
  'start=$(date +%s)',
  'redis-cli BGSAVE >/dev/null 2>&1 || { echo "BGSAVE 调用失败" >&2; exit 23; }',
  'i=0; ip=""',
  'while [ "$i" -lt 90 ]; do',
  `  info=$(redis-cli INFO persistence 2>/dev/null | tr -d '\\r')`,
  `  ip=$(echo "$info" | awk -F: '/^rdb_bgsave_in_progress:/{print $2}')`,
  `  st=$(echo "$info" | awk -F: '/^rdb_last_bgsave_status:/{print $2}')`,
  '  if [ "$ip" = "0" ]; then',
  '    [ "$st" = "ok" ] || { echo "BGSAVE 报告失败: $st" >&2; exit 24; }',
  '    break',
  '  fi',
  '  i=$((i+1)); sleep 1',
  'done',
  '[ "$ip" = "0" ] || { echo "BGSAVE 超时未完成" >&2; exit 25; }',
  // 快照落在哪，要问 redis 自己。`/data/dump.rdb` 只是官方镜像的默认值：
  // 配了 `dir` 或 `dbfilename` 的实例（compose 里很常见）会写到别处，
  // 那时按默认路径 stat 到的是一个**根本不存在或很旧**的文件——
  // 判据会把每一次正常的 BGSAVE 都判失败，而 docker cp 也会拷错东西。
  ...REDIS_RDB_PATH_LINES,
  // 完成了不等于这个文件被写过：路径不对、save 被禁用都会留下旧文件。
  'mt=$(stat -c %Y "$RDB" 2>/dev/null || echo 0)',
  '[ "$mt" -ge "$start" ] || { echo "$RDB 未被本次 BGSAVE 更新（mtime=$mt start=$start）" >&2; exit 26; }',
  // 最后一行是**给宿主用的**：docker cp 要拷的就是这个路径。
  // 这条链路只有一个真值来源，宿主不许自己再拼一次默认路径。
  'printf "%s" "$RDB"',
  ].join('\n');
}

/**
 * MySQL / MariaDB 的导出脚本：**流式压缩，不落任何中转文件**，同时保住 mysqldump
 * 自己的退出码。
 *
 * 这一处栽过两次，两次的形状正好相反：
 *
 * 1. `mysqldump | gzip` 直接串管道 —— 管道的退出码是**最后一环**的。dump 因凭据
 *    错误中断时 gzip 照样成功，产出一个几十字节的合法 gzip 头，「非空」检查放行，
 *    一份不可用的备份被记成成功，还可能顺手把真正可用的旧副本按保留策略删掉。
 * 2. 改用 `set -o pipefail` —— `set` 是特殊内建，dash 遇到不认识的 `-o pipefail`
 *    会**直接终止 shell**，`|| true` 拦不住。Debian 系 mariadb 镜像的 /bin/sh 正是
 *    dash，于是这一档从「静默成功」变成了「必然失败」。
 * 3. 再改成两步落盘（先写完整 .sql 再压缩）—— 退出码对了，代价是中转一份**未压缩**
 *    的全量 dump。而磁盘闸是每轮开头查一次的固定阈值，单个大库就能把宿主根盘写满，
 *    那会同时打死所有预览、构建和 CDS 自己。
 *
 * 现在用 POSIX 的文件描述符腾挪拿 pipeline 里**上游**的退出码：`exec 3>&1` 先把真正
 * 的 stdout（docker exec 会把它接到宿主的目标文件）存到 fd3，dump 的退出码经 fd4
 * 被命令替换捕获，gzip 的输出直接写回 fd3。全程零中转文件，dash / busybox sh 都吃。
 *
 * **两端的退出码都要拿**。只捕获 dump 那一端是第四个坑：dump 成功、gzip 中途因写盘
 * 失败退出（磁盘满、I/O 错误）时，脚本会返回 0，而产物是一份被截断的 gzip——调用方
 * 看到「退出码 0 + 文件非空」就把它转正，还按保留策略删掉一份真正可用的旧备份。
 * 这一版把 dump 与 gzip 的退出码分别经 fd4 回传，任一非零整条失败。
 * 宿主侧另有 `gzip -t` 完整性校验作第二道（见 index.ts 的转正前校验）。
 */
/**
 * 在容器内挑一套能用的 MySQL 凭据，顺带定下这次能备多大范围。
 *
 * ## 为什么不能写死 `-uroot`
 *
 * 2026-08-18：`cloudbridge-db` 的周期备份长期报
 * `Access denied for user 'root'@'localhost'`，我一度把它记成「凭据不对，等用户给口令」。
 * 实际是这个容器用 **`MYSQL_RANDOM_ROOT_PASSWORD`** 起的——mysql 镜像在首次初始化时
 * 随机生成 root 口令、只往容器日志里打一次。**那个口令不存在于任何地方**：CDS 没有、
 * 运维没有、用户也没有。于是 `${MYSQL_ROOT_PASSWORD}` 取到空值，root 必然连不上。
 *
 * 也就是说这从来不是凭据问题，是判据太窄：把「root 一定有口令」当成了前提
 * （`predicate-and-wiring-discipline.md` 形状 1）。而这类容器同时带着
 * `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE`——那个账号对自己那个库有全部权限，
 * 完全备得下来。**能备一个库，远胜于一个库都不备。**
 *
 * 所以按能力分档，并把档位透出来（`CDS_MYSQL_SCOPE_LABEL`），让调用方知道这份备份
 * 覆盖的是全库还是单库——「备了」和「备全了」是两件事，不能混着报。
 */
const MYSQL_CREDENTIAL_LINES: readonly string[] = [
  // 凭据在容器内展开：不进宿主命令行、不进 CDS 日志、不进宿主 ps。
  'CDS_ROOT_PW="${MYSQL_ROOT_PASSWORD:-${MARIADB_ROOT_PASSWORD:-}}"',
  'CDS_APP_USER="${MYSQL_USER:-${MARIADB_USER:-}}"',
  'CDS_APP_PW="${MYSQL_PASSWORD:-${MARIADB_PASSWORD:-}}"',
  'CDS_APP_DB="${MYSQL_DATABASE:-${MARIADB_DATABASE:-}}"',
  'if [ -n "$CDS_ROOT_PW" ]; then',
  '  export MYSQL_PWD="$CDS_ROOT_PW"',
  '  CDS_MYSQL_USER=root',
  '  CDS_MYSQL_SCOPE="--all-databases"',
  '  CDS_MYSQL_IS_ROOT=1',
  '  CDS_MYSQL_SCOPE_LABEL=all-databases',
  'elif [ -n "$CDS_APP_USER" ] && [ -n "$CDS_APP_PW" ] && [ -n "$CDS_APP_DB" ]; then',
  // 随机 root 口令的容器走这一档：只备应用账号那个库，但至少有备份。
  '  export MYSQL_PWD="$CDS_APP_PW"',
  '  CDS_MYSQL_USER="$CDS_APP_USER"',
  // `--no-tablespaces` 不是可选项：mysqldump 8.0 默认要读 INFORMATION_SCHEMA.FILES
  // 导出表空间定义，那需要**全局** PROCESS 权限。而这类账号拿到的是
  // `GRANT ALL ON <db>.*` + `GRANT USAGE ON *.*`（实测 webhook@% 就是这样），
  // 全局权限一个都没有，于是 dump 一上来就 Access denied、产出一个 20 字节的空 gzip。
  // root 那一档不加：它有 PROCESS，保持原命令逐字不变，四个在用的容器行为不动。
  '  CDS_MYSQL_SCOPE="--databases $CDS_APP_DB --no-tablespaces"',
  '  CDS_MYSQL_IS_ROOT=0',
  '  CDS_MYSQL_SCOPE_LABEL="database:$CDS_APP_DB"',
  'else',
  // 说清楚缺的是哪几个变量，别让下一个人再去猜是不是「口令不对」。
  '  echo "cds-backup: 容器里既没有 root 口令（MYSQL_ROOT_PASSWORD / MARIADB_ROOT_PASSWORD），'
    + '也没有凑齐应用账号三件套（MYSQL_USER + MYSQL_PASSWORD + MYSQL_DATABASE），无法连库" >&2',
  '  exit 78',
  'fi',
];

export function buildMysqlDumpScript(): string {
  return [
    ...MYSQL_CREDENTIAL_LINES,
    // fd3 = 真正的 stdout（宿主那个文件）；fd4 = 回传两端退出码的通道。
    'exec 3>&1',
    // $CDS_MYSQL_SCOPE 故意不加引号：它是「--all-databases」或「--databases x」两个词。
    'codes=$( { { mysqldump -u"$CDS_MYSQL_USER" $CDS_MYSQL_SCOPE --single-transaction --quick --routines --events; echo "dump=$?" >&4; }'
      + ' | { gzip -n -c >&3; echo "gzip=$?" >&4; }; } 4>&1 )',
    // 读不到退出码按失败处理：宁可重跑一轮，也不要认一份来路不明的产物。
    `d=$(printf '%s\\n' "$codes" | sed -n 's/^dump=//p')`,
    `g=$(printf '%s\\n' "$codes" | sed -n 's/^gzip=//p')`,
    '[ "${d:-1}" = 0 ] || exit "${d:-1}"',
    '[ "${g:-1}" = 0 ] || exit "${g:-1}"',
  ].join('\n');
}

/**
 * MySQL 恢复：把容器内的 `.sql.gz` 灌回库里。
 *
 * ## 为什么不是一行 `gunzip -c f | mysql -uroot`
 *
 * 2026-08-18 真事：恢复接口返回 `restored: true`，耗时 4 秒，库里一张用户表都没有。
 * 原因就是那一行——**管道的退出码是最后一环的**。上游 gunzip 因为文件是空的/截断的
 * 失败了，下游 mysql 收到零字节输入、正常退出 0，调用方读到 0 就报「已恢复」。
 *
 * 这个坑在**导出**那侧（`buildMysqlDumpScript`）早就踩过、也早就注释清楚了，恢复这侧
 * 却又裸写了一遍管道——同一个判据分裂成两份、只修了一份。所以两侧现在用同一套写法：
 * 各环的退出码经 fd4 回传，任一非零整条失败。
 *
 * 另加一道前置 `gunzip -t`：先验完整性再灌库。空文件、传了一半的文件、根本不是 gzip
 * 的文件，都在动库之前就被拦下，而不是灌进去一半才发现。
 */
export function buildMysqlRestoreScript(inContainerPath: string): string {
  // 单引号里只有 `'` 需要处理，其余字符（含 $ ` \ 空格）都是字面量。
  const p = `'${String(inContainerPath).replace(/'/g, `'"'"'`)}'`;
  return [
    ...MYSQL_CREDENTIAL_LINES,
    // 先验完整性。空文件/截断文件在这里就出局，不会带着半截 SQL 去动库。
    // 措辞不替失败下结论：这一步不过既可能是文件损坏/截断/为空，也可能是容器里
    // 根本没有 gunzip。真正的原因在 stderr 里，由调用方原样带回去，别在这儿猜。
    `gunzip -t ${p} || { echo "cds-restore: 读不出这份 gz（见上一行 gunzip 的输出），未导入任何内容" >&2; exit 65; }`,
    // mysql 的 stdout 是噪音，赶到 stderr，别混进退出码通道。
    `codes=$( { { gunzip -c ${p}; echo "gunzip=$?" >&4; }`
      + ' | { mysql -u"$CDS_MYSQL_USER" >&2; echo "mysql=$?" >&4; }; } 4>&1 )',
    `u=$(printf '%s\\n' "$codes" | sed -n 's/^gunzip=//p')`,
    `m=$(printf '%s\\n' "$codes" | sed -n 's/^mysql=//p')`,
    // 读不到退出码按失败处理——「不确定」不能当成「成功」。
    '[ "${u:-1}" = 0 ] || exit "${u:-1}"',
    '[ "${m:-1}" = 0 ] || exit "${m:-1}"',
    // `--all-databases` 的 dump 会把 `mysql` 库的授权表整个写回去，但**跑着的服务器
    // 用的是内存里那份**——不 flush 的话，表里明明有这个账号，应用照样连不上，
    // 而恢复看起来是成功的。dump 自己不带 FLUSH PRIVILEGES，所以在这里补。
    // 只有 root 这一档需要：应用账号既没有 RELOAD 权限（强来必失败），
    // 它那份单库 dump 也根本没碰授权表。
    '[ "$CDS_MYSQL_IS_ROOT" = 1 ] && { mysql -uroot -e "FLUSH PRIVILEGES" || exit $?; }',
    // 上一行在非 root 档会整体为「假」，别让它成为脚本的退出码。
    'exit 0',
  ].join('\n');
}

/**
 * 数一数库里有多少张表（排除两个纯内存的元数据库）。
 *
 * 恢复前后各数一次，把两个数字写进响应——这样「已恢复」这句话是**带证据**的，
 * 而不是一个自称。今天那次假成功之所以能糊弄过去，正是因为响应里除了
 * `restored: true` 什么都没有，看的人无从判断。
 */
export function buildMysqlTableCountScript(): string {
  return [
    ...MYSQL_CREDENTIAL_LINES,
    'mysql -u"$CDS_MYSQL_USER" -N -B -e "SELECT COUNT(*) FROM information_schema.tables'
      + " WHERE table_schema NOT IN ('information_schema','performance_schema')\"",
  ].join('\n');
}

/**
 * 在容器内挑一套能用的 PostgreSQL 凭据，并当场证明连得上。
 *
 * ## 为什么 postgres 此前一份备份都没有
 *
 * 判据太窄（形状 1）：`backupKindOf` 只认 mongo / redis / mysql，postgres 是一等预设
 * 却整个落在「暂不支持的类型」里。它确实被记进了覆盖缺口（整轮健康因此不刷新），
 * 但**没有人因为一个长期红着的健康位去补它**——红了三个月和绿了三个月，磁盘上
 * 同样是零份 postgres 备份。手工下载那条路更糟：postgres 掉进兜底的 `tar -C /data`，
 * 而它的数据在 `/var/lib/postgresql/data`，于是下载得到一个空壳、HTTP 还是 200
 * （和 mysql 的 E41 一模一样的形状）。
 *
 * ## 凭据从哪来
 *
 * 官方镜像的 initdb 把本地 socket 配成 `trust`，所以 `docker exec` 进去用
 * `-U <POSTGRES_USER>` 走 socket 就能连上，不依赖口令是否被记在 env 里；
 * PGPASSWORD 仍然导出，兼容把 `POSTGRES_HOST_AUTH_METHOD` 改严过的实例。
 * 全程在容器内展开：不进宿主命令行、不进 CDS 日志、不进宿主 ps。
 *
 * ## 连不上就退出，不猜
 *
 * 先真连一次。连不上直接 78 退出并说清用的是哪个用户、哪个库——上一版 mysql 的
 * 教训就是「Access denied」被读成「口令不对」，实际是判据取错了账号，白等了一周。
 */
const POSTGRES_CREDENTIAL_LINES: readonly string[] = [
  'CDS_PG_USER="${POSTGRES_USER:-${PGUSER:-postgres}}"',
  'CDS_PG_PW="${POSTGRES_PASSWORD:-${PGPASSWORD:-}}"',
  // 官方镜像里 POSTGRES_DB 缺省就等于 POSTGRES_USER，这里照同一条缺省链走。
  'CDS_PG_DB="${POSTGRES_DB:-${PGDATABASE:-$CDS_PG_USER}}"',
  'export PGPASSWORD="$CDS_PG_PW"',
  'CDS_PG_PROBE=$(psql -U "$CDS_PG_USER" -d "$CDS_PG_DB" -tAc "SELECT 1" 2>&1) || {',
  '  echo "cds-backup: 连不上 postgres（用户=$CDS_PG_USER 库=$CDS_PG_DB）：$CDS_PG_PROBE" >&2',
  '  exit 78',
  '}',
];

/**
 * 同实例里**没被这份备份覆盖**的其它库，逐个报出来。
 *
 * 这一段不是装饰。本函数导出的是**一个库**（`$CDS_PG_DB`），而 postgres 一个实例
 * 可以有很多库；「备了」和「备全了」是两件事，混着报就是下一次「以为有、其实没有」。
 * 排除 `postgres` 维护库：它是镜像自带的空库，报出来只会变成每轮都在的噪音。
 *
 * 走 stderr 而不是 stdout：stdout 是备份产物本身，往里写一个字都会污染 dump。
 * 前缀 `cds-backup-gap:` 是给调用方认领用的机器标记：同实例别的库没备走，是**这一轮
 * 真的少备了东西**，该拉低健康位（区别于「机制本来就不含」那种纯说明，见
 * `BACKUP_GAP_NOTE_MARKER`）。
 */
const POSTGRES_SCOPE_NOTE_LINES: readonly string[] = [
  'CDS_PG_OTHERS=$(psql -U "$CDS_PG_USER" -d "$CDS_PG_DB" -tAc '
    + `"SELECT string_agg(datname, ',' ORDER BY datname) FROM pg_database`
    + ` WHERE datallowconn AND NOT datistemplate AND datname <> current_database() AND datname <> 'postgres'"`
    + ' 2>/dev/null | tr -d " ")',
  // 空结果时 `[ -n ... ]` 为假，整条复合命令返回 1；后面还有语句，但加 `|| true`
  // 免得将来有人把它挪到末尾，静默把整个脚本判成失败。
  '[ -n "$CDS_PG_OTHERS" ] && echo "cds-backup-gap: 本次只导出库 $CDS_PG_DB；'
    + '同实例另有未纳入备份的库：$CDS_PG_OTHERS" >&2 || true',
];

/**
 * PostgreSQL 导出：容器内流式压缩，两端退出码都保住。
 *
 * 管道退出码那三个坑（默认只给最后一环、dash 没有 pipefail、gzip 写盘失败留下
 * 一份截断档案还被当成功）在 `buildMysqlDumpScript` 的注释里写全了，这里用同一套
 * fd3 / fd4 写法，不再复述。
 *
 * ## 为什么是 pg_dump 不是 pg_dumpall
 *
 * `pg_dumpall` 能一次带走整个集群和角色，但它的产物**没法灌回一个已经存在的集群**：
 * 里面的 `CREATE ROLE` 撞上已存在的角色就报错，加 `--clean` 又会尝试 DROP 掉当前
 * 连接用的那个角色。一份「导得出、灌不回」的备份等于没有备份——mysql 那侧的原话。
 *
 * `pg_dump --clean --if-exists` 相反：对同一个库反复灌都成立（先 DROP IF EXISTS
 * 再建），既能盖回自己，也能搬到另一台空库上。`--no-owner --no-privileges` 是为了
 * 后者：目标集群没有源集群那些角色时，属主/授权语句会整片失败。
 *
 * 代价是**角色、权限、以及同实例其它库不在这份备份里**。这不是悄悄的取舍：
 * 其它库由 POSTGRES_SCOPE_NOTE_LINES 当场报出来，角色缺失记在 debt.cds.infra-backup.md。
 */
export function buildPostgresDumpScript(): string {
  return [
    ...POSTGRES_CREDENTIAL_LINES,
    ...POSTGRES_SCOPE_NOTE_LINES,
    'exec 3>&1',
    'codes=$( { { pg_dump -U "$CDS_PG_USER" -d "$CDS_PG_DB" --clean --if-exists --no-owner --no-privileges;'
      + ' echo "dump=$?" >&4; }'
      + ' | { gzip -n -c >&3; echo "gzip=$?" >&4; }; } 4>&1 )',
    `d=$(printf '%s\\n' "$codes" | sed -n 's/^dump=//p')`,
    `g=$(printf '%s\\n' "$codes" | sed -n 's/^gzip=//p')`,
    '[ "${d:-1}" = 0 ] || exit "${d:-1}"',
    '[ "${g:-1}" = 0 ] || exit "${g:-1}"',
  ].join('\n');
}

/**
 * PostgreSQL 恢复：把 `.sql.gz` 灌回目标库。
 *
 * ## 这里有一个 mysql 那侧没有的坑
 *
 * **psql 默认遇错继续，跑完照样 exit 0。** 一份灌到一半全是错的 dump，psql 会把
 * 错误打在 stderr 上然后返回 0——调用方读到 0 就报「已恢复」，正是本文件被烧过
 * 三次的那种假成功，而且这一次连管道退出码都救不了（psql 自己就是撒谎的那个）。
 * 所以 `-v ON_ERROR_STOP=1` 不是可选项：第一条语句失败即中止并返回非零。
 *
 * 其余（先 `gunzip -t` 验完整性、两端退出码经 fd4 回传）与 mysql 侧同一套写法。
 */
export function buildPostgresRestoreScript(inContainerPath: string): string {
  // 单引号里只有 `'` 需要处理，其余字符（含 $ ` \ 空格）都是字面量。
  const p = `'${String(inContainerPath).replace(/'/g, `'"'"'`)}'`;
  return [
    ...POSTGRES_CREDENTIAL_LINES,
    `gunzip -t ${p} || { echo "cds-restore: 读不出这份 gz（见上一行 gunzip 的输出），未导入任何内容" >&2; exit 65; }`,
    // psql 的 stdout 是噪音（一堆 SET / DROP 回显），赶到 stderr，别混进退出码通道。
    `codes=$( { { gunzip -c ${p}; echo "gunzip=$?" >&4; }`
      + ' | { psql -U "$CDS_PG_USER" -d "$CDS_PG_DB" -v ON_ERROR_STOP=1 --quiet >&2; echo "psql=$?" >&4; }; } 4>&1 )',
    `u=$(printf '%s\\n' "$codes" | sed -n 's/^gunzip=//p')`,
    `m=$(printf '%s\\n' "$codes" | sed -n 's/^psql=//p')`,
    // 读不到退出码按失败处理——「不确定」不能当成「成功」。
    '[ "${u:-1}" = 0 ] || exit "${u:-1}"',
    '[ "${m:-1}" = 0 ] || exit "${m:-1}"',
    'exit 0',
  ].join('\n');
}

/**
 * 数一数目标库里有多少张用户表。
 *
 * 和 mysql 侧同样的用途：恢复前后各数一次，让「已恢复」这句话带着能被核对的数字，
 * 而不是一个自称。
 */
export function buildPostgresTableCountScript(): string {
  return [
    ...POSTGRES_CREDENTIAL_LINES,
    'psql -U "$CDS_PG_USER" -d "$CDS_PG_DB" -tAc "SELECT count(*) FROM information_schema.tables'
      + " WHERE table_schema NOT IN ('pg_catalog','information_schema')\"",
  ].join('\n');
}

/**
 * 先确认能跟 rabbitmq 节点说上话。
 *
 * 和 mysql / postgres 不同，`rabbitmqctl` 不用账号口令——它靠 Erlang cookie 连本机节点，
 * 所以这里没有「挑一套凭据」的问题，只有「节点起来了没有」。
 *
 * 用 `await_startup` 而不是 `status`：容器刚起来的那几十秒里节点在 boot，
 * 任何命令都会失败，而那不是「坏了」是「还没好」。await_startup 会等到 boot 完成，
 * 超时才算真的连不上。给 20 秒上限，免得一台真的起不来的节点把整轮备份拖住。
 */
const RABBITMQ_PROBE_LINES: readonly string[] = [
  'CDS_RMQ_PROBE=$(rabbitmqctl -q -t 20 await_startup 2>&1) || {',
  '  echo "cds-backup: 连不上 rabbitmq 节点（20s 内没等到 await_startup）：$CDS_RMQ_PROBE" >&2',
  '  exit 78',
  '}',
];

/**
 * 这份备份**没带走什么**，当场说清楚。
 *
 * definitions 导的是拓扑（vhost / 队列与交换机的声明 / 绑定 / 用户 / 权限 / 策略 / 参数），
 * **队列里的消息一条都不在里面**。这不是实现取舍，是 definitions 这个东西的定义——
 * RabbitMQ 没有「把消息一致性快照出来」的命令。
 *
 * 所以这条注记是无条件发的，而且带上数字：光说「不含消息」谁都不会当回事，
 * 说「当前积压 12000 条消息不在这份备份里」才是一个能让人做决定的事实。
 *
 * 数不出来时说「数不出来」，不拿 0 顶替——一个真的空队列和一次失败的查询，
 * 在「输出为空」这件事上长得一模一样，混着报就又是一次「以为有、其实没有」。
 * 所以退出码单独接一手，不靠输出是否为空来猜。
 *
 * 走 stderr：stdout 是备份产物本身，往里写一个字都会污染 definitions JSON。
 */
export const RABBITMQ_SCOPE_NOTE_LINES: readonly string[] = [
  // **跨全部 vhost 数，不能只数默认那个。** definitions 是跨 vhost 的，而
  // `list_queues` 不带 `-p` 只看默认 vhost `/`。默认 vhost 空、消息全在别的
  // vhost 里时，上一版会打出「当前没有积压消息，这一轮没有东西被漏下」——
  // 一句当场就能被证伪的假绿，而那些消息确实没有任何备份（Codex review P1）。
  'CDS_RMQ_UNKNOWN=0',
  'CDS_RMQ_MSGS=0',
  // 走临时文件而不是 `for v in $(...)`：vhost 名字里可以有空格，词分割会把
  // 一个 vhost 拆成两个再双双查不到。`while ... done < file` 不起子 shell，
  // 循环里对计数器的赋值在循环结束后仍然有效（管道写法就不行）。
  'CDS_RMQ_VH_FILE=$(mktemp /tmp/cds-rmq-vhosts-XXXXXX) || CDS_RMQ_UNKNOWN=1',
  'if [ "$CDS_RMQ_UNKNOWN" = 0 ]; then',
  '  rabbitmqctl -q list_vhosts name > "$CDS_RMQ_VH_FILE" 2>/dev/null || CDS_RMQ_UNKNOWN=1',
  'fi',
  'if [ "$CDS_RMQ_UNKNOWN" = 0 ]; then',
  '  while IFS= read -r cds_rmq_v; do',
  '    [ -n "$cds_rmq_v" ] || continue',
  '    CDS_RMQ_Q=$(rabbitmqctl -q list_queues -p "$cds_rmq_v" messages 2>/dev/null) || { CDS_RMQ_UNKNOWN=1; break; }',
  // 只累加纯数字行：任何版本差异带来的表头/提示行都进不了这个和。
  `    CDS_RMQ_N=$(printf '%s\\n' "$CDS_RMQ_Q" | awk 'BEGIN{s=0}/^[0-9]+$/{s+=$1}END{print s}')`,
  '    CDS_RMQ_MSGS=$((CDS_RMQ_MSGS + CDS_RMQ_N))',
  '  done < "$CDS_RMQ_VH_FILE"',
  'fi',
  'rm -f "$CDS_RMQ_VH_FILE"',
  // 有积压才算「这轮少备了东西」。**0 条时只报说明、不算缺口**——definitions 不含
  // 消息是这套机制固有的，无条件当缺口会让任何装了 rabbitmq 的部署健康位永远刷不新
  //（Codex review P1）。数不出来时按缺口从严：证明不了没漏，就当漏了。
  'if [ "$CDS_RMQ_UNKNOWN" != 0 ]; then',
  '  echo "cds-backup-gap: 这份备份只有 definitions（vhost/队列/交换机/绑定/用户/权限/策略），'
    + '队列里的消息不在里面；当前积压多少条没数出来（列 vhost 或列队列失败），按有积压从严处理" >&2',
  'elif [ "$CDS_RMQ_MSGS" -gt 0 ] 2>/dev/null; then',
  '  echo "cds-backup-gap: 这份备份只有 definitions（vhost/队列/交换机/绑定/用户/权限/策略），'
    + '队列里的消息不在里面；全部 vhost 当前合计积压 $CDS_RMQ_MSGS 条消息，它们不会被这份备份带走" >&2',
  'else',
  '  echo "cds-backup-scope: 这份备份只有 definitions（vhost/队列/交换机/绑定/用户/权限/策略），'
    + '队列里的消息不在里面；全部 vhost 当前都没有积压消息，这一轮没有东西被漏下" >&2',
  'fi',
];

/**
 * RabbitMQ 导出：definitions 转 JSON，容器内流式压缩。
 *
 * ## 为什么是 definitions 而不是别的
 *
 * RabbitMQ 没有「全量一致性备份」这种东西。官方给的持久化恢复手段就两条：
 * 拷 mnesia 数据目录（要求节点停机，而且换个节点名就读不回来），或者导 definitions。
 * 前者做不成「跑着的服务定期备份」，所以只有后者可用。
 *
 * 代价是**消息不在里面**——由 RABBITMQ_SCOPE_NOTE_LINES 每轮当场报出来，
 * 不做成一句藏在文档里的免责声明。
 *
 * ## 为什么带 -q
 *
 * 不加 `-q` 时 rabbitmqctl 会往 stdout 打「Exporting definitions ...」之类的提示行，
 * 那会直接混进 JSON 里，产出一份**看起来成功、其实解析不了**的备份。
 *
 * 管道退出码那三个坑（默认只给最后一环、dash 没有 pipefail、gzip 写盘失败留下截断档案
 * 还被当成功）在 `buildMysqlDumpScript` 的注释里写全了，这里用同一套 fd3 / fd4 写法。
 */
export function buildRabbitmqDumpScript(): string {
  return [
    ...RABBITMQ_PROBE_LINES,
    ...RABBITMQ_SCOPE_NOTE_LINES,
    'exec 3>&1',
    'codes=$( { { rabbitmqctl -q export_definitions - --format=json;'
      + ' echo "dump=$?" >&4; }'
      + ' | { gzip -n -c >&3; echo "gzip=$?" >&4; }; } 4>&1 )',
    `d=$(printf '%s\\n' "$codes" | sed -n 's/^dump=//p')`,
    `g=$(printf '%s\\n' "$codes" | sed -n 's/^gzip=//p')`,
    '[ "${d:-1}" = 0 ] || exit "${d:-1}"',
    '[ "${g:-1}" = 0 ] || exit "${g:-1}"',
  ].join('\n');
}

/**
 * RabbitMQ 恢复：把 definitions 灌回节点。
 *
 * ## 一个和 SQL 那两条完全不同的语义，必须知道
 *
 * `import_definitions` 是**合并**不是**替换**。pg_dump 那份带着 `DROP ... IF EXISTS`，
 * 灌回去之后库的状态就等于备份那一刻；definitions 不是——它只会把文件里写的东西声明出来，
 * **备份之后新建的队列、交换机、用户会原样留着**。
 *
 * 也就是说这条路能救「配置被删了」，救不了「配置被加错了」。这一点写在这里，
 * 是因为它没法在代码里修（RabbitMQ 就没给替换语义），只能让用的人知道。
 *
 * 其余（先 `gunzip -t` 验完整性、两端退出码经 fd4 回传）与 mysql / postgres 同一套写法。
 */
export function buildRabbitmqRestoreScript(inContainerPath: string): string {
  // 单引号里只有 `'` 需要处理，其余字符（含 $ ` \ 空格）都是字面量。
  const p = `'${String(inContainerPath).replace(/'/g, `'"'"'`)}'`;
  return [
    ...RABBITMQ_PROBE_LINES,
    `gunzip -t ${p} || { echo "cds-restore: 读不出这份 gz（见上一行 gunzip 的输出），未导入任何内容" >&2; exit 65; }`,
    // rabbitmqctl 的 stdout 是噪音，赶到 stderr，别混进退出码通道。
    `codes=$( { { gunzip -c ${p}; echo "gunzip=$?" >&4; }`
      + ' | { rabbitmqctl -q import_definitions - --format=json >&2; echo "import=$?" >&4; }; } 4>&1 )',
    `u=$(printf '%s\\n' "$codes" | sed -n 's/^gunzip=//p')`,
    `m=$(printf '%s\\n' "$codes" | sed -n 's/^import=//p')`,
    // 读不到退出码按失败处理——「不确定」不能当成「成功」。
    '[ "${u:-1}" = 0 ] || exit "${u:-1}"',
    '[ "${m:-1}" = 0 ] || exit "${m:-1}"',
    'exit 0',
  ].join('\n');
}

/**
 * 数一数默认 vhost 里有多少个队列。
 *
 * 和 mysql / postgres 侧的数表同一个用途：恢复前后各数一次，让「已恢复」这句话
 * 带着能被核对的数字。
 *
 * **只覆盖默认 vhost**，而 definitions 是跨 vhost 的——这个数字是个证人，不是账本。
 * 跨 vhost 计数要循环 `list_vhosts` 再逐个 `list_queues -p`，在这里换来的精度
 * 不值它增加的版本兼容面。
 *
 * `awk` 兜底而不是 `grep -c .`：一个队列都没有时 grep 退出码是 1，
 * 会把整条取证判成失败——而「零个队列」是一个完全正常的答案。
 */
export function buildRabbitmqQueueCountScript(): string {
  return [
    ...RABBITMQ_PROBE_LINES,
    `rabbitmqctl -q list_queues name 2>/dev/null | awk 'NF{n++}END{print n+0}'`,
  ].join('\n');
}

/**
 * nacos 导出的公共前置：挑一个 HTTP 客户端、算出根地址、必要时登录、确认服务活着。
 *
 * ## 为什么走 HTTP 而不是拷数据目录
 *
 * nacos 的配置可能落在内嵌 Derby，也可能落在外部 MySQL，**同一个镜像两种形态**，
 * 而容器外面看不出来是哪一种。配置导出接口对两种形态给出同一份产物，
 * 所以它是唯一一条不用先猜存储后端的路。
 *
 * 拷 Derby 目录那条路还有个更硬的问题：热拷一个正在写的 Derby 库，拿到的东西
 * 可能根本打不开——那是「导得出、灌不回」，等于没有备份。
 *
 * ## 为什么容忍 curl 缺失但绝不静默
 *
 * 官方镜像里有没有 curl 是**关于镜像的假设**，不是关于我们脚本的。所以两种客户端
 * 都试，一个都没有就退 78 并说清原因——**绝不产出一份空的、看起来成功的备份**。
 */
const NACOS_CLIENT_LINES: readonly string[] = [
  'if command -v curl >/dev/null 2>&1; then CDS_NACOS_HTTP=curl',
  'elif command -v wget >/dev/null 2>&1; then CDS_NACOS_HTTP=wget',
  'else',
  '  echo "cds-backup: 容器里既没有 curl 也没有 wget，而 nacos 的配置只能从它的 HTTP 接口导出" >&2',
  '  exit 78',
  'fi',
  'cds_nacos_get() {',
  '  if [ "$CDS_NACOS_HTTP" = curl ]; then curl -fsS "$1"; else wget -q -O - "$1"; fi',
  '}',
  'cds_nacos_download() {',
  '  if [ "$CDS_NACOS_HTTP" = curl ]; then curl -fsS -o "$2" "$1"; else wget -q -O "$2" "$1"; fi',
  '}',
  // 端口与上下文路径都可被 env 改（2.4 起上下文路径默认成了根），所以不写死。
  // 上下文路径要去掉首尾斜杠再拼。运维按 servlet 习惯写成 `/nacos` 或 `/` 是常态，
  // 直接插值会拼出 `//nacos` / `//`，之后探活、列命名空间、导出、导入**全部打错路径**
  // ——而默认路径的容器用例照样绿，这种漏法只有配了上下文路径的实例才会撞上
  // （Codex review P2）。
  `CDS_NACOS_CTX=$(printf '%s' "\${NACOS_CONTEXT_PATH:-nacos}" | sed 's#^/*##; s#/*$##')`,
  'CDS_NACOS_BASE="http://127.0.0.1:${NACOS_APPLICATION_PORT:-8848}${CDS_NACOS_CTX:+/$CDS_NACOS_CTX}"',
  'CDS_NACOS_AUTH=""',
  'case "$(printf \'%s\' "${NACOS_AUTH_ENABLE:-}" | tr \'A-Z\' \'a-z\')" in',
  '  true|1|yes)',
  '    if [ "$CDS_NACOS_HTTP" != curl ]; then',
  // wget 只能把 POST body 摆在命令行上，那会让口令进容器的进程列表。
  // 宁可这一轮不备份，也不为了跑通把口令泄出去（与 nats 那次的教训同源）。
  '      echo "cds-backup: nacos 开了鉴权，但容器里只有 wget——用它登录会把口令摆进进程列表，拒绝这么做" >&2',
  '      exit 78',
  '    fi',
  '    CDS_NACOS_USER="${NACOS_AUTH_USERNAME:-${NACOS_USERNAME:-nacos}}"',
  '    CDS_NACOS_PW="${NACOS_AUTH_PASSWORD:-${NACOS_PASSWORD:-}}"',
  '    if [ -z "$CDS_NACOS_PW" ]; then',
  '      echo "cds-backup: nacos 开了鉴权，容器 env 里却没有口令（找过 NACOS_AUTH_PASSWORD / NACOS_PASSWORD）" >&2',
  '      exit 78',
  '    fi',
  // **两个登录端点都试。**
  //
  // nacos 换过位置：`/v1/auth/users/login` 与 `/v1/auth/login` 在不同大版本上
  // 各自成立，写死哪一个都会在另一个版本上 404——而 404 之后 token 是空的，
  // 于是「开了鉴权的 nacos 一次备份都做不了」，报的还只是「没拿到 accessToken」，
  // 看不出是端点错了（Codex review P1）。
  //
  // 与其赌自己记得哪个版本用哪个，不如两个都打一次：先新后旧，谁给出 accessToken
  // 就用谁。多一次失败请求的代价，远小于「整类部署静默备不了」。
  // body 一律走 stdin（`--data-binary @-`），不进 argv：容器内 ps 看不到口令。
  '    cds_nacos_login() {',
  '      printf \'username=%s&password=%s\' "$CDS_NACOS_USER" "$CDS_NACOS_PW"'
    + ' | curl -fsS --data-binary @- "$1" 2>/dev/null'
    + ' | sed -n \'s/.*"accessToken":"\\([^"]*\\)".*/\\1/p\'',
  '    }',
  '    CDS_NACOS_TOKEN=$(cds_nacos_login "$CDS_NACOS_BASE/v1/auth/users/login")',
  '    if [ -z "$CDS_NACOS_TOKEN" ]; then',
  '      CDS_NACOS_TOKEN=$(cds_nacos_login "$CDS_NACOS_BASE/v1/auth/login")',
  '    fi',
  '    if [ -z "$CDS_NACOS_TOKEN" ]; then',
  '      echo "cds-backup: nacos 登录没拿到 accessToken（用户=$CDS_NACOS_USER，'
    + '两个端点都试过了：/v1/auth/users/login 与 /v1/auth/login），导不出配置" >&2',
  '      exit 78',
  '    fi',
  '    CDS_NACOS_AUTH="&accessToken=$CDS_NACOS_TOKEN"',
  '    ;;',
  'esac',
  // 先真连一次。连不上就停在这里，不带着一个空结果往下走。
  'CDS_NACOS_PROBE=$(cds_nacos_get "$CDS_NACOS_BASE/v1/console/health/readiness?cds=1$CDS_NACOS_AUTH" 2>&1) || {',
  '  echo "cds-backup: 连不上 nacos（$CDS_NACOS_BASE）：$CDS_NACOS_PROBE" >&2',
  '  exit 78',
  '}',
];

/**
 * 列出所有命名空间。public 那个在接口里的 id 是空串，本文件用 `__public__` 代表它。
 *
 * 为什么要逐个命名空间导：nacos 的配置导出接口**一次只能导一个命名空间**
 * （tenant 参数），没有跨命名空间的全量导出。只导 public 的话，
 * 凡是把配置放在自定义命名空间的项目，备份会是一份看起来成功的空壳。
 */
const NACOS_NAMESPACE_LINES: readonly string[] = [
  // **先把响应整个拿到手，再解析。**
  //
  // 原来是 `cds_nacos_get ... | tr | sed` 一条管道：shell 看到的退出码是**最后一环
  // sed 的**，而 sed 对着空输入照样退 0。于是命名空间接口一旦失败（网络、鉴权、
  // 改版），`CDS_NACOS_NS` 静默变成空，接下来只导 public 一个命名空间，
  // 还报「成功，1 个命名空间」——一份看起来成功的空壳，而这正是本文件反复在防的东西
  // （Codex review P1）。所以取值与解析分成两步，取值失败当场退出。
  'CDS_NACOS_NS_RAW=$(cds_nacos_get "$CDS_NACOS_BASE/v1/console/namespaces?cds=1$CDS_NACOS_AUTH" 2>&1) || {',
  '  echo "cds-backup: 列不出 nacos 命名空间（$CDS_NACOS_BASE）：$CDS_NACOS_NS_RAW" >&2',
  '  echo "cds-backup: 拿不到命名空间清单就无法保证备全，拒绝只导 public 冒充全量" >&2',
  '  exit 78',
  '}',
  // 响应必须长得像命名空间清单。返回 200 但内容是登录页 / 错误 JSON 时，
  // 解析出零个命名空间和「真的只有 public」长得一模一样——那是同一个坑的另一半。
  'case "$CDS_NACOS_NS_RAW" in',
  '  *\'"namespace"\'*) ;;',
  '  *)',
  '    echo "cds-backup: 命名空间接口的响应里没有 namespace 字段，认不出这是清单，拒绝当成空清单继续" >&2',
  '    exit 78',
  '    ;;',
  'esac',
  `CDS_NACOS_NS=$(printf '%s' "$CDS_NACOS_NS_RAW"`
    + ' | tr \'{\' \'\\n\' | sed -n \'s/.*"namespace":"\\([^"]*\\)".*/\\1/p\')',
  'CDS_NACOS_NS_COUNT=1',
  'for ns in $CDS_NACOS_NS; do CDS_NACOS_NS_COUNT=$((CDS_NACOS_NS_COUNT+1)); done',
];

/**
 * nacos 导出：逐命名空间取配置 zip，打成一包再压。
 *
 * 产物是 `tar.gz`，里面每个命名空间一个 `.zip`，文件名就是命名空间 id
 * （public 那个叫 `__public__.zip`）。这样恢复时能一个个原样灌回对应命名空间。
 *
 * 管道退出码那三个坑（默认只给最后一环、dash 没有 pipefail、gzip 写盘失败留下
 * 截断档案还被当成功）在 `buildMysqlDumpScript` 的注释里写全了，这里同一套 fd3/fd4 写法。
 */
export function buildNacosDumpScript(): string {
  return [
    ...NACOS_CLIENT_LINES,
    ...NACOS_NAMESPACE_LINES,
    // 这份备份**没带走什么**，当场说清楚：服务注册列表是各实例自己上报的、
    // 重启会重来，本来就不该备；用户/角色/权限存在库里，配置导出接口不含它们。
    'echo "cds-backup-scope: 这份备份是 nacos 的配置（$CDS_NACOS_NS_COUNT 个命名空间），'
      + '不含服务注册列表与用户/角色/权限——它们不在配置导出接口里" >&2',
    'CDS_NACOS_DIR=$(mktemp -d /tmp/cds-nacos-XXXXXX) || { echo "cds-backup: 建不出临时目录" >&2; exit 74; }',
    'trap \'rm -rf "$CDS_NACOS_DIR"\' EXIT',
    'for ns in __public__ $CDS_NACOS_NS; do',
    '  CDS_NACOS_TENANT=""',
    '  [ "$ns" = "__public__" ] || CDS_NACOS_TENANT="$ns"',
    '  cds_nacos_download'
      + ' "$CDS_NACOS_BASE/v1/cs/configs?export=true&group=&appName=&ids=&tenant=$CDS_NACOS_TENANT$CDS_NACOS_AUTH"'
      + ' "$CDS_NACOS_DIR/$ns.zip" || {',
    '    echo "cds-backup: 导出命名空间 [$ns] 失败，整轮作废——半份备份比没有更危险" >&2',
    '    exit 1',
    '  }',
    'done',
    'exec 3>&1',
    'codes=$( { { tar -cf - -C "$CDS_NACOS_DIR" .; echo "tar=$?" >&4; }'
      + ' | { gzip -n -c >&3; echo "gzip=$?" >&4; }; } 4>&1 )',
    't=$(printf \'%s\\n\' "$codes" | sed -n \'s/^tar=//p\')',
    'g=$(printf \'%s\\n\' "$codes" | sed -n \'s/^gzip=//p\')',
    '[ "${t:-1}" = 0 ] || exit "${t:-1}"',
    '[ "${g:-1}" = 0 ] || exit "${g:-1}"',
  ].join('\n');
}

/**
 * nacos 恢复：把每个命名空间的 zip 灌回对应命名空间。
 *
 * ## 三件必须知道的事
 *
 * 1. **导入策略是 OVERWRITE**：同名配置以备份里的为准。备份之后**新建**的配置
 *    不会被删掉——和 rabbitmq 的 definitions 一样，这条路能救「配置被删/被改坏了」，
 *    救不了「配置被加错了」。nacos 的导入接口就没给「清空后导入」这个语义。
 * 2. **命名空间必须已经存在**：导入不会替你建命名空间。备份里有而目标上没有的，
 *    那一包会被拒绝，脚本当场整体失败，不让它变成一次「部分成功」。
 * 3. **失败也可能回 HTTP 200**：nacos 的导入接口把结果写在 body 的 `code` 里，
 *    只看退出码会把失败读成成功——psql 那条（默认遇错继续照样 exit 0）的同一形状。
 *    所以这里还要检查 body。
 *
 * 上传要走 multipart，wget 做不了，所以恢复这条路强制要 curl。
 */
export function buildNacosRestoreScript(inContainerPath: string): string {
  // 单引号里只有 `'` 需要处理，其余字符（含 $ ` \ 空格）都是字面量。
  const p = `'${String(inContainerPath).replace(/'/g, `'"'"'`)}'`;
  return [
    ...NACOS_CLIENT_LINES,
    'if [ "$CDS_NACOS_HTTP" != curl ]; then',
    '  echo "cds-restore: 导入要走 multipart 上传，容器里没有 curl，做不到" >&2',
    '  exit 78',
    'fi',
    // 先验完整性再动配置。空文件、传了一半的文件在这里就出局。
    `gzip -t ${p} || { echo "cds-restore: 读不出这份 gz（见上一行 gzip 的输出），未导入任何内容" >&2; exit 65; }`,
    'CDS_NACOS_DIR=$(mktemp -d /tmp/cds-nacos-XXXXXX) || { echo "cds-restore: 建不出临时目录" >&2; exit 74; }',
    'trap \'rm -rf "$CDS_NACOS_DIR"\' EXIT',
    `tar -xzf ${p} -C "$CDS_NACOS_DIR" || { echo "cds-restore: 这份包解不开，未导入任何内容" >&2; exit 65; }`,
    'CDS_NACOS_DONE=0',
    'for f in "$CDS_NACOS_DIR"/*.zip; do',
    // glob 没匹配到时 sh 会把模式原样留下，`-f` 挡住它。
    '  [ -f "$f" ] || continue',
    '  ns=$(basename "$f" .zip)',
    '  CDS_NACOS_TENANT=""',
    '  [ "$ns" = "__public__" ] || CDS_NACOS_TENANT="$ns"',
    '  CDS_NACOS_RESP=$(curl -fsS -F "file=@$f"'
      + ' "$CDS_NACOS_BASE/v1/cs/configs?import=true&policy=OVERWRITE&namespace=$CDS_NACOS_TENANT$CDS_NACOS_AUTH"'
      + ' 2>&1) || {',
    '    echo "cds-restore: 导入命名空间 [$ns] 失败：$CDS_NACOS_RESP" >&2',
    '    exit 1',
    '  }',
    '  case "$CDS_NACOS_RESP" in',
    '    *\'"code":200\'*) ;;',
    '    *)',
    '      echo "cds-restore: 导入命名空间 [$ns] 被 nacos 拒绝：$CDS_NACOS_RESP" >&2',
    '      exit 1',
    '      ;;',
    '  esac',
    '  CDS_NACOS_DONE=$((CDS_NACOS_DONE+1))',
    'done',
    'if [ "$CDS_NACOS_DONE" = 0 ]; then',
    // 一个 zip 都没有 = 这份备份是空的。报成功会让人以为已经恢复了。
    '  echo "cds-restore: 这份包里一个命名空间都没有，什么都没导入" >&2',
    '  exit 65',
    'fi',
    'exit 0',
  ].join('\n');
}

/**
 * 数一数所有命名空间加起来有多少条配置。
 *
 * 和 mysql / postgres 侧的数表同一个用途：恢复前后各数一次，让「已恢复」这句话
 * 带着能被核对的数字。这里是跨命名空间求和，覆盖面与备份本身一致。
 */
export function buildNacosConfigCountScript(): string {
  return [
    ...NACOS_CLIENT_LINES,
    ...NACOS_NAMESPACE_LINES,
    'CDS_NACOS_TOTAL=0',
    'for ns in __public__ $CDS_NACOS_NS; do',
    '  CDS_NACOS_TENANT=""',
    '  [ "$ns" = "__public__" ] || CDS_NACOS_TENANT="$ns"',
    // 先把响应整个接住再解析。**不能直接 `cds_nacos_get | sed`**：管道的退出码是
    // 最后一条命令的，sed 对着空输入照样成功，于是「这个命名空间没查通」和
    // 「这个命名空间有 0 条配置」变成同一件事。下面 `${CDS_NACOS_N:-0}` 再把它
    // 兜成一个真实的 0，最后恢复端点报出一个看着可信、其实少算了的数字
    //（Codex review P2）。数不出来就必须让整段脚本失败，让调用方显示「未知」。
    '  CDS_NACOS_BODY=$(cds_nacos_get'
      + ' "$CDS_NACOS_BASE/v1/cs/configs?search=accurate&dataId=&group=&pageNo=1&pageSize=1'
      + '&tenant=$CDS_NACOS_TENANT$CDS_NACOS_AUTH" 2>/dev/null)',
    '  if [ $? -ne 0 ]; then',
    '    echo "cds-count: 命名空间 $ns 查询失败，数不出配置条数" >&2',
    '    exit 66',
    '  fi',
    '  CDS_NACOS_N=$(printf %s "$CDS_NACOS_BODY"'
      + ' | sed -n \'s/.*"totalCount":\\([0-9]*\\).*/\\1/p\')',
    // 查通了但响应里没有 totalCount：同样是「数不出来」，不是 0。
    '  case "$CDS_NACOS_N" in',
    '    "" | *[!0-9]* )',
    '      echo "cds-count: 命名空间 $ns 的响应里没有 totalCount，数不出配置条数" >&2',
    '      exit 66',
    '      ;;',
    '  esac',
    '  CDS_NACOS_TOTAL=$((CDS_NACOS_TOTAL + CDS_NACOS_N))',
    'done',
    'echo "$CDS_NACOS_TOTAL"',
  ].join('\n');
}

/**
 * 导出脚本写给 stderr 的作用域说明的机器标记。调用方靠它把这一行认出来。
 *
 * 名字里不带类型：postgres（同实例别的库没备）和 rabbitmq（消息不在里面）都在用它，
 * 后面还会有别的。叫 `POSTGRES_*` 的共享常量迟早被人复制出第二份。
 */
export const BACKUP_SCOPE_NOTE_MARKER = 'cds-backup-scope:';

/**
 * 「这一轮真的少备了东西」的机器标记。**只有它算覆盖缺口、只有它拉低健康位。**
 *
 * 与 `BACKUP_SCOPE_NOTE_MARKER` 分家的理由见 `BackupOutcome.gapNote`：说明性的
 * 那一行（definitions 不含消息、配置导出不含服务注册）是每轮无条件报的，
 * 把它当缺口会让健康位永远刷不新。
 */
export const BACKUP_GAP_NOTE_MARKER = 'cds-backup-gap:';

/** 从一段 stderr 里捞出作用域说明（没有就返回 null）。 */
export function extractBackupScopeNote(stderr: string): string | null {
  return extractMarkedNote(stderr, BACKUP_SCOPE_NOTE_MARKER);
}

/** 从一段 stderr 里捞出「这轮真的少备了」的说明（没有就返回 null）。 */
export function extractBackupGapNote(stderr: string): string | null {
  return extractMarkedNote(stderr, BACKUP_GAP_NOTE_MARKER);
}

/**
 * 两个标记共用一套取值，别让它们各写一遍（形状 3：判据分裂后各自漂移）。
 *
 * 用 `startsWith` 而不是 `includes`：`cds-backup-scope:` 是 `cds-backup-gap:` 之外
 * 的另一个前缀，但两行都以 `cds-backup-` 开头，将来再加第三个标记时，
 * `includes` 很容易让一行被两个提取器同时认领。
 */
function extractMarkedNote(stderr: string, marker: string): string | null {
  const line = String(stderr || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith(marker));
  return line ? line.slice(marker.length).trim() : null;
}
