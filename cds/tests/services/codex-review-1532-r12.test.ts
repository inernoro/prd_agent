/**
 * Codex review（PR #1532）第十二轮：读缓存回填要原子写。
 *
 * 回填是本 PR 加的（本地盘降为读缓存、未命中回源并回填）。直接 writeFile 会先截断目标，
 * 写到一半失败就留下半份文件——**本次**请求返回的是对象存储取回的正确正文，
 * 下一次请求却会本地优先命中那半份，从此一直端出残缺正文，而且不报错。
 *
 * 写入路径上轮已经改成「临时文件 + 原子改名」，回填这一半漏了——
 * 又是「同一条判断只修了一面」。
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

describe('读缓存回填：宁可没有缓存，也不留半份', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await flushAllJsonStateStores();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function fresh(): { svc: StateService; base: string; store: Map<string, string> } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-refill-'));
    dirs.push(dir);
    const svc = new StateService(path.join(dir, 'state.json'));
    const store = new Map<string, string>();
    (svc as unknown as { reportObjects: unknown }).reportObjects = {
      isConfigured: () => true,
      put: async (m: { id: string; format: string }, c: string) => {
        if (!c) return null;
        const key = `k/${m.id}.${m.format}`;
        store.set(key, c);
        return key;
      },
      get: async (key: string) => store.get(key) ?? null,
      remove: async () => undefined,
    };
    return { svc, base: svc.getReportsBase(), store };
  }

  it('回填成功时缓存内容完整，且不留临时文件', async () => {
    const { svc, base } = fresh();
    const meta = await svc.createAcceptanceReportAsync({
      title: '[验收] 回填', kind: '验收', format: 'md', content: '正文正文正文',
    } as never);
    // 模拟容器重建：本地缓存没了，对象存储还在。
    fs.rmSync(base, { recursive: true, force: true });
    expect(await svc.readAcceptanceReportContentAsync(meta.id)).toBe('正文正文正文');
    // 回填过一次，再读一次仍然正确，且目录里没有 .tmp- 残留。
    expect(await svc.readAcceptanceReportContentAsync(meta.id)).toBe('正文正文正文');
    expect(fs.readdirSync(base).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('回填失败时不留半份缓存：下一次读回源，拿到的仍是完整正文', async () => {
    const { svc, base } = fresh();
    const meta = await svc.createAcceptanceReportAsync({
      title: '[验收] 回填失败', kind: '验收', format: 'md', content: '完整正文',
    } as never);
    const cachePath = (svc as unknown as { reportFilePath: (m: unknown) => string }).reportFilePath(meta);
    fs.rmSync(cachePath);
    // 让回填必然失败：把缓存路径占成一个目录，writeFile/rename 都过不去。
    fs.mkdirSync(cachePath);

    expect(await svc.readAcceptanceReportContentAsync(meta.id), '本次返回必须是对象存储那份')
      .toBe('完整正文');
    expect(fs.existsSync(cachePath), '坏掉的占位还在，下一次读会本地优先命中它').toBe(false);
    expect(fs.readdirSync(base).filter((f) => f.includes('.tmp-')), '临时文件残留').toEqual([]);
    // 再读一次仍然完整（回源），而不是端出半份。
    expect(await svc.readAcceptanceReportContentAsync(meta.id)).toBe('完整正文');
  });
});
