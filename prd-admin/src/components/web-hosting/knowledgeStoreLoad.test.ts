import { describe, expect, it } from 'vitest';
import { collectStorePages, describeStoreLoad } from './KnowledgeInlineBrowser';
import type { DocumentStoreWithPreview } from '@/services/contracts/documentStore';

const store = (id: string) => ({ id, name: id } as unknown as DocumentStoreWithPreview);

describe('选知识：知识库列表翻页取全（Codex P2）', () => {
  it('超过一页时继续取，直到拿满 total', async () => {
    const pages: Record<number, DocumentStoreWithPreview[]> = {
      1: [store('a'), store('b')],
      2: [store('c')],
    };
    const requested: number[] = [];
    const result = await collectStorePages(async (page) => {
      requested.push(page);
      return { success: true, data: { items: pages[page] ?? [], total: 3 } };
    });
    expect(requested).toEqual([1, 2]);
    expect(result).toEqual({ ok: true, items: [store('a'), store('b'), store('c')], truncated: false });
  });

  it('第一页就失败算失败；后面页失败保留已取到的并标不完整', async () => {
    expect(await collectStorePages(async () => ({ success: false, error: { message: '无权限' } })))
      .toEqual({ ok: false, message: '无权限' });
    const partial = await collectStorePages(async (page) => page === 1
      ? { success: true, data: { items: [store('a')], total: 5 } }
      : { success: false, error: null });
    expect(partial).toEqual({ ok: true, items: [store('a')], truncated: true });
  });

  it('到页数上限还没取完，如实标成不完整', async () => {
    const result = await collectStorePages(async () => ({ success: true, data: { items: [store('x')], total: 99 } }), 2);
    expect(result).toMatchObject({ ok: true, truncated: true });
  });
});

describe('选知识：一半范围读失败要说出来（Codex P2）', () => {
  const ok = { ok: true as const, items: [store('a')], truncated: false };
  it('只有团队那一半失败：不算错误，但给出不完整提示', () => {
    expect(describeStoreLoad(ok, { ok: false, message: 'x' }))
      .toEqual({ error: null, warning: '团队共享的知识库这次没读出来，下面的列表不完整' });
  });
  it('两边都失败才算错误；都成功时无提示', () => {
    expect(describeStoreLoad({ ok: false, message: '断网' }, { ok: false, message: 'y' }).error).toBe('断网');
    expect(describeStoreLoad(ok, ok)).toEqual({ error: null, warning: null });
  });
});
