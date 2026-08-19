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

export type BackupKind = 'mongo' | 'redis' | 'mysql';

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
}

export interface BackupTarget extends BackupCandidate {
  kind: BackupKind;
  /** 落盘文件名（不含目录）。 */
  fileName: string;
}

export interface BackupPlan {
  targets: BackupTarget[];
  /** 跳过的原因，逐条可解释——「这次没备份什么」和「备份了什么」同样重要。 */
  skipped: Array<{ id: string; reason: string; blocksHealthy: boolean }>;
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

/** 只有这几类有成熟的一致性导出手段；其余类型不假装能备。 */
export function backupKindOf(dockerImage: string): BackupKind | null {
  const l = (dockerImage || '').toLowerCase();
  if (l.includes('mongo')) return 'mongo';
  if (l.includes('redis')) return 'redis';
  if (l.includes('mysql') || l.includes('mariadb')) return 'mysql';
  return null;
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
      skipped.push({ id: c.id, reason: '容器未运行', blocksHealthy: false });
      continue;
    }
    const kind = backupKindOf(c.dockerImage);
    if (!kind) {
      skipped.push({
        id: c.id,
        reason: `暂不支持自动备份的类型（${c.dockerImage}）`,
        blocksHealthy: true,
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

/** 只有每个运行中目标都得到可校验副本时，整轮才允许刷新健康时间。 */
export function isBackupRoundHealthy(plan: BackupPlan, outcomes: readonly BackupOutcome[]): boolean {
  return outcomes.length > 0
    && outcomes.every((outcome) => outcome.ok)
    && backupCoverageGaps(plan).length === 0;
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
  ok: boolean;
  fileName?: string;
  bytes?: number;
  error?: string;
  pruned?: string[];
  remoteObjectKey?: string;
  sha256?: string;
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
