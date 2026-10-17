import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { PlatformRuntimeIdentity } from './platform-release-barrier.js';

// 此事务由独立维护进程执行，不可放进即将被停止的 master 内。
// 旧安装布局没有受支持的 Host 适配器时不得调用；没有默认 shell/SSH/daemon 实现。
export const PLATFORM_RELEASE_COVERAGE = [
  'http-webhook', 'branch-operations', 'deployment-executors', 'production-releases',
  'timers-replays', 'state-writers', 'forwarder-handoff',
] as const;

export interface PlatformBundle {
  commitSha: string;
  /** 来自独立保存的构建回执，不能从待校验目录重新生成期望值。 */
  treeSha256: string;
}
export interface PlatformReleaseHold {
  readonly coverage: readonly string[];
  /** 未知执行状态须拒绝；只等待自然结束，不允许取消业务任务。 */
  seal(timeoutMs: number): Promise<void>;
  assertSealed(): void;
  /** 必须在实际进程代际、页面/API 和应用不变指纹核验后才调用。 */
  reopen(): Promise<void>;
}
export interface PlatformReleaseHost {
  /** 外部监督器取得跨进程独占资格；崩溃恢复须证明旧控制器已退出，不能用 TTL 抢锁。 */
  acquire(id: string, expected: PlatformRuntimeIdentity, recovery: boolean): Promise<PlatformReleaseHold>;
  identity(): Promise<PlatformRuntimeIdentity>;
  /** 只停止本事务拥有的控制面进程；禁止扫描/停止应用容器或全 cgroup。 */
  stopOwned(id: string): Promise<void>;
  start(id: string, bundleDirectory: string, bundle: PlatformBundle): Promise<void>;
  /** 验证实际加载后端、前端及依赖，不能只返回 Git HEAD 或健康 200。 */
  verify(bundle: PlatformBundle, applicationFingerprint: string): Promise<{
    runtime: PlatformRuntimeIdentity; treeSha256: string; surfaceReady: boolean;
    applicationsUnchanged: boolean; admissionClosed: boolean;
  }>;
}
export interface PlatformReleasePlan {
  /** 专用发布根目录，已有 current/ 完整运行包；不能传项目 checkout 或业务数据目录。 */
  root: string;
  candidateDirectory: string;
  baseline: PlatformBundle;
  candidate: PlatformBundle;
  expectedRuntime: PlatformRuntimeIdentity;
  applicationFingerprint: string;
  drainTimeoutMs: number;
}
type Phase = 'prepared' | 'draining' | 'stopping' | 'switching' | 'starting' | 'verifying'
  | 'restoring' | 'restored' | 'committed' | 'aborted' | 'recovery-required';
interface Journal {
  version: 1; id: string; phase: Phase; baseline: PlatformBundle; candidate: PlatformBundle;
  expectedRuntime: PlatformRuntimeIdentity; applicationFingerprint: string; drainTimeoutMs: number;
  events: Array<{ phase: Phase; at: string }>;
  failurePhase?: Phase;
  verifiedRuntime?: PlatformRuntimeIdentity;
}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const validSha = (value: unknown, length: number): value is string => typeof value === 'string'
  && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
function validateBundle(bundle: PlatformBundle): void {
  if (!bundle || !validSha(bundle.commitSha, 40) || !validSha(bundle.treeSha256, 64)) throw new Error('运行包身份无效');
}
function validateRuntime(runtime: PlatformRuntimeIdentity): void {
  if (!runtime || !Number.isSafeInteger(runtime.pid) || runtime.pid <= 1
    || !Number.isFinite(Date.parse(runtime.startedAt)) || !validSha(runtime.commitSha, 40)) throw new Error('运行进程身份无效');
}
function sameRuntime(a: PlatformRuntimeIdentity, b: PlatformRuntimeIdentity): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt && a.commitSha === b.commitSha;
}
function directory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== path.resolve(directory)) {
    throw new Error('发布路径必须为真实目录，不允许符号链接');
  }
}

/** 对路径、内容和权限一起校验；不跟随链接、不读取设备、拒绝多硬链接文件。 */
export function platformBundleDigest(root: string): string {
  directory(root);
  // 运行包和现有安装目录不是同一契约。禁止把 .cds、.env、业务数据或 checkout
  // 一起交给换盘事务，即使调用方为它们计算了正确的校验和也不能放行。
  const allowed = new Set(['dist', 'web', 'node_modules', 'package.json', 'pnpm-lock.yaml', 'build-info.json']);
  directory(path.join(root, 'web'));
  if (fs.readdirSync(root).some(name => !allowed.has(name))
    || fs.readdirSync(path.join(root, 'web')).some(name => name !== 'dist')) {
    throw new Error('运行包只能包含编译产物和运行依赖，不允许状态、凭据或业务目录');
  }
  const files: Array<[string, number, string]> = [['/', fs.statSync(root).mode & 0o777, '']];
  const walk = (relative: string) => {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const key = path.posix.join(relative, name);
      const full = path.join(root, key), stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error('运行包不允许符号链接');
      if (stat.isDirectory()) { files.push([`${key}/`, stat.mode & 0o777, '']); walk(key); }
      else if (stat.isFile() && stat.nlink === 1) files.push([key, stat.mode & 0o777, digest(fs.readFileSync(full))]);
      else throw new Error('运行包包含非普通文件或硬链接');
    }
  };
  walk('');
  for (const entry of ['dist/index.js', 'web/dist/index.html', 'package.json']) {
    if (!files.some(([name]) => name === entry)) throw new Error(`运行包缺少 ${entry}`);
  }
  return digest(JSON.stringify(files));
}
function verifyBundle(root: string, bundle: PlatformBundle): void {
  validateBundle(bundle);
  if (platformBundleDigest(root) !== bundle.treeSha256) throw new Error('运行包完整性校验失败');
}
function syncDirectory(root: string): void {
  const fd = fs.openSync(root, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function durableJson(filename: string, value: unknown): void {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, filename); syncDirectory(path.dirname(filename));
}
function record(root: string, journal: Journal, phase: Phase): void {
  journal.phase = phase;
  journal.events.push({ phase, at: new Date().toISOString() });
  durableJson(path.join(root, '.release-lock', 'journal.json'), journal);
}
function assertHold(hold: PlatformReleaseHold): void {
  if (!PLATFORM_RELEASE_COVERAGE.every(name => hold.coverage.includes(name))) throw new Error('发布入口覆盖不完整');
  hold.assertSealed();
}
async function verifyRunning(host: PlatformReleaseHost, journal: Journal, bundle: PlatformBundle): Promise<void> {
  const proof = await host.verify(bundle, journal.applicationFingerprint);
  validateRuntime(proof.runtime);
  if (proof.runtime.commitSha !== bundle.commitSha
    || (proof.runtime.pid === journal.expectedRuntime.pid && proof.runtime.startedAt === journal.expectedRuntime.startedAt)
    || proof.treeSha256 !== bundle.treeSha256 || proof.surfaceReady !== true
    || proof.applicationsUnchanged !== true || proof.admissionClosed !== true) {
    throw new Error('控制面代际、运行包、页面或应用保持核验失败');
  }
  journal.verifiedRuntime = proof.runtime;
}
function finish(root: string, journal: Journal): void {
  const receipts = path.join(root, 'receipts');
  if (!fs.existsSync(receipts)) fs.mkdirSync(receipts, { mode: 0o700 });
  directory(receipts);
  const receipt = path.join(receipts, `${journal.id}.json`);
  // 同一事务的终态回执不可被下一次发布覆盖。
  const source = path.join(root, '.release-lock', 'journal.json');
  if (fs.existsSync(receipt)) {
    if (!fs.readFileSync(receipt).equals(fs.readFileSync(source))) throw new Error('终态回执冲突，保留维护锁');
  } else fs.copyFileSync(source, receipt, fs.constants.COPYFILE_EXCL);
  const fd = fs.openSync(receipt, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(receipts);
  fs.rmSync(path.join(root, '.release-lock'), { recursive: true }); syncDirectory(root);
}

/**
 * 有意不提供线上默认适配器或 HTTP 激活入口。调用者必须是持有托管资格的外部控制器。
 * 不编译、不 checkout、不调用 Docker；运行包与业务状态完全分离，旧包保留供复核。
 */
export async function executePlatformRelease(plan: PlatformReleasePlan, host: PlatformReleaseHost): Promise<Journal> {
  directory(plan.root); directory(plan.candidateDirectory);
  validateBundle(plan.baseline); validateBundle(plan.candidate); validateRuntime(plan.expectedRuntime);
  if (plan.expectedRuntime.commitSha !== plan.baseline.commitSha || !validSha(plan.applicationFingerprint, 64)
    || !Number.isSafeInteger(plan.drainTimeoutMs) || plan.drainTimeoutMs < 1
    || plan.baseline.commitSha === plan.candidate.commitSha) throw new Error('发布计划身份或排空期限无效');
  // 候选在发布根外，防止复制 current/备份/事务目录时发生自包含。
  const relation = path.relative(path.resolve(plan.root), path.resolve(plan.candidateDirectory));
  const reverse = path.relative(path.resolve(plan.candidateDirectory), path.resolve(plan.root));
  const outside = (value: string) => value.startsWith(`..${path.sep}`) || value === '..';
  if (!outside(relation) || !outside(reverse)) throw new Error('候选和专用发布根目录不得互相包含');
  const current = path.join(plan.root, 'current');
  verifyBundle(current, plan.baseline); verifyBundle(plan.candidateDirectory, plan.candidate);
  if (!sameRuntime(await host.identity(), plan.expectedRuntime)) throw new Error('发布前进程身份漂移');
  fs.mkdirSync(path.join(plan.root, '.release-lock'), { mode: 0o700 }); // EEXIST 永不按时间抢占
  const journal: Journal = { version: 1, id: randomUUID(), phase: 'prepared', baseline: plan.baseline,
    candidate: plan.candidate, expectedRuntime: plan.expectedRuntime,
    applicationFingerprint: plan.applicationFingerprint, drainTimeoutMs: plan.drainTimeoutMs, events: [] };
  record(plan.root, journal, 'prepared');
  let hold: PlatformReleaseHold | undefined;
  let stopping = false;
  let acquiring = false;
  try {
    const next = path.join(plan.root, `.candidate-${journal.id}`);
    fs.cpSync(plan.candidateDirectory, next, { recursive: true, errorOnExist: true, force: false });
    verifyBundle(next, journal.candidate);
    acquiring = true;
    hold = await host.acquire(journal.id, journal.expectedRuntime, false);
    if (!PLATFORM_RELEASE_COVERAGE.every(name => hold!.coverage.includes(name))) throw new Error('发布入口覆盖不完整');
    record(plan.root, journal, 'draining');
    await hold.seal(plan.drainTimeoutMs);
    assertHold(hold);
    if (!sameRuntime(await host.identity(), journal.expectedRuntime)) throw new Error('排空后进程身份漂移');
    verifyBundle(current, journal.baseline); verifyBundle(next, journal.candidate);
    assertHold(hold);
    record(plan.root, journal, 'stopping'); stopping = true;
    await host.stopOwned(journal.id);
    assertHold(hold);
    record(plan.root, journal, 'switching');
    fs.renameSync(current, path.join(plan.root, `.baseline-${journal.id}`)); syncDirectory(plan.root);
    fs.renameSync(next, current); syncDirectory(plan.root);
    record(plan.root, journal, 'starting');
    await host.start(journal.id, current, journal.candidate);
    record(plan.root, journal, 'verifying');
    await verifyRunning(host, journal, journal.candidate);
    assertHold(hold);
    // 完整终态先持久化，再解除准入；若解除失败，恢复入口只重试解除，不再换盘。
    record(plan.root, journal, 'committed');
    await hold.reopen();
    finish(plan.root, journal);
    return journal;
  } catch (error) {
    journal.failurePhase ??= journal.phase;
    if (journal.phase === 'committed' || journal.phase === 'restored') throw error;
    if (stopping && hold) {
      await restore(plan.root, journal, host, hold);
    } else if (acquiring && !hold) {
      // 监督器可能已持闸但回执丢失；不能猜测取得失败就等于没有副作用。
      record(plan.root, journal, 'recovery-required');
    } else {
      // seal 超时可能仍在落盘，reopen 必须拒绝；保留日志和锁供维护者恢复。
      try {
        if (hold) await hold.reopen();
        record(plan.root, journal, 'aborted'); finish(plan.root, journal);
      } catch { record(plan.root, journal, 'recovery-required'); }
    }
    throw error; // 恢复成功也不能把原发布判为成功
  }
}

async function restore(root: string, journal: Journal, host: PlatformReleaseHost, hold: PlatformReleaseHold): Promise<void> {
  try {
    assertHold(hold);
    record(root, journal, 'restoring');
    await host.stopOwned(journal.id);
    assertHold(hold);
    const current = path.join(root, 'current'), baseline = path.join(root, `.baseline-${journal.id}`);
    if (fs.existsSync(baseline)) {
      verifyBundle(baseline, journal.baseline);
      if (fs.existsSync(current)) fs.renameSync(current, path.join(root, `.rejected-${journal.id}-${randomUUID()}`));
      fs.renameSync(baseline, current); syncDirectory(root);
    }
    verifyBundle(current, journal.baseline);
    await host.start(journal.id, current, journal.baseline);
    await verifyRunning(host, journal, journal.baseline);
    assertHold(hold);
    record(root, journal, 'restored');
    await hold.reopen(); finish(root, journal);
  } catch (error) {
    if (journal.phase !== 'restored') record(root, journal, 'recovery-required');
    throw error;
  }
}

/** 新控制器只能通过 supervisor 的独占恢复协议接续，绝不仅凭旧 PID 消失/租约过期解锁。 */
export async function recoverPlatformRelease(root: string, host: PlatformReleaseHost): Promise<Journal> {
  directory(root); directory(path.join(root, '.release-lock'));
  const journal = JSON.parse(fs.readFileSync(path.join(root, '.release-lock', 'journal.json'), 'utf8')) as Journal;
  if (journal.version !== 1 || !/^[0-9a-f-]{36}$/.test(journal.id) || !Array.isArray(journal.events)
    || !validSha(journal.applicationFingerprint, 64) || !Number.isSafeInteger(journal.drainTimeoutMs)
    || journal.drainTimeoutMs < 1) throw new Error('发布恢复日志无效');
  validateBundle(journal.baseline); validateBundle(journal.candidate); validateRuntime(journal.expectedRuntime);
  const allowed: Phase[] = ['prepared', 'draining', 'stopping', 'switching', 'starting', 'verifying', 'restoring',
    'restored', 'committed', 'aborted', 'recovery-required'];
  if (!allowed.includes(journal.phase)) throw new Error('发布恢复阶段无效');
  const hold = await host.acquire(journal.id, journal.expectedRuntime, true);
  await hold.seal(journal.drainTimeoutMs); assertHold(hold);
  if (journal.phase === 'committed' || journal.phase === 'restored') {
    const bundle = journal.phase === 'committed' ? journal.candidate : journal.baseline;
    verifyBundle(path.join(root, 'current'), bundle);
    await verifyRunning(host, journal, bundle);
    await hold.reopen(); finish(root, journal);
  } else if (!journal.events.some(event => event.phase === 'stopping')) {
    verifyBundle(path.join(root, 'current'), journal.baseline);
    if (!sameRuntime(await host.identity(), journal.expectedRuntime)) throw new Error('换盘前恢复的进程身份漂移');
    record(root, journal, 'aborted'); await hold.reopen(); finish(root, journal);
  } else {
    await restore(root, journal, host, hold);
  }
  return journal;
}
