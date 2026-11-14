// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WritingReaderPage } from '../WritingReaderPage';
import { WritingReviewPage } from '../WritingReviewPage';
import { writingSaveInput } from '../writingView';
import type { WritingContext, WritingReader, WritingState, WritingTemplate } from '@/services/contracts/writing';
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
async function mount(tutorial = true) {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(<MemoryRouter><WritingReaderPage storeId="store" entryId="entry" tutorial={tutorial} /></MemoryRouter>));
}
async function click(button: HTMLButtonElement) { await act(async () => button.click()); }
let mobileQuery: { matches: boolean; listeners: Set<(event: { matches: boolean }) => void> };
beforeEach(() => {
  vi.clearAllMocks(); api.content.mockReset(); localStorage.clear(); api.read.mockResolvedValue(ok(fixture()));
  mobileQuery = { matches: false, listeners: new Set() };
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ get matches() { return mobileQuery.matches; }, addEventListener: (_type: string, callback: (event: { matches: boolean }) => void) => mobileQuery.listeners.add(callback), removeEventListener: (_type: string, callback: (event: { matches: boolean }) => void) => mobileQuery.listeners.delete(callback) }) });
});
async function viewportMobile(matches: boolean) { await act(async () => { mobileQuery.matches = matches; mobileQuery.listeners.forEach(callback => callback({ matches })); }); }

afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); });

describe('读者来源状态必须真实', () => {
  beforeEach(() => { Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: class { observe() {} disconnect() {} } }); });
  it('旧发布的pending资料不冒充原文快照或显示缺省日期', async () => {
    const data = fixture(); data.publication.sources = [{ id: 'S1', entryId: 'source1', title: '待读资料', content: '', hash: '', status: 'pending', updatedAt: '0001-01-01T00:00:00' }];
    api.read.mockResolvedValue(ok(data)); await mount(false);
    expect(container.querySelector('.writing-reader-info .srow')?.textContent).toContain('未保存原文快照');
    await click(container.querySelector<HTMLButtonElement>('.writing-reader-info .srow')!);
    expect(container.querySelector('.writing-source-dialog [role="status"]')?.textContent).toContain('打开当前原文核对');
  });
  it('跳过资料保留身份但不冒充生成依据或丢失的原文快照', async () => {
    const data = fixture(); data.publication.sources = [
      { id: 'S1', entryId: 'read', title: '已读资料', content: '先备份再确认', hash: 'read-hash', status: 'read', updatedAt: '2026-11-14T00:00:00Z' },
      { id: 'S2', entryId: 'skipped', title: '跳过资料', content: '', hash: '', status: 'skipped', updatedAt: '2026-11-14T00:00:00Z' },
      { id: 'S3', entryId: 'pending', title: '旧版待读资料', content: '', hash: '', status: 'pending', updatedAt: '0001-01-01T00:00:00' },
    ];
    api.read.mockResolvedValue(ok(data)); await mount(false);
    const rows = container.querySelectorAll<HTMLButtonElement>('.writing-reader-info .srow');
    expect(rows).toHaveLength(3);
    expect(container.querySelector('.writing-reader-info')?.textContent).toContain('已跳过 1 份');
    expect(rows[1].textContent).toContain('已跳过 · 未参与本次生成');
    expect(rows[2].textContent).toContain('未保存原文快照');
    await click(rows[1]);
    expect(container.querySelector('.writing-source-dialog')?.textContent).toContain('未参与本次生成');
    expect(container.querySelector('.writing-source-dialog')?.textContent).not.toContain('没有可核对的来源正文');
    expect(container.querySelector('.writing-source-dialog')?.textContent).not.toContain('打开当前原文核对');
  });
  it('已保存的原文完整显示，未知更新时间也不伪造日期', async () => {
    const data = fixture(); data.publication.sources = [{ id: 'S1', entryId: 'source1', title: '已读资料', content: '离岗前3个工作日，不得事后补办。', hash: 'real-hash', status: 'read', updatedAt: '0001-01-01T00:00:00' }];
    api.read.mockResolvedValue(ok(data)); await mount(false); await click(container.querySelector<HTMLButtonElement>('.writing-reader-info .srow')!);
    expect(container.querySelector('.writing-source-dialog')?.textContent).toContain('离岗前3个工作日，不得事后补办。');
    expect(container.querySelector('.writing-source-dialog')?.textContent).toContain('更新时间未记录');
  });
});

describe('教学转换必须保留已发布的执行约束', () => {
  it('新发布版本不继承旧版本的图文章节位置', async () => {
    localStorage.setItem('map-learning:entry:v1:chapter', 's2');
    const data = fixture(); data.publication.version = 2; api.read.mockResolvedValue(ok(data));
    await mount(); expect(container.querySelector('.writing-tutorial-title')?.textContent).toBe('移交权限');
  });
  it('已删除的章节游标安全回到首章，不显示空白或错误的执行条件', async () => {
    localStorage.setItem('map-learning:entry:v1:chapter', 'removed-chapter');
    await mount(); expect(container.querySelector('.writing-tutorial-title')?.textContent).toBe('移交权限');
    expect(container.querySelector('.writing-tutorial-steps')?.textContent).toContain(condition);
  });

  it('图文教学刷新后恢复当前章节及其执行条件和完成记录', async () => {
    await mount();
    await click(container.querySelectorAll<HTMLButtonElement>('.writing-chapter-list .writing-chapter')[1]);
    await click(container.querySelector<HTMLButtonElement>('.writing-done-step')!);
    expect(container.querySelector('.writing-tutorial-title')?.textContent).toBe('主管签收');
    expect(container.querySelector('.writing-done-step')?.getAttribute('aria-checked')).toBe('true');
    await act(async () => root.unmount()); container.remove();
    await mount();
    expect(container.querySelector('.writing-tutorial-title')?.textContent).toBe('主管签收');
    expect(container.querySelector('.writing-tutorial-steps')?.textContent).toContain('接手人核验完成后，主管才能签收。');
    expect(container.querySelector('.writing-done-step')?.getAttribute('aria-checked')).toBe('true');
  });

  it('未关联视频的图文教学不显示不可用播放器控件、零秒字幕或虚假观看状态', async () => {
    await mount();
    expect(container.querySelector('.writing-control-play')).toBeNull();
    expect(container.querySelector('.writing-tutorial-body')?.textContent).not.toContain('00:00');
    expect(container.querySelector('.writing-chapter-list')?.textContent).not.toContain('正在看');
    expect(container.querySelector('.writing-chapter-list')?.textContent).toContain('当前章节');
    expect(container.querySelector('.writing-tutorial-steps')?.textContent).toContain(condition);
  });

  it('条件在当前章步骤之前完整显示一次，保留数值、否定与适用范围', async () => {
    await mount();
    const block = container.querySelector('.writing-tutorial-steps .writing-section-condition');
    expect(block?.textContent).toContain(condition);
    expect(container.querySelector('.writing-tutorial-step[aria-current="step"]')).toBeNull();
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

async function mountVideo(mobileVideoEntryId?: string) {
  const data = fixture(); data.publication.videoEntryId = 'video';
  if (mobileVideoEntryId) Object.assign(data.publication, { mobileVideoEntryId });
  data.publication.chapters = [
    { id: 'intro', title: '为什么改流程', start: 0, steps: [{ id: 'intro-step', text: '了解目标', condition: '', at: 9 }] },
    { id: 'author', title: '交接人：提交清单', start: 50, steps: [{ id: 'author-step', text: '填写清单', condition: '离岗前3个工作日完成', at: 50 }] },
    { id: 'taker', title: '接手人：逐项确认', start: 130, steps: [{ id: 'taker-1', text: '打开待接手事项', condition: '', at: 130 }, { id: 'taker-2', text: '逐项确认资料和权限', condition: '', at: 148 }, { id: 'taker-3', text: '缺少字段直接退回', condition: '退回后由交接人补齐', at: 168 }] },
  ];
  data.publication.captions = [{ id: 'first', text: '教学第一句', at: 0 }, { id: 'current', text: '打开待接手事项的字幕', at: 130 }];
  api.read.mockResolvedValue(ok(data)); api.content.mockImplementation(async (id: string) => ({ success: true, data: { fileUrl: id === 'mobile' ? '/mobile.mp4' : '/course.mp4' } }));
  await mount(); const media = container.querySelector('video')!;
  Object.defineProperty(media, 'duration', { value: 260 });
  await act(async () => media.dispatchEvent(new Event('loadedmetadata')));
  return media;
}
async function mediaTime(media: HTMLVideoElement, time: number) {
  await act(async () => { media.currentTime = time; media.dispatchEvent(new Event('timeupdate')); });
}

describe('播放器状态必须与当前学习步骤一致', () => {
  it('教学顶栏按原稿只保留原文入口与主题，避免混入作者管理工具', async () => {
    const data = fixture(); data.canEdit = true; api.read.mockResolvedValue(ok(data)); await mount();
    const top = container.querySelector('.writing-desktop-top .writing-actions')!;
    expect(top.textContent).not.toContain('作者工作区'); expect(top.textContent).not.toContain('版本 v');
    expect([...top.querySelectorAll('a')].some(link => link.textContent === '打开需求说明原文')).toBe(true);
  });

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
    expect(container.textContent).toContain('正在读取视频信息');
    expect(container.querySelectorAll('.writing-tutorial-step[aria-current=step]')).toHaveLength(0);
    expect(container.querySelector('.writing-play-overlay')).toBeNull();
    const recovered = container.querySelector('video')!; Object.defineProperty(recovered, 'duration', { value: 260 });
    await act(async () => { recovered.dispatchEvent(new Event('loadedmetadata')); });
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


describe('手机教学素材必须沿发布关联真实选择', () => {
  it('窄屏选作者发布的手机视频，未配置时兼容默认视频', async () => {
    mobileQuery.matches = true;
    await mountVideo('mobile');
    expect(api.content).toHaveBeenLastCalledWith('mobile');
    expect(container.querySelector('video')?.getAttribute('src')).toBe('/mobile.mp4');
  });
  it('桌面仍选默认视频，不因手机关联覆盖默认素材', async () => {
    await mountVideo('mobile');
    expect(api.content).toHaveBeenLastCalledWith('video');
    expect(container.querySelector('video')?.getAttribute('src')).toBe('/course.mp4');
    await viewportMobile(true);
    expect(api.content).toHaveBeenLastCalledWith('mobile');
  });
  it('没有手机关联的旧发布在手机继续播放默认视频', async () => {
    mobileQuery.matches = true; await mountVideo();
    expect(container.querySelector('video')?.getAttribute('src')).toBe('/course.mp4');
  });
  it('暂停时切屏保留真实媒体时间、倍速与完成态，不自动播放', async () => {
    const media = await mountVideo('mobile'); await mediaTime(media, 136); media.playbackRate = 1.25;
    await click(container.querySelector<HTMLButtonElement>('.writing-done-step')!);
    await viewportMobile(true);
    expect(container.querySelector('video')?.getAttribute('src')).toBe('/mobile.mp4');
    const next = container.querySelector('video')!; const play = vi.spyOn(next, 'play').mockResolvedValue();
    Object.defineProperty(next, 'duration', { value: 260 });
    await act(async () => { next.dispatchEvent(new Event('loadedmetadata')); });
    expect(next.currentTime).toBe(136); expect(next.playbackRate).toBe(1.25); expect(play).not.toHaveBeenCalled();
    expect(container.querySelector('.writing-step-heading')?.textContent).toContain('已完成 1 / 5');
  });
  it('播放中切屏在新媒体就绪后续播', async () => {
    const media = await mountVideo('mobile'); await mediaTime(media, 148);
    Object.defineProperty(media, 'paused', { value: false }); media.playbackRate = 1.5;
    await viewportMobile(true);
    expect(container.querySelector('video')?.getAttribute('src')).toBe('/mobile.mp4');
    const next = container.querySelector('video')!; const play = vi.spyOn(next, 'play').mockResolvedValue();
    Object.defineProperty(next, 'duration', { value: 260 });
    await act(async () => { next.dispatchEvent(new Event('loadedmetadata')); });
    expect(next.currentTime).toBe(148); expect(next.playbackRate).toBe(1.5); expect(play).toHaveBeenCalledOnce();
  });
  it('快速往返切屏时，迟到的手机地址不能覆盖已恢复的默认素材', async () => {
    const media = await mountVideo('mobile'); await mediaTime(media, 136);
    let complete!: (result: { success: boolean; data: { fileUrl: string } }) => void;
    api.content.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    await viewportMobile(true); expect(container.textContent).toContain('正在加载教学视频');
    await viewportMobile(false);
    await act(async () => complete({ success: true, data: { fileUrl: '/late-mobile.mp4' } }));
    expect(container.querySelector('video')?.getAttribute('src')).toBe('/course.mp4');
    const next = container.querySelector('video')!; Object.defineProperty(next, 'duration', { value: 260 });
    await act(async () => { next.dispatchEvent(new Event('loadedmetadata')); }); expect(next.currentTime).toBe(136);
  });
  it('不同时长的手机视频明确报错并可回到默认素材，不让章节和字幕错配', async () => {
    const media = await mountVideo('mobile'); await mediaTime(media, 136);
    await viewportMobile(true);
    const bad = container.querySelector('video')!; Object.defineProperty(bad, 'duration', { value: 2 });
    await act(async () => { bad.dispatchEvent(new Event('loadedmetadata')); });
    expect(container.textContent).toContain('手机视频与默认视频时长不一致');
    const fallback = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '使用默认视频');
    expect(fallback).toBeTruthy(); await click(fallback!);
    const recovered = container.querySelector('video')!; Object.defineProperty(recovered, 'duration', { value: 260 });
    await act(async () => { recovered.dispatchEvent(new Event('loadedmetadata')); });
    expect(recovered.currentTime).toBe(136); expect(recovered.getAttribute('src')).toBe('/course.mp4');
  });
  it('手机媒体读取失败可显式改用默认视频，图文步骤不消失', async () => {
    await mountVideo('mobile');
    api.content.mockResolvedValueOnce({ success: false, error: { message: '手机文件不可读' } });
    await viewportMobile(true);
    expect(container.textContent).toContain('手机文件不可读');
    expect(container.querySelector('.writing-tutorial-steps')).toBeTruthy();
    const fallback = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '使用默认视频');
    expect(fallback).toBeTruthy(); await click(fallback!);
    expect(container.querySelector('video')?.getAttribute('src')).toBe('/course.mp4');
  });
});

describe('作者教学素材关联', () => {
  it('作者保存载荷保留手机关联，清除时明确发送空串', () => {
    const state = { ...fixture().publication, revision: 1, sources: [], mobileVideoEntryId: 'mobile' } as unknown as WritingState;
    expect(writingSaveInput(state)).toHaveProperty('mobileVideoEntryId', 'mobile');
    delete state.mobileVideoEntryId;
    expect(writingSaveInput(state)).toHaveProperty('mobileVideoEntryId', '');
  });

  it('作者可独立选择手机视频，选项只含当前知识库的视频', async () => {
    const state = { ...fixture().publication, stage: 'confirm', questions: [], revision: 1, updatedAt: '2026-11-13T00:00:00Z' } as unknown as WritingState;
    const context = { store: fixture().store, sources: [{ id: 'video', title: '完整教学', contentType: 'video/mp4' }, { id: 'mobile', title: '手机教学', contentType: 'video/mp4' }, { id: 'pdf', title: '原始资料', contentType: 'application/pdf' }] } as WritingContext;
    const patch = vi.fn(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root.render(<MemoryRouter><WritingReviewPage state={state} context={context} template={{ type: '需求说明' } as WritingTemplate} locked={false} busy={false} dirty={false} onPatch={patch} onCommand={vi.fn()} onBack={vi.fn()} /></MemoryRouter>));
    const select = container.querySelector<HTMLSelectElement>('[aria-label="手机教学视频"]'); expect(select).toBeTruthy();
    expect([...select!.options].map(option => option.value)).toEqual(['', 'video', 'mobile']);
    await act(async () => { select!.value = 'mobile'; select!.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(patch).toHaveBeenLastCalledWith({ mobileVideoEntryId: 'mobile' });
  });
});

describe('媒体切换边界回归', () => {
  it('地址已返回但metadata未到时往返切屏仍保留136秒与倍速', async () => {
    const media = await mountVideo('mobile'); await mediaTime(media, 136); media.playbackRate = 1.25;
    await viewportMobile(true);
    expect(container.querySelector('video')?.getAttribute('src')).toBe('/mobile.mp4');
    // 新手机video已经挂载，但浏览器还未取得metadata，currentTime为0。
    await viewportMobile(false);
    const recovered = container.querySelector('video')!;
    Object.defineProperty(recovered, 'duration', { value: 260 });
    await act(async () => recovered.dispatchEvent(new Event('loadedmetadata')));
    expect(recovered.currentTime).toBe(136);
    expect(recovered.playbackRate).toBe(1.25);
  });

  it('手机首次进入遇到短于已发布章节时间轴的素材应明确失败', async () => {
    mobileQuery.matches = true;
    const data = fixture();
    data.publication.videoEntryId = 'video'; data.publication.mobileVideoEntryId = 'mobile';
    data.publication.chapters = [{ id: 'chapter', title: '第130秒的关键动作', start: 130,
      steps: [{ id: 'step', text: '第168秒执行', condition: '', at: 168 }] }];
    data.publication.captions = [{ id: 'caption', text: '第130秒字幕', at: 130 }];
    api.read.mockResolvedValue(ok(data));
    api.content.mockResolvedValue({ success: true, data: { fileUrl: '/mobile.mp4' } });
    await mount();
    const media = container.querySelector('video')!;
    Object.defineProperty(media, 'duration', { value: 2 });
    await act(async () => media.dispatchEvent(new Event('loadedmetadata')));
    expect(container.textContent).toContain('时长不一致');
    expect([...container.querySelectorAll('button')].some(button => button.textContent === '使用默认视频')).toBe(true);
  });

  it('已离开手机媒体的迟到续播拒绝不能移除正常默认视频', async () => {
    const media = await mountVideo('mobile'); await mediaTime(media, 136);
    Object.defineProperty(media, 'paused', { value: false });
    await viewportMobile(true);
    const mobile = container.querySelector('video')!;
    let rejectPlay!: (reason: Error) => void;
    vi.spyOn(mobile, 'play').mockImplementation(() => new Promise((_resolve, reject) => { rejectPlay = reject; }));
    Object.defineProperty(mobile, 'duration', { value: 260 });
    await act(async () => mobile.dispatchEvent(new Event('loadedmetadata')));
    await viewportMobile(false);
    const recovered = container.querySelector('video')!;
    Object.defineProperty(recovered, 'duration', { value: 260 });
    await act(async () => recovered.dispatchEvent(new Event('loadedmetadata')));
    expect(recovered.getAttribute('src')).toBe('/course.mp4');
    await act(async () => rejectPlay(new DOMException('old mobile decoding failed', 'NotSupportedError')));
    expect(container.querySelector('video')?.getAttribute('src')).toBe('/course.mp4');
  });
});

describe('阅读页使用真实媒体信息与角色提示', () => {
  beforeEach(() => { Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: class { observe() {} disconnect() {} } }); });
  it('阅读页真实metadata到达后显示课程分钟数，不硬编码教学时长', async () => {
    const data = fixture(); data.publication.videoEntryId = 'video';
    data.publication.roles = [{ label: '接手人', action: '核验', condition: '', sectionId: 's1', orderedSectionIds: ['s1'] }];
    api.read.mockResolvedValue(ok(data)); api.content.mockResolvedValue({ success: true, data: { fileUrl: '/real-course.mp4' } });
    await mount(false);
    const media = container.querySelector('video'); expect(media).toBeTruthy();
    expect(container.querySelector('.writing-mobile-tabs')?.textContent).not.toContain('4 分钟');
    Object.defineProperty(media!, 'duration', { configurable: true, value: 260 });
    await act(async () => media!.dispatchEvent(new Event('loadedmetadata')));
    expect(container.querySelector('.writing-mobile-tabs')?.textContent).toContain('教学 · 4 分钟');
    expect(container.querySelector('.writing-reading-order .hint')?.textContent).toContain('接手人');
    expect(container.querySelector('.writing-reading-order a')?.textContent).toContain('4 分钟教学');
    Object.defineProperty(media!, 'duration', { configurable: true, value: Infinity });
    await act(async () => media!.dispatchEvent(new Event('loadedmetadata')));
    expect(container.querySelector('.writing-mobile-tabs')?.textContent).not.toContain('4 分钟');
  });
});
