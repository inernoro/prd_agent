import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamMdToPptConvert, streamMdToPptOutline } from '@/services/real/mdToPptService';

vi.mock('@/stores/authStore', () => ({
  useAuthStore: { getState: () => ({ token: 'source-plan-test-token' }) },
}));

function events(items: Array<[string, Record<string, unknown>]>): Response {
  return new Response(items.map(([event, data]) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('PPT 来源绑定传输', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('真实 SSE 解析保留每页来源绑定，不把引用 ID 改成页码', async () => {
    const page = vi.fn();
    const done = vi.fn();
    const input = { index: 2, title: '开放安排', bullets: ['周一闭馆'], sourceBlockIds: ['source-monday', 'source-weekend'] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(events([
      ['page', input], ['done', { pages: 1 }],
    ])));
    streamMdToPptOutline({ content: '社区指南', onPage: page, onDone: done });
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(page).toHaveBeenCalledWith(expect.objectContaining(input));
  });

  it.each([null, 'source-monday', ['source-monday', 42]])('拒绝损坏的来源字段 %j，不继续报大纲完成', async (sourceBlockIds) => {
    const page = vi.fn();
    const done = vi.fn();
    const error = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(events([
      ['page', { index: 1, title: '开放安排', bullets: [], sourceBlockIds }],
      ['done', { pages: 1 }],
    ])));
    streamMdToPptOutline({ content: '社区指南', onPage: page, onDone: done, onError: error });
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(error).toHaveBeenCalledWith('大纲来源信息不完整，请重新生成大纲。');
    expect(page).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });

  it('无来源的旧格式仍正常接收', async () => {
    const page = vi.fn();
    const done = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(events([
      ['page', { index: 1, title: '旧大纲', bullets: ['原内容'] }], ['done', { pages: 1 }],
    ])));
    streamMdToPptOutline({ content: '旧内容', onPage: page, onDone: done });
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(page.mock.calls[0][0].sourceBlockIds).toBeUndefined();
  });

  it('大纲开始前来源校验失败时显示恢复动作，不显示状态码', async () => {
    const error = vi.fn();
    const done = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: '知识正文为空，不能保证内容完整，请刷新知识来源后重新生成大纲',
      code: 'source_plan_empty',
    }), { status: 422, headers: { 'content-type': 'application/json' } })));
    streamMdToPptOutline({ content: '社区指南', onError: error, onDone: done });
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(error).toHaveBeenCalledWith('知识正文为空，不能保证内容完整，请刷新知识来源后重新生成大纲');
    expect(done).not.toHaveBeenCalled();
  });

  it('确认与生成发送相同的调整后来源绑定，由服务端校验授权与覆盖', async () => {
    const done = vi.fn();
    const outlinePages = [
      { title: '移至首页的安排', bullets: ['周一闭馆'], sourceBlockIds: ['source-monday'] },
      { title: '社区介绍', bullets: ['免费'], sourceBlockIds: ['source-intro', 'source-free'] },
    ];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(events([['done', { html: '<html></html>' }]]));
    vi.stubGlobal('fetch', fetchMock);
    streamMdToPptConvert({ content: '社区指南', parentOutlineRunId: 'outline-1', outlinePages, onDone: done });
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, request] of fetchMock.mock.calls) {
      expect(JSON.parse(request.body).outlinePages).toEqual(outlinePages);
    }
  });

  it('服务端拒绝缺失覆盖时不继续生成、不把未知引用当成本地授权', async () => {
    const error = vi.fn();
    const done = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: '大纲未覆盖全部来源，请调整大纲后重新确认。', code: 'ppt_source_coverage_missing',
    }), { status: 400, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    streamMdToPptConvert({
      content: '社区指南', parentOutlineRunId: 'outline-1',
      outlinePages: [{ title: '内容', bullets: [], sourceBlockIds: ['unknown-source'] }],
      onError: error, onDone: done,
    });
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('大纲未覆盖全部来源，请调整大纲后重新确认。');
    expect(done).not.toHaveBeenCalled();
  });

  it('页面接线保留 SSE 来源字段，编辑与恢复不重建三字段副本', () => {
    // 接线守卫；实际拖动、刷新和确认行为另由组件浏览器用例取证。
    const source = readFileSync(new URL('../MdToPptAgentPage.tsx', import.meta.url), 'utf8');
    const onPage = source.slice(source.indexOf('onPage: (pg) => {'), source.indexOf('onDone: () => {', source.indexOf('onPage: (pg) => {')));
    expect(onPage).toContain('sourceBlockIds: pg.sourceBlockIds');
    expect(source).toContain('const [moved] = outline.splice(from, 1)');
    expect(source).toContain('outline.splice(i, 0, moved)');
    expect(source).toContain('{ ...sl, title: e.target.value }');
    expect(source).toContain('const outline = (d.outline ?? []).filter(Boolean)');
    expect(source).toContain('JSON.stringify(toSave)');
  });
});
