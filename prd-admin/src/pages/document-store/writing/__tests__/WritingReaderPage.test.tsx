// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WritingReaderPage } from '../WritingReaderPage';
import type { WritingReader } from '@/services/contracts/writing';
const api = vi.hoisted(() => ({ read: vi.fn(), content: vi.fn() }));
vi.mock('@/services/real/writing', () => ({ readWriting: api.read }));
vi.mock('@/services/real/documentStore', () => ({ getDocumentContent: api.content }));
vi.mock('../WritingThreads', () => ({ WritingThreads: () => null }));
vi.mock('../WritingWorkspacePage', () => ({ WritingThemeButton: () => <button>主题</button> }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSectionLoader: ({ text }: { text: string }) => <p>{text}</p> }));
vi.mock('@/components/file-preview/MarkdownViewer', () => ({ MarkdownViewer: ({ content }: { content: string }) => <p>{content}</p> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const condition = '仅限本部门；离岗前3个工作日移交，离岗当天回收后不能补办。';
function fixture(): WritingReader {
  return { entryId: 'entry', store: { id: 'store', name: '项目交接' } as WritingReader['store'], affectedSources: [], entries: [{ id: 'entry', title: '交接说明' }], canEdit: false,
    publication: { version: 1, title: '交接说明', summary: '', templateId: 'prd', templateVersion: '1.0', authorName: '作者', reviewerName: '审核人', publishedAt: '2026-11-13T00:00:00Z', conclusions: [], scopeIn: '本部门', scopeOut: '跨部门', sources: [], roles: [], openQuestions: [], chapters: [], captions: [], sections: [
      { id: 's1', title: '移交权限', condition, metadataConfirmed: true, detail: { label: '交接字段', rows: [['负责人', '必填', '缺失时不能提交'], ['备注', '选填', '<原样文本>']] }, paragraphs: ['列出待移交权限', '由接手人逐项确认'].map((text, i) => ({ id: 'p'+i, text, status: 'auth', citations: [], confirmed: true })) },
      { id: 's2', title: '主管签收', condition: '接手人核验完成后，主管才能签收。', paragraphs: [{ id: 'p2', text: '核对后签收', status: 'auth', citations: [], confirmed: true }] },
      { id: 's3', title: '补充说明', paragraphs: [] },
    ] } };
}
const ok = (data: WritingReader) => ({ success: true, data });
let root: Root, container: HTMLDivElement;
async function mount() {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(<MemoryRouter><WritingReaderPage storeId="store" entryId="entry" tutorial /></MemoryRouter>));
}
async function click(button: HTMLButtonElement) { await act(async () => button.click()); }
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); api.read.mockResolvedValue(ok(fixture())); });
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); });

describe('教学转换必须保留已发布的执行约束', () => {
  it('条件在当前章步骤之前完整显示一次，保留数值、否定与适用范围', async () => {
    await mount();
    const block = container.querySelector('.writing-tutorial-steps .writing-section-condition');
    expect(block?.textContent).toContain(condition);
    expect(container.querySelectorAll('.writing-tutorial-steps .writing-section-condition')).toHaveLength(1);
    expect(block!.compareDocumentPosition(container.querySelector('.writing-tutorial-step')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it('细节保留字段、必填性和完整说明，展开后仍为文本', async () => {
    await mount();
    const detail = container.querySelector<HTMLDetailsElement>('.writing-tutorial-steps details')!;
    expect(detail).toBeTruthy();
    await act(async () => detail.querySelector('summary')!.click());
    expect(detail.open).toBe(true);
    expect(detail.textContent).toContain('负责人'); expect(detail.textContent).toContain('必填'); expect(detail.textContent).toContain('缺失时不能提交');
    expect(detail.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(detail.querySelector('tbody tr:last-child td:last-child')?.textContent).toBe('<原样文本>');
    expect(detail.querySelector('原样文本')).toBeNull();
  });
  it('切章只显示对应约束，无条件的空章不沿用上一章内容', async () => {
    await mount();
    await click(container.querySelectorAll<HTMLButtonElement>('.writing-chapter-list .writing-chapter')[1]);
    expect(container.querySelector('.writing-tutorial-steps')?.textContent).toContain('接手人核验完成后，主管才能签收。');
    expect(container.querySelector('.writing-tutorial-steps')?.textContent).not.toContain(condition);
    expect(container.querySelector('.writing-tutorial-steps table')).toBeNull();
    await click(container.querySelectorAll<HTMLButtonElement>('.writing-chapter-list .writing-chapter')[2]);
    expect(container.querySelector('.writing-tutorial-steps .writing-section-condition')).toBeNull();
    expect(container.querySelector('.writing-tutorial-steps table')).toBeNull();
  });
  it('自定义章节保持自身步骤条件和独立字幕，不按章节下标猜配正文条件', async () => {
    const data = fixture(); data.publication.chapters = [{ id: 'custom', title: '单独编排', start: 0, steps: [{ id: 'custom-step', text: '自定义动作', condition: '只能由值班人员操作。', at: 3 }] }];
    data.publication.captions = [{ id: 'caption', text: '独立字幕，不能替换成步骤', at: 2 }];
    api.read.mockResolvedValue(ok(data)); await mount();
    expect(container.querySelector('.writing-tutorial-steps')?.textContent).toContain('只能由值班人员操作。');
    expect(container.querySelector('.writing-tutorial-steps')?.textContent).not.toContain(condition);
    expect(container.querySelector('.writing-tutorial-steps table')).toBeNull();
    await click([...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '字幕全文')!);
    expect(container.querySelector('.writing-chapter-list .writing-caption-row')?.textContent).toContain('独立字幕，不能替换成步骤');
  });
  it('读取失败可重试，成功后显示实际文档约束并清除错误', async () => {
    api.read.mockResolvedValueOnce({ success: false, error: { code: 'FORBIDDEN', message: '没有阅读权限' } });
    await mount(); expect(container.querySelector('[role="alert"]')?.textContent).toContain('没有阅读权限');
    expect(container.querySelector('.writing-tutorial-step')).toBeNull();
    await click([...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '重试')!);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('.writing-tutorial-steps')?.textContent).toContain(condition);
    expect(api.read).toHaveBeenCalledTimes(2);
  });
});

async function mountVideo() {
  const data = fixture(); data.publication.videoEntryId = 'video';
  data.publication.chapters = [
    { id: 'intro', title: '为什么改流程', start: 0, steps: [{ id: 'intro-step', text: '了解目标', condition: '', at: 9 }] },
    { id: 'author', title: '交接人：提交清单', start: 50, steps: [{ id: 'author-step', text: '填写清单', condition: '离岗前3个工作日完成', at: 50 }] },
    { id: 'taker', title: '接手人：逐项确认', start: 130, steps: [{ id: 'taker-1', text: '打开待接手事项', condition: '', at: 130 }, { id: 'taker-2', text: '逐项确认资料和权限', condition: '', at: 148 }, { id: 'taker-3', text: '缺少字段直接退回', condition: '退回后由交接人补齐', at: 168 }] },
  ];
  data.publication.captions = [{ id: 'first', text: '教学第一句', at: 0 }, { id: 'current', text: '打开待接手事项的字幕', at: 130 }];
  api.read.mockResolvedValue(ok(data)); api.content.mockResolvedValue({ success: true, data: { fileUrl: '/course.mp4' } });
  await mount(); const media = container.querySelector('video')!;
  Object.defineProperty(media, 'duration', { value: 260 });
  await act(async () => media.dispatchEvent(new Event('loadedmetadata')));
  return media;
}
async function mediaTime(media: HTMLVideoElement, time: number) {
  await act(async () => { media.currentTime = time; media.dispatchEvent(new Event('timeupdate')); });
}

describe('播放器状态必须与当前学习步骤一致', () => {
  it('跳到136秒只标记接手人当前一步，整行标识当前操作', async () => {
    const media = await mountVideo(); await mediaTime(media, 136);
    const current = container.querySelectorAll('.writing-tutorial-step[aria-current="step"]');
    expect(current).toHaveLength(1); expect(current[0].textContent).toContain('打开待接手事项');
    await mediaTime(media, 170);
    expect(container.querySelectorAll('.writing-tutorial-step[aria-current="step"]')).toHaveLength(1);
    expect(container.querySelector('.writing-tutorial-step[aria-current="step"]')?.textContent).toContain('缺少字段直接退回');
  });
  it('开始后暂停保留画面和字幕，不重新盖上首次播放遮罩', async () => {
    const media = await mountVideo(); let paused = true;
    Object.defineProperty(media, 'paused', { get: () => paused });
    vi.spyOn(media, 'play').mockImplementation(async () => { paused = false; media.dispatchEvent(new Event('play')); });
    vi.spyOn(media, 'pause').mockImplementation(() => { paused = true; media.dispatchEvent(new Event('pause')); });
    await click(container.querySelector<HTMLButtonElement>('.writing-play-overlay')!);
    await mediaTime(media, 136);
    await click(container.querySelector<HTMLButtonElement>('[aria-label="暂停"]')!);
    expect(container.querySelector('.writing-play-overlay')).toBeNull();
    expect(container.querySelector('.capbox')?.textContent).toContain('打开待接手事项的字幕');
  });
  it('看过章节和勾选完成是两个状态，不把观看进度计作已完成', async () => {
    const media = await mountVideo(); await mediaTime(media, 136);
    const chapters = container.querySelectorAll('.writing-chapter-list .writing-chapter');
    expect(chapters[0].textContent).toContain('已看完'); expect(chapters[1].textContent).toContain('已看完');
    expect(chapters[2].textContent).toContain('正在看');
    expect(container.querySelector('.writing-step-heading')?.textContent).toContain('已完成 0 / 5');
  });
  it('媒体地址仍在读取时明确显示加载，不误报尚未关联', async () => {
    const data = fixture(); data.publication.videoEntryId = 'video'; api.read.mockResolvedValue(ok(data));
    let complete!: (value: unknown) => void; api.content.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    await mount(); expect(container.textContent).toContain('正在加载教学视频');
    expect(container.textContent).not.toContain('此文档尚未关联教学视频');
    await act(async () => complete({ success: false, error: { message: '媒体读取失败' } }));
    expect(container.textContent).toContain('媒体读取失败'); expect(container.querySelector('.writing-tutorial-steps')).toBeTruthy();
    api.content.mockResolvedValue({ success: true, data: { fileUrl: '/recovered.mp4' } });
    await click([...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '重试视频')!);
    expect(container.querySelector('video')?.getAttribute('src')).toBe('/recovered.mp4');
  });
  it('播放失败重试从起点恢复，章节与字幕不残留旧时间', async () => {
    const media = await mountVideo(); await mediaTime(media, 170);
    await act(async () => { media.dispatchEvent(new Event('error')); });
    await click([...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '重试视频')!);
    expect(container.querySelector('.writing-tutorial-title')?.textContent).toBe('为什么改流程');
    expect(container.querySelector('.writing-player-time')?.textContent).toContain('00:00');
    expect(container.querySelector('.writing-play-overlay')).toBeTruthy();
    expect(container.querySelector('.capbox')).toBeNull();
  });
  it('损坏但仍为合法JSON的完成记录不会让教学页崩溃', async () => {
    localStorage.setItem('map-learning:entry:v1', '{}');
    await mount();
    expect(container.querySelector('.writing-step-heading')?.textContent).toContain('已完成 0 / 3');
  });
});
