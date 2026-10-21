import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ExecAssignment } from '../types.js';

export interface MaintenanceDirectoryIdentity { path: string; dev: number; ino: number }
interface ProcessBirth { platform: 'linux' | 'darwin'; boot: string; scope: string; pid: number; start: string }
interface MaintenanceBoot {
  initialization: string;
  birth: ProcessBirth;
  entry: MaintenanceDirectoryIdentity;
  module: MaintenanceDirectoryIdentity;
  confirmed: boolean;
}
interface RetentionSlot {
  ownerId: string;
  backup: MaintenanceDirectoryIdentity;
  producer: MaintenanceBoot | null;
  source: { sha: string; branch: string } | null;
  phase: 'allocated' | 'complete' | 'retained' | 'retiring' | 'restoring' | 'discarding';
  existed?: boolean[];
  writer?: ExecAssignment;
  retirementToken?: string;
}
interface RetentionManifest {
  version: 1;
  root: MaintenanceDirectoryIdentity;
  base: MaintenanceDirectoryIdentity;
  revision: number;
  slots: RetentionSlot[];
}
export interface MaintenanceRetirement {
  revision: number;
  previousOwnerId: string;
  replacementOwnerId: string;
  token: string;
  backup: MaintenanceDirectoryIdentity;
  existed: boolean[];
  requester: MaintenanceBoot;
}
const manifestName = 'checkpoint-retention.json';
const initialization = randomUUID();
const boots = new Map<string, MaintenanceBoot | null>();
const uuid = /^[a-f0-9-]{36}$/;
const claimName = '.retirement-writer.json';
const fail = () => new Error('CDS 受管恢复副本身份或终态未确认，已保留恢复点，请检查维护状态。');

/** 小入口身份；备份中的任何代码、链接或目录名称都不产生删除权。 */
export function maintenanceDirectoryIdentity(dir: string): MaintenanceDirectoryIdentity {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dir) !== path.resolve(dir)) throw fail();
  return { path: path.resolve(dir), dev: stat.dev, ino: stat.ino };
}
function fileIdentity(file: string): MaintenanceDirectoryIdentity {
  const canonical = fs.realpathSync(file), stat = fs.lstatSync(canonical);
  if (!stat.isFile()) throw fail();
  return { path: canonical, dev: stat.dev, ino: stat.ino };
}
function same(a: MaintenanceDirectoryIdentity, b: MaintenanceDirectoryIdentity): boolean {
  return a.path === b.path && a.dev === b.dev && a.ino === b.ino;
}
function identity(value: unknown): value is MaintenanceDirectoryIdentity {
  const v = value as MaintenanceDirectoryIdentity;
  return Boolean(v && typeof v.path === 'string' && path.isAbsolute(v.path)
    && Number.isSafeInteger(v.dev) && v.dev >= 0 && Number.isSafeInteger(v.ino) && v.ino > 0);
}
function osBirth(pid: number): ProcessBirth {
  if (!Number.isSafeInteger(pid) || pid < 1) throw fail();
  if (process.platform === 'linux') {
    const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const scope = fs.readlinkSync('/proc/self/ns/pid');
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const start = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    if (!uuid.test(boot) || !/^\d+$/.test(start ?? '')) throw fail();
    return { platform: 'linux', boot, scope, pid, start };
  }
  if (process.platform === 'darwin') {
    const options = { encoding: 'utf8' as const, timeout: 1000, maxBuffer: 4096,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
    const raw = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], options);
    const boot = /^\{ sec = (\d+), usec = (\d+) \}/.exec(raw);
    const start = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], options).trim();
    if (!boot || !/^[A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/.test(start)) throw fail();
    return { platform: 'darwin', boot: `${boot[1]}:${boot[2]}`, scope: 'host', pid, start };
  }
  throw fail();
}
function birthShape(value: unknown): value is ProcessBirth {
  const b = value as ProcessBirth;
  return Boolean(b && ['linux', 'darwin'].includes(b.platform) && typeof b.boot === 'string' && b.boot.length < 128
    && typeof b.scope === 'string' && b.scope.length < 128 && Number.isSafeInteger(b.pid) && b.pid > 0
    && typeof b.start === 'string' && b.start.length < 128
    && (b.platform === 'linux' ? uuid.test(b.boot) && /^pid:\[\d+\]$/.test(b.scope) && /^\d+$/.test(b.start)
      : /^\d+:\d+$/.test(b.boot) && b.scope === 'host'
        && /^[A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/.test(b.start)));
}
function bootShape(value: unknown): value is MaintenanceBoot {
  const b = value as MaintenanceBoot;
  return Boolean(b && uuid.test(b.initialization) && typeof b.confirmed === 'boolean'
    && identity(b.entry) && identity(b.module) && birthShape(b.birth));
}
function currentBoot(root: string): MaintenanceBoot | null {
  if (!boots.has(root)) {
    try {
      boots.set(root, { initialization, birth: osBirth(process.pid),
        entry: fileIdentity(process.argv[1] || fileURLToPath(import.meta.url)),
        module: fileIdentity(fileURLToPath(import.meta.url)), confirmed: false });
    } catch { boots.set(root, null); }
  }
  return boots.get(root)!;
}
/** 仅由实际入口监听成功处调用；source组件需显式接线，不能以HEAD/ready文件代替。 */
export function confirmMaintenanceBoot(repoRoot: string): void {
  const root = maintenanceDirectoryIdentity(fs.realpathSync(repoRoot));
  const boot = currentBoot(root.path);
  if (!boot) { console.warn('[self-maintenance] 本代出生身份未确认，恢复副本不会自动退役。'); return; }
  boot.confirmed = true;
}
function ended(boot: MaintenanceBoot, requester: MaintenanceBoot): boolean {
  if (!boot.confirmed || boot.initialization === requester.initialization || boot.birth.platform !== requester.birth.platform) return false;
  return birthEnded(boot.birth, requester.birth);
}
function birthEnded(birth: ProcessBirth, requester: ProcessBirth): boolean {
  if (birth.platform !== requester.platform) return false;
  if (birth.boot !== requester.boot) return true;
  if (birth.scope !== requester.scope) return false;
  try {
    const actual = osBirth(birth.pid);
    return actual.boot === requester.boot && actual.scope === requester.scope && actual.start !== birth.start;
  } catch {
    // 查询失败不是消失；只有同boot/namespace的内核ESRCH才确认原出生已结束。
    try { process.kill(birth.pid, 0); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    return false;
  }
}
function writerConfirmed(writer: ExecAssignment | undefined): writer is ExecAssignment {
  return Boolean(writer && writer.lane === 'operation' && Number.isSafeInteger(writer.jobId) && writer.jobId > 0
    && Number.isSafeInteger(writer.factoryGeneration) && writer.factoryGeneration! > 0
    && Number.isSafeInteger(writer.factoryPid) && writer.factoryPid! > 1
    && Number.isSafeInteger(writer.actorPid) && writer.actorPid! > 1);
}
function baseFor(root: MaintenanceDirectoryIdentity): MaintenanceDirectoryIdentity {
  if (!same(root, maintenanceDirectoryIdentity(root.path))) throw fail();
  return maintenanceDirectoryIdentity(path.join(root.path, 'cds/.cds'));
}
function validateSlot(slot: RetentionSlot, base: MaintenanceDirectoryIdentity): void {
  if (!slot || !uuid.test(slot.ownerId) || !identity(slot.backup) || path.dirname(slot.backup.path) !== base.path
    || !new RegExp(`^restart-rollback-${slot.ownerId}-[A-Za-z0-9]{6}$`).test(path.basename(slot.backup.path))
    || !['allocated', 'complete', 'retained', 'retiring', 'restoring', 'discarding'].includes(slot.phase)
    || slot.producer !== null && !bootShape(slot.producer)
    || slot.source !== null && (!slot.source || !/^[a-f0-9]{40}$/i.test(slot.source.sha)
      || typeof slot.source.branch !== 'string' || slot.source.branch.length > 512)
    || slot.phase !== 'allocated' && slot.phase !== 'discarding' && (!Array.isArray(slot.existed)
      || slot.existed.length !== 5 || slot.existed.some(v => typeof v !== 'boolean'))
    || slot.writer !== undefined && !writerConfirmed(slot.writer)) throw fail();
  if (slot.retirementToken !== undefined && !uuid.test(slot.retirementToken)) throw fail();
}
function readClaim(slot: RetentionSlot): { token: string; birth: ProcessBirth; identity: MaintenanceDirectoryIdentity } | undefined {
  const file = path.join(slot.backup.path, claimName);
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 2048 || (stat.mode & 0o077) !== 0) throw fail();
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!uuid.test(value.token) || !birthShape(value.birth)) throw fail();
    return { ...value, identity: { path: file, dev: stat.dev, ino: stat.ino } };
  } finally { fs.closeSync(fd); }
}
function requireWriterEnded(slot: RetentionSlot, requester: MaintenanceBoot): void {
  const claim = readClaim(slot);
  if (claim && !birthEnded(claim.birth, requester.birth)) throw fail();
}
function readManifest(root: MaintenanceDirectoryIdentity): RetentionManifest {
  const base = baseFor(root), file = path.join(base.path, manifestName);
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, root, base, revision: 0, slots: [] };
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 16_384 || (stat.mode & 0o077) !== 0) throw fail();
    const value = JSON.parse(fs.readFileSync(fd, 'utf8')) as RetentionManifest;
    if (value.version !== 1 || !identity(value.root) || !same(value.root, root) || !identity(value.base)
      || !same(value.base, base) || !Number.isSafeInteger(value.revision) || value.revision < 1
      || !Array.isArray(value.slots) || value.slots.length > 2) throw fail();
    value.slots.forEach(slot => validateSlot(slot, base));
    if (new Set(value.slots.map(slot => slot.ownerId)).size !== value.slots.length) throw fail();
    return value;
  } finally { fs.closeSync(fd); }
}
function encoded(manifest: RetentionManifest): string {
  const text = JSON.stringify({ ...manifest, revision: manifest.revision + 1 });
  if (Buffer.byteLength(text) > 16_384) throw fail();
  return text;
}
function writeManifest(manifest: RetentionManifest): void {
  const file = path.join(manifest.base.path, manifestName), temporary = `${file}.${randomUUID()}.tmp`;
  const text = encoded(manifest);
  if (readManifest(manifest.root).revision !== manifest.revision) throw fail();
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    if (readManifest(manifest.root).revision !== manifest.revision) throw fail();
    fs.renameSync(temporary, file);
    const dir = fs.openSync(manifest.base.path, 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    if (fs.readFileSync(file, 'utf8') !== text) throw fail();
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function protectedSlot(slot: RetentionSlot): boolean {
  return ['complete', 'retained', 'retiring'].includes(slot.phase) && slot.source !== null
    && slot.producer?.confirmed === true && writerConfirmed(slot.writer) && slot.existed?.length === 5;
}

/** 固定两槽，没有扫描器；未完成或未知的旧事务不会分配第三份大副本。 */
export function reserveRetention(root: MaintenanceDirectoryIdentity, backup: MaintenanceDirectoryIdentity,
  ownerId: string, source?: { sha: string; branch: string }): void {
  const manifest = readManifest(root);
  if (manifest.slots.length === 2 || manifest.slots.some(slot => slot.phase !== 'retained')) throw fail();
  const boot = currentBoot(root.path);
  if (manifest.slots.some(slot => !boot?.confirmed || !slot.producer || !ended(slot.producer, boot))) throw fail();
  if (boot) manifest.slots.forEach(slot => requireWriterEnded(slot, boot));
  manifest.slots.push({ ownerId, backup, source: source ?? null,
    producer: boot ? structuredClone(boot) : null, phase: 'allocated' });
  writeManifest(manifest);
}
export function completeRetention(root: MaintenanceDirectoryIdentity, ownerId: string, existed: boolean[], writer?: ExecAssignment): void {
  const manifest = readManifest(root), slot = manifest.slots.find(slot => slot.ownerId === ownerId);
  if (!slot || slot.phase !== 'allocated') throw fail();
  slot.existed = [...existed]; slot.phase = 'complete';
  if (writerConfirmed(writer)) slot.writer = { ...writer };
  writeManifest(manifest);
}
export function recoverCompleteRetention(root: MaintenanceDirectoryIdentity): void {
  const manifest = readManifest(root), boot = currentBoot(root.path), slot = manifest.slots[0];
  const last = manifest.slots.at(-1);
  if (last?.phase === 'discarding' && boot?.confirmed && last.producer && ended(last.producer, boot)) {
    try { fs.lstatSync(last.backup.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // 已处置意图+精确入口已消失，只压缩小记录，不据此授权任何新深删。
      forgetRetention(root, last.ownerId); return;
    }
  }
  if (manifest.slots.length !== 1 || slot.phase !== 'complete') return;
  if (!boot?.confirmed || !protectedSlot(slot) || !slot.producer || !ended(slot.producer, boot)) throw fail();
  requireWriterEnded(slot, boot);
  slot.phase = 'retained'; writeManifest(manifest);
}
/** 同票深删前记录有限处置意图；崩溃后不能把已restore的空副本冒作完整保护点。 */
export function markRetentionDisposition(root: MaintenanceDirectoryIdentity, ownerId: string, phase: 'restoring' | 'discarding', existed: boolean[]): void {
  const manifest = readManifest(root), slot = manifest.slots.find(slot => slot.ownerId === ownerId);
  if (!slot) return; // 独立三动作组件可没有受管登记，不导入未知历史副本。
  if (existed.length !== 5 || existed.some(value => typeof value !== 'boolean')) throw fail();
  slot.existed ??= [...existed];
  slot.phase = phase; writeManifest(manifest);
}
export function forgetRetention(root: MaintenanceDirectoryIdentity, ownerId: string): void {
  const manifest = readManifest(root), index = manifest.slots.findIndex(slot => slot.ownerId === ownerId);
  if (index < 0) return;
  if (manifest.slots[index].phase !== 'discarding') throw fail();
  manifest.slots.splice(index, 1);
  if (manifest.slots.length) writeManifest(manifest);
  else {
    if (readManifest(root).revision !== manifest.revision) throw fail();
    fs.unlinkSync(path.join(manifest.base.path, manifestName));
    const directory = fs.openSync(manifest.base.path, 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
}
/** finished已经线性化。仅小元数据异步发布；调用方不得等待它延长许可后的一秒退出。 */
export async function sealRetention(root: MaintenanceDirectoryIdentity, ownerId: string): Promise<void> {
  const manifest = readManifest(root), slot = manifest.slots.find(slot => slot.ownerId === ownerId);
  if (!slot || slot.phase !== 'complete' || !protectedSlot(slot)
    || slot.producer?.initialization !== initialization) throw fail();
  slot.phase = 'retained';
  const text = encoded(manifest), file = path.join(manifest.base.path, manifestName);
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.promises.open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(text); await handle.sync(); }
    finally { await handle.close(); }
    if (readManifest(root).revision !== manifest.revision) throw fail();
    // 最后复核与小文件rename之间不yield；旧异步回执不能在新revision后覆盖清单。
    fs.renameSync(temporary, file);
    const directory = await fs.promises.open(manifest.base.path, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    if (await fs.promises.readFile(file, 'utf8') !== text) throw fail();
  } finally { await fs.promises.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export function retirementFor(root: MaintenanceDirectoryIdentity): MaintenanceRetirement | undefined {
  const manifest = readManifest(root);
  if (manifest.slots.length !== 2) return;
  const [previous, replacement] = manifest.slots, requester = currentBoot(root.path);
  if (!requester?.confirmed || !protectedSlot(previous) || !protectedSlot(replacement) || !previous.producer
    || !ended(previous.producer, requester) || !replacement.producer
    || replacement.producer.initialization !== requester.initialization && !ended(replacement.producer, requester)) throw fail();
  if (!same(replacement.backup, maintenanceDirectoryIdentity(replacement.backup.path))) throw fail();
  requireWriterEnded(previous, requester); requireWriterEnded(replacement, requester);
  const token = randomUUID();
  previous.phase = 'retiring'; previous.retirementToken = token; writeManifest(manifest);
  // 先撤销尚未启动的旧许可，再重读原子claim；不能把“刚才未见writer”当作无迟到writer。
  const claim = readClaim(replacement);
  if (claim) {
    if (!birthEnded(claim.birth, requester.birth) || !same(claim.identity, fileIdentity(claim.identity.path))) throw fail();
    fs.unlinkSync(claim.identity.path);
  }
  return { revision: manifest.revision + 1, previousOwnerId: previous.ownerId,
    replacementOwnerId: replacement.ownerId, token, backup: { ...replacement.backup },
    existed: [...replacement.existed!], requester: structuredClone(requester) };
}
/** 唯一新深删用途：消费精确两槽事务，绝不执行备份代码或接受任意path列表。 */
export function retireRetainedCheckpoint(root: MaintenanceDirectoryIdentity, permit: MaintenanceRetirement): void {
  const manifest = readManifest(root), [previous, replacement] = manifest.slots;
  if (!permit || !bootShape(permit.requester) || !permit.requester.confirmed || manifest.slots.length !== 2
    || manifest.revision !== permit.revision || previous.ownerId !== permit.previousOwnerId
    || replacement.ownerId !== permit.replacementOwnerId || previous.phase !== 'retiring'
    || previous.retirementToken !== permit.token || !uuid.test(permit.token)
    || !same(replacement.backup, permit.backup) || !Array.isArray(permit.existed)
    || permit.existed.length !== 5 || permit.existed.some((v, i) => v !== replacement.existed?.[i])
    || !protectedSlot(previous) || !protectedSlot(replacement) || !previous.producer || !replacement.producer
    || !ended(previous.producer, permit.requester)
    || replacement.producer.initialization !== permit.requester.initialization && !ended(replacement.producer, permit.requester)
    || !same(replacement.backup, maintenanceDirectoryIdentity(replacement.backup.path))) throw fail();
  const caller = osBirth(permit.requester.birth.pid);
  if (JSON.stringify(caller) !== JSON.stringify(permit.requester.birth)) throw fail();
  requireWriterEnded(previous, permit.requester);
  const claimFile = path.join(replacement.backup.path, claimName), temporary = `${claimFile}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, JSON.stringify({ token: permit.token, birth: osBirth(process.pid) })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.linkSync(temporary, claimFile); // O_EXCL式完整发布实际worker出生；不复用残缺或未知claim。
  } finally { fs.unlinkSync(temporary); }
  const latest = readManifest(root);
  if (latest.revision !== permit.revision || latest.slots[0]?.retirementToken !== permit.token) throw fail();
  try {
    if (!same(previous.backup, maintenanceDirectoryIdentity(previous.backup.path))) throw fail();
    fs.rmSync(previous.backup.path, { recursive: true, force: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // 精确retiring意图已持久，旧producer和snapshot终态均已确认，崩溃续做无需重复深删。
  }
  try { fs.lstatSync(previous.backup.path); throw fail(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (replacement.producer.initialization !== permit.requester.initialization) replacement.phase = 'retained';
  manifest.slots.shift(); writeManifest(manifest);
}
