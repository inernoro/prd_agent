// Active Update Store — sidecar 和主进程共用的 SSOT。
//
// 历史背景:在此之前 self-update 进度状态只存在于主进程的 RAM
// (state.ts: private activeSelfUpdate),进程 process.exit + spawn 新进程时
// state 直接消失。前端显示"actor: unknown / 卡 web-build 2m / 不可达"四件套
// 全部源于这个根因。本模块把状态从 RAM 搬到磁盘文件,sidecar 进程负责写,
// 主进程 + 浏览器读,跨进程持续可见。
//
// 文件路径:`<repoRoot>/.cds/active-update.json`(与 state.json 同目录)
// 写入策略:.tmp + rename(原子);不加 lock(单写者:sidecar)
//
// 字段语义见 types.ts:ActiveSelfUpdate。本模块只负责 IO,业务语义在
// sidecar.ts / state.ts。

import fs from 'node:fs';
import path from 'node:path';
import type { ActiveSelfUpdate } from '../types.js';

const FILE_BASENAME = 'active-update.json';
const LOG_TAIL_MAX = 50;

export function activeUpdatePath(repoRoot: string): string {
  return path.join(repoRoot, '.cds', FILE_BASENAME);
}

/** 读 active-update.json。文件不存在 / 解析失败 → null(等价于"无活动更新")。 */
export function readActiveUpdate(repoRoot: string): ActiveSelfUpdate | null {
  const fp = activeUpdatePath(repoRoot);
  if (!fs.existsSync(fp)) return null;
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.startedAt !== 'string') return null;
    return parsed as ActiveSelfUpdate;
  } catch {
    return null;
  }
}

/** 原子写入 active-update.json(.tmp + rename)。不抛错,失败静默,
 *  避免 sidecar 因为磁盘满 / 权限问题崩溃影响 update 主流程。 */
export function writeActiveUpdate(repoRoot: string, rec: ActiveSelfUpdate): void {
  const dir = path.join(repoRoot, '.cds');
  const fp = activeUpdatePath(repoRoot);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = fp + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
    fs.renameSync(tmp, fp);
  } catch {
    /* swallow — sidecar 会继续推进流程,前端拿不到状态而已 */
  }
}

/** 删 active-update.json(update 流程结束时调用)。失败静默。 */
export function clearActiveUpdate(repoRoot: string): void {
  const fp = activeUpdatePath(repoRoot);
  try {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch {
    /* swallow */
  }
}

/** 写一条日志行进 logTail(ring buffer)。同时刷新 lastTickAt + step(可选)。
 *  sidecar 每完成一步、每条 stderr 输出、每 5 秒心跳都调一次。 */
export function appendLogLine(
  repoRoot: string,
  args: {
    step?: string;
    level: 'info' | 'warning' | 'error';
    text: string;
  },
): void {
  const cur = readActiveUpdate(repoRoot);
  if (!cur) return;
  const tail = Array.isArray(cur.logTail) ? [...cur.logTail] : [];
  tail.push({
    ts: new Date().toISOString(),
    level: args.level,
    text: args.text.slice(0, 500), // 防止单行 stderr 撑爆文件
  });
  while (tail.length > LOG_TAIL_MAX) tail.shift();
  writeActiveUpdate(repoRoot, {
    ...cur,
    step: args.step ?? cur.step,
    lastTickAt: new Date().toISOString(),
    logTail: tail,
  });
}

/** 仅刷新 lastTickAt(心跳),不动其他字段。sidecar 在长操作里(vite build)
 *  每 5 秒调一次,避免前端误判失联。 */
export function tickHeartbeat(repoRoot: string): void {
  const cur = readActiveUpdate(repoRoot);
  if (!cur) return;
  writeActiveUpdate(repoRoot, { ...cur, lastTickAt: new Date().toISOString() });
}

/** 探测 pid 是否还活着。Linux/macOS:process.kill(pid, 0) 不发信号,
 *  pid 不存在 → 抛 ESRCH;permission denied → 抛 EPERM(说明 pid 还活着)。
 *  不存在 / pid<=0 → false。 */
export function isPidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true; // 进程存在但我们没权限发信号
    return false; // ESRCH or any other
  }
}

/** 启动时清扫:文件存在 + pid 已死 → 标 interrupted(让前端看到"上次中断")。
 *  返回 'cleared' / 'marked-interrupted' / 'still-running' / 'no-file'。
 *  调用方:cds/src/index.ts(主进程启动时 once)、exec_cds.sh master-run 前置。 */
export function reconcileStaleOnStartup(
  repoRoot: string,
): 'cleared' | 'marked-interrupted' | 'still-running' | 'no-file' {
  const cur = readActiveUpdate(repoRoot);
  if (!cur) return 'no-file';
  // 已经标过 interrupted 的不再处理 — 等下次正常更新触发时被覆盖。
  if (cur.interrupted) return 'marked-interrupted';
  if (isPidAlive(cur.pid)) return 'still-running';
  // pid 死了 + 还没标 interrupted → sidecar 异常退出。打标。
  const newTail: ActiveSelfUpdate['logTail'] = [
    ...(cur.logTail || []),
    {
      ts: new Date().toISOString(),
      level: 'error' as const,
      text: `[startup] sidecar pid=${cur.pid ?? '?'} 已退出但未清理状态文件 — 标记为中断`,
    },
  ].slice(-LOG_TAIL_MAX);
  writeActiveUpdate(repoRoot, {
    ...cur,
    interrupted: true,
    lastTickAt: new Date().toISOString(),
    logTail: newTail,
  });
  return 'marked-interrupted';
}
