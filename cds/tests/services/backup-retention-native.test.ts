import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKUP_RETENTION_PROGRAM } from '../../src/services/backup-retention-program.js';

const roots: string[] = [];
const DAY = 86_400_000;
const now = Date.now();
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-backup-retention-')); roots.push(directory);
  // Native files + this fixture's real writer descriptors. The full /proc guard is
  // separately exercised in a private Docker PID namespace, including query failure.
  const proc = path.join(directory, '.fixture-proc');fs.mkdirSync(path.join(proc, String(process.pid)), { recursive: true });
  fs.symlinkSync(`/proc/${process.pid}/fd`, path.join(proc, String(process.pid), 'fd'));
  const program = BACKUP_RETENTION_PROGRAM.replace('def backup_mount_references():\n','def backup_mount_references():\n return [] # Unit descriptor fixture; Docker mounts are exercised in the real VM.\n').replace("pathlib.Path('/proc')", `pathlib.Path(${JSON.stringify(proc)})`);
  const request = (input: Record<string, unknown>) => JSON.parse(execFileSync('python3', ['-c', program], {
    input: JSON.stringify({ catalog: path.join(directory, '.cds-retention'), directories: [directory], instanceId: 'owned-instance', nowMs: now, ...input }), encoding: 'utf8', timeout: 30_000,
  }));
  const backup = (name: string, age: number, serviceId = 'retired-db') => {
    const file = path.join(directory, name);fs.writeFileSync(file, gzipSync(Buffer.alloc(1024 * 1024, name)));
    fs.utimesSync(file, new Date(now - age * DAY), new Date(now - age * DAY));
    request({ action: 'register', path: file, projectId: 'owned-project', serviceId, origin: serviceId === 'active-db' ? 'automatic' : 'historical', sourceComplete: serviceId === 'active-db', sourceFingerprint: 'a'.repeat(64), disposition: serviceId === 'active-db' ? 'business-backup' : 'reproducible-artifact', attestedBy: 'unit-fixture-owner', dispositionReason: 'synthetic data in a private unit fixture' });return file;
  };
  return { directory, request, backup };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
describe('independent native backup retention', () => {
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
