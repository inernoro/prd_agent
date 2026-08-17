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
 * 只解析路径并打印出来（不触发 BGSAVE）。恢复流程要知道「该往哪写」，
 * 但不该顺手给人家存一次盘。凭据解析沿用探测脚本那一段。
 */
export function buildRedisRdbPathScript(): string {
  const probe = buildRedisBackupProbeScript().split('\n');
  const credEnd = probe.findIndex((l) => l.startsWith('export REDISCLI_AUTH'));
  return [...probe.slice(0, credEnd + 1), ...REDIS_RDB_PATH_LINES, 'printf "%s" "$RDB"'].join('\n');
}

export function buildRedisBackupProbeScript(): string {
  return [
  // 凭据：env 优先，其次扫容器内进程命令行里的 --requirepass。
  'A="${REDIS_PASSWORD:-${REDIS_PASS:-$REDISCLI_AUTH}}"',
  'if [ -z "$A" ]; then',
  // PROCDIR 只是给回归留的注入点（容器里没人会设它）。抽取这段 awk 是最容易写错
  // 的地方，必须能拿真 shell 对着真的 NUL 分隔 cmdline 跑一遍，而不是断言「源码里
  // 有这行」——那种断言在这段代码变成死分支时照样是绿的。
  '  PROCDIR="${CDS_BACKUP_PROC_DIR:-/proc}"',
  '  for c in "$PROCDIR"/[0-9]*/cmdline; do',
  '    [ -r "$c" ] || continue',
  `    A=$(tr '\\0' '\\n' < "$c" | awk '/^--requirepass=/{sub(/^--requirepass=/,"");print;exit} /^--requirepass$/{getline;print;exit}')`,
  '    [ -n "$A" ] && break',
  '  done',
  'fi',
  'export REDISCLI_AUTH="$A"',
  // 落盘时间的下界。容器自己的时钟，避免宿主与容器时钟不一致。
  'start=$(date +%s)',
  // 连得上且认证通过，才谈得上后面的事。
  'ping=$(redis-cli PING 2>&1) || { echo "redis-cli 调用失败: $ping" >&2; exit 21; }',
  'case "$ping" in PONG) ;; *) echo "redis 不可用或认证失败: $ping" >&2; exit 22;; esac',
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
export function buildMysqlDumpScript(): string {
  return [
    // 凭据在容器内展开：不进宿主命令行、不进 CDS 日志、不进宿主 ps。
    'export MYSQL_PWD="${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}"',
    // fd3 = 真正的 stdout（宿主那个文件）；fd4 = 回传两端退出码的通道。
    'exec 3>&1',
    'codes=$( { { mysqldump -uroot --all-databases --single-transaction --quick --routines --events; echo "dump=$?" >&4; }'
      + ' | { gzip -n -c >&3; echo "gzip=$?" >&4; }; } 4>&1 )',
    // 读不到退出码按失败处理：宁可重跑一轮，也不要认一份来路不明的产物。
    `d=$(printf '%s\\n' "$codes" | sed -n 's/^dump=//p')`,
    `g=$(printf '%s\\n' "$codes" | sed -n 's/^gzip=//p')`,
    '[ "${d:-1}" = 0 ] || exit "${d:-1}"',
    '[ "${g:-1}" = 0 ] || exit "${g:-1}"',
  ].join('\n');
}
