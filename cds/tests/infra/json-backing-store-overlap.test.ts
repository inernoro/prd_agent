import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStateBackingStore, flushAllJsonStateStores, type JsonStateWriteEvent } from '../../src/infra/state-store/json-backing-store.js';
import type { CdsState } from '../../src/types.js';
const dirs: string[] = [];
const state = (marker: string): CdsState => ({ routingRules: [], buildProfiles: [], branches: {}, nextPortIndex: 0, logs: {}, defaultBranch: null, customEnv: { fixture: { marker } }, infraServices: [], previewMode: 'multi' });
function fixture() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-json-overlap-')); dirs.push(dir); return { dir, file: path.join(dir, 'state.json') }; }
function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function primary(file: unknown) { return String(file).includes('.tmp.') && !String(file).includes('.bak.'); }
afterEach(async () => { await flushAllJsonStateStores(); vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
describe('同文件重叠写的实际文件句柄、确认与归属', () => {
  it('冷恢复不把尚未提交的备份临时文件当作已确认快照', () => {
    const f = fixture(); fs.writeFileSync(f.file, 'broken-primary');
    fs.writeFileSync(f.file + '.bak.2026-10-10', JSON.stringify(state('confirmed')));
    fs.writeFileSync(f.file + '.bak.2026-10-11.tmp.foreign-owner', JSON.stringify(state('uncommitted')));
    expect(new JsonStateBackingStore(f.file).load()?.customEnv.fixture.marker).toBe('confirmed');
    expect(fs.existsSync(f.file + '.bak.2026-10-11.tmp.foreign-owner')).toBe(true);
  });
  it('同PID同毫秒的规范化同目标只有一个在途写，不同长度快照确认后均可解析', async () => {
    const f = fixture(), entered = barrier(), release = barrier(); const paths: string[] = []; const events: JsonStateWriteEvent[] = [];
    vi.spyOn(Date, 'now').mockReturnValue(1_791_689_000_000);
    const open = fs.promises.open.bind(fs.promises); let blocked = false;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await open(...args);
      if (!primary(args[0])) return handle;
      paths.push(String(args[0]));
      return new Proxy(handle, { get(target, key) {
        if (key === 'writeFile' && !blocked) { blocked = true; return async (...writeArgs: any[]) => { entered.release(); await release.promise; return (target.writeFile as any)(...writeArgs); }; }
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
    });
    const a = new JsonStateBackingStore(f.file, { onWrite: event => events.push(event) });
    const b = new JsonStateBackingStore(f.dir + '/unused/../state.json', { onWrite: event => events.push(event) });
    a.save(state('long:' + 'x'.repeat(8192))); const first = a.flush(); await entered.promise;
    b.save(state('short')); const second = b.flush(); void second.catch(() => {});
    try {
      await new Promise(resolve => setImmediate(resolve)); expect(paths).toHaveLength(1);
      release.release(); await first; expect(() => JSON.parse(fs.readFileSync(f.file, 'utf8'))).not.toThrow();
      await second; expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).customEnv.fixture.marker).toBe('short');
      expect(new Set(paths.map(p => path.basename(p))).size).toBe(2);
      expect(events.filter(e => e.purpose === 'primary' && e.phase === 'committed')).toHaveLength(2);
      expect(fs.readdirSync(f.dir).some(name => name.includes('.tmp.'))).toBe(false);
    } finally { release.release(); await Promise.allSettled([first, second]); }
  });
  it('同物理目录的两个别名可并行打开，但绝不共用临时inode；短写不能污染已经发布的长快照', async () => {
    const f = fixture(); fs.symlinkSync(f.dir, path.join(f.dir, 'alias')); vi.spyOn(Date, 'now').mockReturnValue(1_791_689_000_000);
    const aEntered = barrier(), bEntered = barrier(), aRelease = barrier(), bRelease = barrier();
    const opens: Array<{ path: string; ino: number; flags: unknown }> = []; const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await open(...args); if (!primary(args[0])) return handle;
      const i = opens.length; const stat = await handle.stat(); opens.push({ path: String(args[0]), ino: stat.ino, flags: args[1] });
      return new Proxy(handle, { get(target, key) {
        if (key === 'writeFile') return async (...writeArgs: any[]) => { (i === 0 ? aEntered : bEntered).release(); await (i === 0 ? aRelease : bRelease).promise; return (target.writeFile as any)(...writeArgs); };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
    });
    const a = new JsonStateBackingStore(f.file), b = new JsonStateBackingStore(path.join(f.dir, 'alias', 'state.json'));
    a.save(state('long:' + 'x'.repeat(8192))); const first = a.flush(); await aEntered.promise;
    b.save(state('short')); const second = b.flush(); await bEntered.promise;
    try {
      aRelease.release(); await first; expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).customEnv.fixture.marker).toHaveLength(8197);
      bRelease.release(); const outcome = await second.then(() => undefined, error => error);
      const published = fs.readFileSync(f.file, 'utf8');
      expect(() => JSON.parse(published)).not.toThrow(); expect(outcome).toBeUndefined();
      expect(JSON.parse(published).customEnv.fixture.marker).toBe('short');
      expect(opens[0].ino).not.toBe(opens[1].ino); expect(opens.every(item => item.flags === 'wx')).toBe(true);
      expect(new Set(opens.map(item => path.basename(item.path))).size).toBe(2);
    } finally { aRelease.release(); bRelease.release(); await Promise.allSettled([first, second]); }
  });
  it('写入失败不确认成功、不改变原目标，归还写入链后其他实例能提交并冷加载', async () => {
    const f = fixture(); fs.writeFileSync(f.file, JSON.stringify(state('old'))); const events: JsonStateWriteEvent[] = [];
    const open = fs.promises.open.bind(fs.promises); let failed = false;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await open(...args); if (!primary(args[0]) || failed) return handle; failed = true;
      return new Proxy(handle, { get(target, key) {
        if (key === 'writeFile') return async () => { throw Object.assign(new Error('owned write unavailable'), { code: 'EIO' }); };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
    });
    const a = new JsonStateBackingStore(f.file, { onWrite: e => events.push(e) }), b = new JsonStateBackingStore(f.file);
    a.save(state('failed')); await expect(a.flush()).rejects.toMatchObject({ code: 'EIO' });
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).customEnv.fixture.marker).toBe('old');
    expect(events.some(e => e.phase === 'committed')).toBe(false); expect(events.some(e => e.phase === 'failed' && e.errorCode === 'EIO')).toBe(true);
    expect(fs.readdirSync(f.dir).some(name => name.includes('.tmp.'))).toBe(false);
    b.save(state('new')); await b.flush(); expect(new JsonStateBackingStore(f.file).load()?.customEnv.fixture.marker).toBe('new');
  });
  it('临时路径被其他拥有者占用时明确EEXIST且不截断或删除其文件', async () => {
    const f = fixture(); fs.writeFileSync(f.file, JSON.stringify(state('old'))); let foreign: string | undefined;
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      if (primary(args[0]) && !foreign) { foreign = String(args[0]); fs.writeFileSync(foreign, 'foreign-owned-marker'); }
      return open(...args);
    });
    const store = new JsonStateBackingStore(f.file); store.save(state('must-not-publish'));
    await expect(store.flush()).rejects.toMatchObject({ code: 'EEXIST' });
    expect(fs.readFileSync(foreign!, 'utf8')).toBe('foreign-owned-marker'); expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).customEnv.fixture.marker).toBe('old');
    store.save(state('retry')); await store.flush(); expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).customEnv.fixture.marker).toBe('retry');
    expect(fs.readFileSync(foreign!, 'utf8')).toBe('foreign-owned-marker');
  });
  it('不同目标不共用全局执行串行槽，观察者异常不改变确认结果', async () => {
    const f = fixture(), entered = barrier(), release = barrier(); const open = fs.promises.open.bind(fs.promises); let blocked = false;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await open(...args); if (!primary(args[0]) || blocked) return handle; blocked = true;
      return new Proxy(handle, { get(target, key) {
        if (key === 'writeFile') return async (...writeArgs: any[]) => { entered.release(); await release.promise; return (target.writeFile as any)(...writeArgs); };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
    });
    const a = new JsonStateBackingStore(f.file), other = new JsonStateBackingStore(path.join(f.dir, 'other.json'), { onWrite: () => { throw new Error('observer-only-failure'); } });
    a.save(state('held')); const pending = a.flush(); await entered.promise;
    try { other.save(state('independent')); await other.flush(); expect(other.load()?.customEnv.fixture.marker).toBe('independent'); }
    finally { release.release(); await pending; }
  });
});
