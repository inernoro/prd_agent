import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { OWNED_RESOURCE_PROGRAM } from '../../src/services/owned-resource-program.js';
import { IMAGE_CACHE_PROGRAM } from '../../src/services/image-cache-program.js';
const roots: string[] = [];
function root() { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-preview-unknown-'));roots.push(p);return p; }
afterEach(() => { for (const p of roots.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
function run(program: string, input: Record<string, unknown>, bin?: string) {
  return spawnSync('python3', ['-c', program], { input: JSON.stringify(input), encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, ...(bin ? { PATH: bin + path.delimiter + process.env.PATH } : {}) } });
}
const owned = (p: string) => ({ action: 'preview', instanceId: 'isolated-test', workspaceBase: path.join(p, 'missing', 'workspaces'), catalog: path.join(p, 'missing', 'catalog') });
function docker(p: string, slow = false) {
  fs.writeFileSync(path.join(p, 'docker'), `#!/usr/bin/env python3
import sys,json,time
with open(${JSON.stringify(path.join(p, 'calls.jsonl'))},'a') as f:f.write(json.dumps(sys.argv[1:])+chr(10))
if ${slow ? 'True' : 'False'} and sys.argv[1]=='info':print(json.dumps({'ID':'isolated-daemon','DockerRootDir':${JSON.stringify(p)},'OSType':'linux','Architecture':'x86_64'}));sys.exit(0)
if ${slow ? 'True' : 'False'}:time.sleep(9)
sys.exit(2)
`, { mode: 0o700 });
}
describe('native read-only catalog preview unknown states', () => {
  it('reports a missing resource root as unknown without creating the catalog or workspace', () => {
    const p = root(), r = run(OWNED_RESOURCE_PROGRAM, owned(p));
    expect(r.status).toBe(0);expect(JSON.parse(r.stdout)).toMatchObject({ scanStatus: 'partial', catalogError: 'catalog-uninitialized', usageBytes: null, canExecute: false, counts: { unknown: null, pending: null } });
    expect(fs.readdirSync(p)).toEqual([]);
  });
  it('does not create a missing read-only lock or interpret it as an empty inventory', () => {
    const p = root(), input = owned(p);fs.mkdirSync(input.workspaceBase, { recursive: true, mode: 0o700 });fs.mkdirSync(input.catalog, { mode: 0o700 });
    const r = run(OWNED_RESOURCE_PROGRAM, input);expect(r.status).toBe(0);expect(JSON.parse(r.stdout).usageBytes).toBeNull();
    expect(JSON.parse(r.stdout).catalogError).toBe('catalog-uninitialized');expect(fs.readdirSync(input.catalog)).toEqual([]);
  });
  it('preserves directory alias protection instead of accepting an unsafe catalog', () => {
    const p = root(), input = owned(p);fs.mkdirSync(path.join(p, 'actual'), { mode: 0o700 });fs.symlinkSync(path.join(p, 'actual'), path.join(p, 'alias'));
    const r = run(OWNED_RESOURCE_PROGRAM, { ...input, workspaceBase: path.join(p, 'alias') });
    expect(r.status).not.toBe(0);expect(r.stderr).toContain('directory-alias-or-relative');expect(fs.readdirSync(path.join(p, 'actual'))).toEqual([]);
  });
  it('keeps failed Docker preview bytes and object counts unknown, with no native write', () => {
    const p = root();docker(p);const catalog = path.join(p, 'catalog');
    const r = run(IMAGE_CACHE_PROGRAM, { action: 'preview', catalog, instanceId: 'isolated-test', budgetBytes: 1 }, p);
    expect(r.status).toBe(0);expect(JSON.parse(r.stdout)).toMatchObject({ scanStatus: 'partial', catalogError: 'docker-query-or-operation-unconfirmed', imageBytesEstimate: null, protectedBytesEstimate: null, canExecute: false, counts: { candidates: null, held: null, unknown: null, pending: null } });
    expect(fs.existsSync(catalog)).toBe(false);expect(fs.readFileSync(path.join(p, 'calls.jsonl'), 'utf8').trim()).toBe('["info", "--format", "{{json .}}"]');
    const write = run(IMAGE_CACHE_PROGRAM, { action: 'publish', catalog, instanceId: 'isolated-test', budgetBytes: 1, references: [] }, p);
    expect(write.status).not.toBe(0);expect(write.stderr).toContain('docker-query-or-operation-unconfirmed');expect(fs.existsSync(path.join(catalog, 'images.json'))).toBe(false);
  });
  it('returns unknown at the unchanged real eight-second Docker query deadline', () => {
    const p = root();docker(p, true);const started = performance.now();
    const r = run(IMAGE_CACHE_PROGRAM, { action: 'preview', catalog: path.join(p, 'catalog'), instanceId: 'isolated-test', budgetBytes: 1 }, p);
    const elapsed = performance.now() - started;expect(r.status).toBe(0);expect(JSON.parse(r.stdout)).toMatchObject({ scanStatus: 'partial', catalogError: 'docker-query-timeout', imageBytesEstimate: null, canExecute: false });
    expect(elapsed).toBeGreaterThanOrEqual(7_500);expect(elapsed).toBeLessThan(12_000);expect(fs.existsSync(path.join(p, 'catalog'))).toBe(false);
    const calls = fs.readFileSync(path.join(p, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));expect(calls).toEqual([['info', '--format', '{{json .}}'], ['image', 'ls', '-aq', '--no-trunc']]);
  }, 15_000);
});
