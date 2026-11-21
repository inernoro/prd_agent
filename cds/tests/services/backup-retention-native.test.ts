import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKUP_RETENTION_PROGRAM } from '../../src/services/backup-retention-program.js';
import { DEFAULT_KEEP_COUNT, DEFAULT_KEEP_DAYS } from '../../src/services/infra-backup-schedule.js';

const roots: string[] = [];
const DAY = 86_400_000;
const now = Date.now();
function fixture(mountProbe = ' return [] # Unit descriptor fixture; Docker mounts are exercised in the real VM.') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-backup-retention-')); roots.push(directory);
  // Native files + this fixture's real writer descriptors. The full /proc guard is
  // separately exercised in a private Docker PID namespace, including query failure.
  const proc = path.join(directory, '.fixture-proc');fs.mkdirSync(path.join(proc, String(process.pid)), { recursive: true });
  fs.symlinkSync(`/proc/${process.pid}/fd`, path.join(proc, String(process.pid), 'fd'));
  const program = BACKUP_RETENTION_PROGRAM.replace('def backup_mount_references():\n',`def backup_mount_references():\n${mountProbe}\n`).replace("pathlib.Path('/proc')", `pathlib.Path(${JSON.stringify(proc)})`);
  const payload = (input: Record<string, unknown>) => JSON.stringify({ catalog: path.join(directory, '.cds-retention'), directories: [directory], instanceId: 'owned-instance', automaticPolicy: { keepCount: DEFAULT_KEEP_COUNT, keepDays: DEFAULT_KEEP_DAYS }, nowMs: now, ...input });
  const request = (input: Record<string, unknown>, timeout = 30_000) => JSON.parse(execFileSync('python3', ['-c', program], {
    input: payload(input), encoding: 'utf8', timeout,
  }));
  const backup = (name: string, age: number, serviceId = 'retired-db') => {
    const file = path.join(directory, name);fs.writeFileSync(file, gzipSync(Buffer.alloc(1024 * 1024, name)));
    fs.utimesSync(file, new Date(now - age * DAY), new Date(now - age * DAY));
    request({ action: 'register', path: file, projectId: 'owned-project', serviceId, origin: serviceId === 'active-db' ? 'automatic' : 'historical', sourceComplete: serviceId === 'active-db', sourceFingerprint: 'a'.repeat(64), disposition: serviceId === 'active-db' ? 'business-backup' : 'reproducible-artifact', attestedBy: 'unit-fixture-owner', dispositionReason: 'synthetic data in a private unit fixture' });return file;
  };
  return { directory, request, backup, program, payload };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
describe('independent native backup retention', () => {
  it('waits for short metadata contention before starting an actual backup lease', async () => {
    const f = fixture();
    f.backup('setup.gz', 0, 'active-db');
    const owner = spawn('python3', ['-c',
      'import sys,fcntl,time; f=open(sys.argv[1]); fcntl.flock(f,fcntl.LOCK_EX); print("locked",flush=True); time.sleep(.4)',
      path.join(f.directory, '.cds-retention/lock')]);
    const released = once(owner, 'exit');
    await once(owner.stdout!, 'data');
    const lease = { projectId: 'owned-project', serviceId: 'active-db', token: 'restore-fixture', kind: 'restore' };
    expect(f.request({ action: 'lease', ...lease })).toEqual({ leased: true });
    await released;
    expect(f.request({ action: 'release', ...lease })).toEqual({ released: true });
  });
  it('lets backup leases proceed during Docker mount discovery and protects the leased recovery point', async () => {
    const f = fixture([
      " print('scanning-mounts',flush=True)",
      " while not (pathlib.Path(req['directories'][0])/'.mounts-ready').exists():",
      '  check();time.sleep(.02)',
      ' return []',
    ].join('\n'));
    const old = f.backup('expired.gz', 20);
    const scan = spawn('python3', ['-c', f.program]);
    const complete = once(scan, 'close');
    let output = '';
    scan.stdout.on('data', data => { output += String(data); });
    scan.stdin.end(f.payload({ action: 'reconcile' }));
    const lease = { projectId: 'owned-project', serviceId: 'retired-db', token: 'backup-during-scan', kind: 'backup' };
    try {
      await once(scan.stdout, 'data');
      expect(f.request({ action: 'lease', ...lease }, 2_000)).toEqual({ leased: true });
    } finally {
      fs.writeFileSync(path.join(f.directory, '.mounts-ready'), '');
      await complete;
    }
    const report = JSON.parse(output.trim().split('\n').at(-1)!);
    expect(report.removed).toEqual([]);
    expect(report.held).toContainEqual({ path: old, reason: 'active-backup-or-restore-lease' });
    expect(fs.existsSync(old)).toBe(true);
    expect(f.request({ action: 'release', ...lease })).toEqual({ released: true });
  });
  it('retires an unregistered older local copy only with an exact, fresh, audited R2 proof', () => {
    const f = fixture();
    const recent = Array.from({ length: DEFAULT_KEEP_COUNT }, (_, index) => f.backup(`retained-${index}.gz`, index / 10, 'active-db'));
    const old = path.join(f.directory, 'owned-project--active-db-auto-20261110T000000Z.archive.gz');
    const content = gzipSync('legacy production-format fixture');
    fs.writeFileSync(old, content);
    fs.utimesSync(old, new Date(now - 3 * DAY), new Date(now - 3 * DAY));
    const request = { activeServices: [{ projectId: 'owned-project', serviceId: 'active-db', backupKey: 'owned-project--active-db' }], discoverOffsiteCopies: true };
    const plan = f.request({ ...request, action: 'preview' });
    expect(plan.historicalCandidates).toEqual([expect.objectContaining({ path: old })]);
    const evidence = { bytes: content.byteLength, sha256: createHash('sha256').update(content).digest('hex'),
      signature: plan.historicalCandidates[0].signature, verifiedAt: Date.now(), auditId: 'a1b2c3d4-a1b2-c3d4-a1b2-c3d4a1b2c3d4' };
    expect(f.request({ ...request, action: 'reconcile' }).removed).toEqual([]);
    expect(f.request({ ...request, action: 'reconcile', offsiteProofs: { [old]: { ...evidence, verifiedAt: now - 400_000 } } }).removed).toEqual([]);
    expect(f.request({ ...request, action: 'reconcile', offsiteProofs: { [old]: evidence } }).removed).toEqual([old]);
    expect(fs.existsSync(old)).toBe(false);
    expect(recent.every(file => fs.existsSync(file))).toBe(true);
  });
  it('keeps the producer allowance bounded across repeated exports without counting manual or incomplete copies', () => {
    const f = fixture();const automatic: string[] = [];
    for (let index = 0; index < DEFAULT_KEEP_COUNT + 2; index++) automatic.push(f.backup(`automatic-${index}.gz`, index / 10, 'active-db'));
    for (let index = 0; index < 9; index++) {
      const manual = f.backup(`manual-${index}.gz`, 0.01, 'active-db');
      f.request({ action: 'register', path: manual, projectId: 'owned-project', serviceId: 'active-db', origin: 'manual' });
    }
    const incomplete = f.backup('unconfirmed-export.gz', 0.02, 'active-db');
    f.request({ action: 'register', path: incomplete, projectId: 'owned-project', serviceId: 'active-db', origin: 'automatic', sourceComplete: false, sourceFingerprint: 'a'.repeat(64) });
    const plan = f.request({ action: 'preview' });
    expect(plan.automaticPolicy).toEqual({ keepCount: DEFAULT_KEEP_COUNT, keepDays: DEFAULT_KEEP_DAYS });
    expect(plan.candidates.map((row: any) => row.path).sort()).toEqual(automatic.slice(DEFAULT_KEEP_COUNT).sort());
    expect(f.request({ action: 'reconcile' }).removed.sort()).toEqual(automatic.slice(DEFAULT_KEEP_COUNT).sort());
    expect(automatic.filter(file => fs.existsSync(file))).toHaveLength(DEFAULT_KEEP_COUNT);
    expect(fs.existsSync(incomplete)).toBe(true);expect(f.request({ action: 'reconcile' }).removed).toEqual([]);
  });
  it('applies the existing automatic day limit with same-source replacement, while preserving the unique recovery point', () => {
    const f = fixture();const old = f.backup('fourteen-day-automatic.gz', DEFAULT_KEEP_DAYS + 0.5, 'active-db');
    expect(f.request({ action: 'reconcile' }).removed).toEqual([]);
    f.backup('new-complete-automatic.gz', 0, 'active-db');
    expect(f.request({ action: 'reconcile' }).removed).toEqual([old]);
  });
  it('does not share automatic slots across physical sources or let replaced exports evict valid ones', () => {
    const f = fixture();const valid: string[] = [];
    for (let index = 0; index < DEFAULT_KEEP_COUNT; index++) valid.push(f.backup(`valid-${index}.gz`, index / 10, 'active-db'));
    const replaced = f.backup('replaced-export.gz', 0, 'active-db');fs.writeFileSync(replaced, 'failed overwritten export');
    const other = f.backup('other-physical-source.gz', 0, 'active-db');
    f.request({ action: 'register', path: other, projectId: 'owned-project', serviceId: 'active-db', origin: 'automatic', sourceComplete: true, sourceFingerprint: 'b'.repeat(64) });
    const report = f.request({ action: 'reconcile' });expect(report.removed).toEqual([]);expect(report.scanStatus).toBe('partial');
    expect(valid.every(file => fs.existsSync(file))).toBe(true);expect(fs.existsSync(other)).toBe(true);
  });
  it('resumes a durable retirement intent whose rename never happened', () => {
    const f = fixture();const old = f.backup('interrupted-before-rename.gz', 20);
    const catalog = path.join(f.directory, '.cds-retention/backups.json');
    // Preserve the native nanosecond integers; JS round-tripping would change the receipt.
    execFileSync('python3', ['-c', 'import json,sys,pathlib;p=pathlib.Path(sys.argv[1]);s=json.loads(p.read_text());s["files"][sys.argv[2]]["retiringPath"]=sys.argv[3];p.write_text(json.dumps(s))', catalog, old, path.join(f.directory, '.retiring-' + 'a'.repeat(32))]);
    const preview = f.request({ action: 'preview' });expect(preview.candidates.map((row: any) => row.path), JSON.stringify(preview)).toEqual([old]);
    expect(f.request({ action: 'reconcile' }).removed).toEqual([old]);expect(fs.existsSync(old)).toBe(false);
  });
  it('retires historical/manual/renamed-resource backups after 15 days, including the final retired recovery point', () => {
    const f = fixture();const expired = f.backup('incident-with-an-old-name.gz', 16);const fresh = f.backup('current-manual-copy.gz', 2);
    const plan = f.request({ action: 'preview' });expect(plan.candidates.map((r: any) => r.path)).toEqual([expired]);expect(fs.existsSync(expired)).toBe(true);
    const result = f.request({ action: 'reconcile' });expect(result.removed).toEqual([expired]);expect(result.failed).toEqual([]);expect(fs.existsSync(fresh)).toBe(true);
    expect(result.filesystems[0].netAvailableBytesDelta).toEqual(expect.any(Number));
    expect(f.request({ action: 'reconcile' }).removed).toEqual([]);
  });
  it('reports an active-service policy conflict, then validates a fresh replacement before retiring the expired copy', () => {
    const f = fixture();const old = f.backup('only-recovery.gz', 18, 'active-db');const activeServices = [{ projectId: 'owned-project', serviceId: 'active-db' }];
    const blocked = f.request({ action: 'reconcile', activeServices });expect(blocked.policyConflicts).toHaveLength(1);expect(blocked.scanStatus).toBe('partial');expect(fs.existsSync(old)).toBe(true);
    f.backup('fresh-recovery.gz', 0, 'active-db');const result = f.request({ action: 'reconcile', activeServices });expect(result.removed).toEqual([old]);
  });
  it('protects restore leases and actually opened files across worker restarts', () => {
    const f = fixture();const old = f.backup('leased.gz', 20);const lease = { projectId: 'owned-project', serviceId: 'retired-db', token: 'owned-token', kind: 'restore' };
    f.request({ action: 'lease', ...lease });expect(f.request({ action: 'reconcile' }).held[0].reason).toBe('active-backup-or-restore-lease');
    f.request({ action: 'release', ...lease });const fd = fs.openSync(old, 'r');
    try { const result = f.request({ action: 'reconcile' });expect(result.removed).toEqual([]);expect(result.held.some((r: any) => r.reason === 'file-still-open')).toBe(true); }
    finally { fs.closeSync(fd); }
    expect(f.request({ action: 'reconcile' }).removed).toEqual([old]);
  });
  it('keeps unknown files, incomplete outputs, symlinks, replacement inodes and foreign-instance receipts', () => {
    const f = fixture();const replaced = f.backup('replaced.gz', 20);fs.unlinkSync(replaced);fs.writeFileSync(replaced, 'new unrelated bytes');
    const symlink = f.backup('alias.gz', 20);fs.unlinkSync(symlink);fs.symlinkSync(replaced, symlink);
    const foreign = f.backup('foreign.gz', 20);const catalog = path.join(f.directory, '.cds-retention/backups.json');const state = JSON.parse(fs.readFileSync(catalog, 'utf8'));state.files[foreign].instanceId = 'other-instance';fs.writeFileSync(catalog, JSON.stringify(state));
    fs.writeFileSync(path.join(f.directory, 'unknown.gz'), gzipSync('owned unknown file'));fs.mkdirSync(path.join(f.directory, '.tmp'));fs.writeFileSync(path.join(f.directory, '.tmp/partial.gz'), 'incomplete');
    const result = f.request({ action: 'reconcile' });expect(result.scanStatus).toBe('partial');expect(result.removed).toEqual([]);expect(result.unknown).toHaveLength(3);expect(fs.readFileSync(replaced, 'utf8')).toBe('new unrelated bytes');expect(fs.existsSync(foreign)).toBe(true);
  });
  it('does not let failed or corrupted replacement backups displace the only verified recovery point', () => {
    const f = fixture();const old = f.backup('old.gz', 20, 'active-db');const fresh = f.backup('fresh.gz', 1, 'active-db');const original = fs.statSync(fresh);const bytes = fs.readFileSync(fresh);bytes[bytes.length - 1] ^= 1;fs.writeFileSync(fresh, bytes);fs.utimesSync(fresh, original.atime, original.mtime);
    const result = f.request({ action: 'reconcile', activeServices: [{ projectId: 'owned-project', serviceId: 'active-db' }] });expect(result.removed).toEqual([]);expect(result.policyConflicts).toHaveLength(1);expect(fs.existsSync(old)).toBe(true);
  });
  it('keeps the final business recovery point when its service is missing from the current ledger', () => {
    const f = fixture();const old = f.backup('retired-business.gz', 20, 'active-db');
    const result = f.request({ action: 'reconcile', activeServices: [] });
    expect(result.removed).toEqual([]);expect(result.policyConflicts).toHaveLength(1);expect(fs.existsSync(old)).toBe(true);
  });
  it('does not accept a manual copy or a different physical source as a replacement', () => {
    const f = fixture();const old = f.backup('old-business.gz', 20, 'active-db');
    const manual = f.backup('manual.gz', 1, 'active-db');
    f.request({ action: 'register', path: manual, projectId: 'owned-project', serviceId: 'active-db', origin: 'manual', sourceComplete: true, sourceFingerprint: 'a'.repeat(64), attestedBy: 'unit-fixture-owner', lineageAttestation: 'fixture creator confirms exact original source; still not a valid replacement' });
    expect(f.request({ action: 'reconcile' }).removed).toEqual([]);
    const other = f.backup('different-source.gz', 1, 'active-db');
    f.request({ action: 'register', path: other, projectId: 'owned-project', serviceId: 'active-db', origin: 'automatic', sourceComplete: true, sourceFingerprint: 'b'.repeat(64) });
    expect(f.request({ action: 'reconcile' }).removed).toEqual([]);expect(fs.existsSync(old)).toBe(true);
    f.backup('matching-source.gz', 0, 'active-db');
    expect(f.request({ action: 'reconcile' }).removed).toEqual([old]);
  });
  it('retains an unconfirmed original source even when a fresh archive has the same claimed fingerprint', () => {
    const f=fixture();const old=f.backup('unconfirmed-original.gz',20,'active-db');
    f.request({action:'register',path:old,projectId:'owned-project',serviceId:'active-db',origin:'automatic',sourceFingerprint:'a'.repeat(64),sourceComplete:false});
    f.backup('fresh-complete.gz',0,'active-db');const result=f.request({action:'reconcile'});
    expect(result.removed).toEqual([]);expect(result.held.some((row:any)=>row.path===old&&row.reason==='backup-replacement-proof-unconfirmed')).toBe(true);expect(fs.existsSync(old)).toBe(true);
  });
});
