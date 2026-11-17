import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMongoR2RecoveryDrill, type RecoveryDrillCommandRunner } from '../../src/services/infra-r2-recovery-drill.js';
const config = { endpoint: 'https://storage.invalid', bucket: 'backup', prefix: 'cds', accessKeyId: 'fake-id', secretAccessKey: 'fake-key' };
const imageId = `sha256:${'a'.repeat(64)}`, id = 'b'.repeat(64), roots = new Set<string>();
afterEach(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); roots.clear(); });
type State = { name: string; label: string; root: string; present: boolean };
function fixture(change?: (args: string[], state: State) => void | { exitCode: number; stdout: string; stderr: string }) {
  const calls: string[][] = [], state: State = { name: '', label: '', root: '', present: false }, body = Buffer.from('synthetic-archive');
  const fetchImpl: typeof fetch = async (_url, init) => init?.method === 'HEAD'
    ? new Response(null, { headers: { 'content-length': String(body.length), 'x-amz-meta-sha256': crypto.createHash('sha256').update(body).digest('hex') } }) : new Response(body);
  const runner: RecoveryDrillCommandRunner = async (_command, args) => {
    const a = [...args]; calls.push(a);
    if (a[0] === 'create') {
      state.name = a[a.indexOf('--name') + 1]; state.label = a[a.indexOf('--label') + 1].split('=')[1];
      state.root = path.dirname(a[a.indexOf('--mount') + 1].match(/src=([^,]+)/)![1]); roots.add(state.root); state.present = true;
    }
    const override = change?.(a, state); if (override) return override;
    if (a[0] === 'image') return { exitCode: 0, stdout: imageId, stderr: '' };
    if (a[0] === 'container') return { exitCode: 0, stdout: JSON.stringify({ Id: id, Name: `/${state.name}`, Image: imageId, Config: { Labels: { 'org.cds.recovery-drill': state.label } } }), stderr: '' };
    if (a[0] === 'ps') return { exitCode: 0, stdout: state.present ? (a.includes('--format') ? JSON.stringify({ ID: id, Names: state.name }) : id) : '', stderr: '' };
    if (a[0] === 'rm') state.present = false;
    if (a.some((x) => x.includes('listDatabases:1,nameOnly:true'))) return { exitCode: 0, stdout: '{"databaseCount":2,"collectionCount":7,"nonEmptyCollectionCount":5,"validatedCollectionCount":7}', stderr: '' };
    return { exitCode: 0, stdout: a[0] === 'create' ? id : '', stderr: '' };
  };
  const run = () => runMongoR2RecoveryDrill({ config, objectKey: 'cds/synthetic.gz', mongoImage: 'mongo:8', fetchImpl, commandRunner: runner,
    maxArchiveBytes: 1024, dataBytes: 64 * 1024 ** 2, memoryBytes: 256 * 1024 ** 2, readinessAttempts: 1, readinessDelayMs: 0 });
  return { run, calls, state };
}
const fail = { exitCode: 2, stdout: '', stderr: 'PRIVATE-DOCUMENT-SECRET' };
describe('R2 Mongo 隔离恢复与清场', () => {
  it('未指定源库同版本镜像时不使用默认版本恢复', async () => {
    await expect(runMongoR2RecoveryDrill({ config, objectKey: 'synthetic' })).rejects.toThrow('必须显式指定');
  });
  it('读取后按不可变身份清场，数据库只在有预算的tmpfs中', async () => {
    const f = fixture(); expect(await f.run()).toMatchObject({ databaseCount: 2, collectionCount: 7, nonEmptyCollectionCount: 5 });
    const create = f.calls.find((x) => x[0] === 'create')!;
    expect(create).toEqual(expect.arrayContaining(['--network', 'none', '--pull', 'never', '--cpus', '2', '--memory', String(256 * 1024 ** 2), '--memory-swap', String(256 * 1024 ** 2)]));
    expect(create.filter((x) => x.startsWith('type=bind'))).toHaveLength(1);
    expect(create).toContain(`/data/db:rw,nosuid,nodev,size=${64 * 1024 ** 2}`);
    expect(create).toContain('ttlMonitorEnabled=false'); expect(create).not.toContain('-p');
    expect(create).toEqual(expect.arrayContaining(['--log-driver', 'json-file', '--log-opt', 'max-size=50m', 'max-file=3', imageId]));
    expect(f.calls.find((x) => x[0] === 'rm')).toEqual(['rm', '-f', '-v', id]);
    expect(f.calls.filter((x) => ['start', 'exec'].includes(x[0])).every((x) => x[1] === id)).toBe(true);
    expect(fs.existsSync(f.state.root)).toBe(false);
  });
  it('恢复失败不展示原始数据且清场仍确认', async () => {
    const f = fixture((a) => a.includes('mongorestore') ? fail : undefined);
    await expect(f.run()).rejects.toThrow('恢复离机备份失败（exit=2）'); expect(f.state.present).toBe(false); expect(fs.existsSync(f.state.root)).toBe(false);
  });
  it('创建失败但产生的本任务容器也被核对回收', async () => {
    const f = fixture((a) => a[0] === 'create' ? fail : undefined);
    await expect(f.run()).rejects.toThrow('创建隔离恢复容器失败'); expect(f.calls.some((x) => x[0] === 'rm' && x[3] === id)).toBe(true); expect(f.state.present).toBe(false);
  });
  it.each(['remove', 'inventory', 'inspect', 'labels'] as const)('清场%s失败保留归档，不签发成功', async (kind) => {
    let inspecting = 0;
    const f = fixture((a, s) => {
      if (kind === 'remove' && a[0] === 'rm' || kind === 'inventory' && a[0] === 'ps') return fail;
      if (a[0] === 'container' && ++inspecting > 1) {
        if (kind === 'inspect') return fail;
        if (kind === 'labels') return { exitCode: 0, stderr: '', stdout: JSON.stringify({ Id: id, Name: `/${s.name}`, Image: imageId, Config: { Labels: { 'org.cds.recovery-drill': 'someone-else' } } }) };
      }
    });
    await expect(f.run()).rejects.toThrow('清场未确认'); expect(fs.existsSync(path.join(f.state.root, 'backup.archive.gz'))).toBe(true);
    if (kind === 'inspect' || kind === 'labels') expect(f.calls.some((a) => a[0] === 'rm')).toBe(false);
  });
  it.each(['symlink', 'replacement', 'unknown-file', 'archive-replacement'] as const)('出现%s时不递归删除未知内容', async (kind) => {
    const f = fixture((a, s) => {
      if (!a.includes('mongorestore')) return;
      if (kind === 'unknown-file') fs.writeFileSync(path.join(s.root, 'business.data'), 'keep');
      if (kind === 'archive-replacement') { fs.renameSync(path.join(s.root, 'backup.archive.gz'), path.join(s.root, 'backup.original')); fs.writeFileSync(path.join(s.root, 'backup.archive.gz'), 'keep'); }
      if (kind === 'symlink' || kind === 'replacement') {
        const original = `${s.root}.original`; fs.renameSync(s.root, original); roots.add(original);
        const other = `${s.root}.other`; fs.mkdirSync(other); roots.add(other); fs.writeFileSync(path.join(other, 'business.data'), 'keep');
        if (kind === 'symlink') fs.symlinkSync(other, s.root); else fs.renameSync(other, s.root);
      }
    });
    await expect(f.run()).rejects.toThrow('清场未确认'); expect(fs.existsSync(f.state.root)).toBe(true); expect(f.state.present).toBe(false);
    if (kind !== 'archive-replacement') expect(fs.readFileSync(path.join(f.state.root, 'business.data'), 'utf8')).toBe('keep');
  });
  it('本地镜像未知时不下载、不创建、不隐式拉取', async () => {
    const f = fixture((a) => a[0] === 'image' ? fail : undefined);
    await expect(f.run()).rejects.toThrow('禁止自动拉取'); expect(f.calls).toHaveLength(1);
  });
});
