// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WritingPublication, WritingTeaching, WritingTeachingInfo } from '@/services/contracts/writing';
import { WritingTeachingPanel } from '../WritingTeachingPanel';
import { WritingReaderPage } from '../WritingReaderPage';
const api = vi.hoisted(() => ({ info: vi.fn(), generate: vi.fn(), resume: vi.fn(), approve: vi.fn(), media: vi.fn(), read: vi.fn(), content: vi.fn() }));
vi.mock('@/services/real/writing', () => ({ getWritingTeaching: api.info, generateWritingTeaching: api.generate, resumeWritingTeaching: api.resume, approveWritingTeaching: api.approve, downloadWritingTeaching: api.media, readWriting: api.read, exportWritingHtml: vi.fn() }));
vi.mock('@/services/real/documentStore', () => ({ getDocumentContent: api.content }));
vi.mock('../WritingWorkspacePage', () => ({ WritingThemeButton: () => <button>主题</button> }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => <span>处理中</span>, MapSectionLoader: ({ text }: { text: string }) => <p>{text}</p> }));
vi.mock('@/components/file-preview/MarkdownViewer', () => ({ MarkdownViewer: ({ content }: { content: string }) => <p>{content}</p> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const source: WritingPublication = { version: 1, title: '测试交接', summary: '失败立即停止', templateId: 'prd', templateVersion: '1', authorName: '作者', reviewerName: '审核人', publishedAt: '2026-11-16T00:00:00Z', conclusions: [], scopeIn: '仅测试租户', scopeOut: '正式租户', roles: [], chapters: [], openQuestions: [], sources: [], intentPoints: ['正式租户禁止执行'], sections: [{ id: 's1', title: '执行条件', condition: '每批必须经审核人确认', paragraphs: [{ id: 'p1', text: '正式租户禁止执行', status: 'auth', citations: [], confirmed: true }] }] };
function teaching(): WritingTeaching { return { id: 'course1', entryId: 'entry', storeId: 'store', ownerId: 'author', authorId: 'author', source, sourceFingerprint: 'frozen-source-hash', instructions: '', status: 'ready', phase: '成片已生成，请作者预览并批准', progress: 100, revision: 7, artifactFingerprint: 'exact-artifact-hash', duration: 7.833, scenes: [{ id: 'scene-1', sectionId: 's1', paragraphIds: ['p1'], intentIndexes: [0], title: '先核对执行范围', highlights: ['正式租户禁止执行'], narration: '仅测试租户可执行；每批必须经审核人确认。', start: 0, duration: 7.833 }] }; }
const info = (value = teaching()): WritingTeachingInfo => ({ teaching: value, canApprove: true, sourceCurrent: true, sourceVersion: 1, sourceFingerprint: 'frozen-source-hash' });
let root: Root | undefined, container: HTMLDivElement;
async function mount(reader = false) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter initialEntries={['/read?version=1&course=course1']}>{reader ? <WritingReaderPage entryId="entry" storeId="store" tutorial /> : <WritingTeachingPanel entryId="entry" storeId="store" />}</MemoryRouter>));
}
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(e => e.textContent === text)!;
async function click(text: string) { await act(async () => button(text).click()); }
async function metadata(duration = 7.833) {
  const video = container.querySelector<HTMLVideoElement>('video')!;
  Object.defineProperties(video, { duration: { configurable: true, value: duration }, videoWidth: { configurable: true, value: 1280 }, videoHeight: { configurable: true, value: 720 } });
  await act(async () => video.dispatchEvent(new Event('loadedmetadata', { bubbles: true })));
  return video;
}
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); localStorage.clear();
  api.info.mockResolvedValue({ success: true, data: info() }); api.media.mockResolvedValue({ blob: new Blob(['unit-media']) });
  api.approve.mockResolvedValue({ success: true, data: { teaching: { ...teaching(), status: 'approved' } } });
  URL.createObjectURL = vi.fn(() => 'blob:authorized-media'); URL.revokeObjectURL = vi.fn();
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined); HTMLMediaElement.prototype.pause = vi.fn();
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; container?.remove(); });

describe('作者批准具体教学成品', () => {
  it('制作成功不会自动批准，预览后核对才批准该来源版与成品', async () => {
    await mount(); expect(button('批准教学 · 文档 v1').disabled).toBe(true); expect(api.approve).not.toHaveBeenCalled();
    await click('预览横版成片'); expect(api.media).toHaveBeenCalledWith('entry', 'course1', false);
    await metadata(); await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(button('批准教学 · 文档 v1').disabled).toBe(false); await click('批准教学 · 文档 v1');
    expect(api.approve).toHaveBeenCalledWith('entry', expect.objectContaining({ revision: 7, artifactFingerprint: 'exact-artifact-hash', sourceFingerprint: 'frozen-source-hash', source: expect.objectContaining({ version: 1 }) }));
    expect(container.querySelector('.writing-teaching-status')?.textContent).toContain('教学已批准');
    expect(container.querySelector('.writing-teaching-status')?.textContent).not.toContain('请作者预览并批准');
    expect(container.querySelector('a.btn.pri')?.getAttribute('href')).toContain('learn?version=1&course=course1');
  });
  it('旧预览迟到不能变成另一成品的批准依据', async () => {
    let finish!: (value: unknown) => void;
    api.media.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await mount();
    await act(async () => { button('预览横版成片').click(); });
    api.info.mockResolvedValue({ success: true, data: info({ ...teaching(), id: 'course2', artifactFingerprint: 'new-artifact' }) });
    // 模拟刷新恢复拿到另一具体成品；旧异步下载不得覆盖新状态。
    await act(async () => root!.unmount()); root = undefined; container.remove();
    await mount(); await act(async () => finish({ blob: new Blob(['old-unit-media']) }));
    expect(container.querySelector('video')).toBeNull(); expect(button('批准教学 · 文档 v1').disabled).toBe(true);
    expect(api.approve).not.toHaveBeenCalled();
  });
});
describe('读者消费已批准教学', () => {
  it.each([1, 2, 3, 4, 5, 6, 7])('小数章节%s跳转后媒体读回量化不会退回上一章或上一句字幕', async index => {
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    HTMLElement.prototype.scrollIntoView = vi.fn();
    // 真实课程时间轴；Chromium媒体时钟读回按微秒量化，而接口保留双精度小数。
    const starts = [0, 16.566666666666666, 28.46666666666667, 44.96666666666667, 59.53333333333333, 84.73333333333333, 99.83333333333333, 114.23333333333333, 132.1];
    const course = teaching(); course.duration = 148.234;
    course.scenes = starts.map((start, i) => ({ ...course.scenes[0], id: `scene-${i}`, title: `第${i + 1}章条件`, narration: `第${i + 1}章必须遵守的规则`, start, duration: (starts[i + 1] ?? course.duration) - start }));
    api.read.mockResolvedValue({ success: true, data: { entryId: 'entry', store: { id: 'store', name: '交接知识库' }, publication: source, affectedSources: [], entries: [], canEdit: false, teaching: { ...course, sourceVersion: 1 } } });
    await mount(true); const video = await metadata(course.duration);
    const rows = () => [...container.querySelectorAll<HTMLButtonElement>('.writing-chapter')];
    await act(async () => rows()[index].click());
    video.currentTime = Math.trunc(starts[index] * 1_000_000) / 1_000_000;
    await act(async () => video.dispatchEvent(new Event('timeupdate', { bubbles: true })));
    expect(container.querySelector('.writing-chapter.on strong')?.textContent).toBe(course.scenes[index].title);
    expect(rows()[index - 1].textContent).toContain('已看完');
    expect(container.querySelector('.capbox')?.textContent).toBe(course.scenes[index].narration);
    await click('字幕全文');
    expect(container.querySelector('.writing-caption-list [aria-current="true"]')?.textContent).toContain(course.scenes[index].narration);
    // 量化边界前1微秒及前一帧仍属于前章，不能靠大容差提前进入下一章。
    for (const before of [(Math.trunc(starts[index] * 1_000_000) - 1) / 1_000_000, starts[index] - 1 / 30]) {
      video.currentTime = before;
      await act(async () => video.dispatchEvent(new Event('timeupdate', { bubbles: true })));
      expect(container.querySelector('.writing-tutorial-title')?.textContent).toBe(course.scenes[index - 1].title);
      expect(container.querySelector('.capbox')?.textContent).toBe(course.scenes[index - 1].narration);
      expect(container.querySelector('.writing-caption-list [aria-current="true"]')?.textContent).toContain(course.scenes[index - 1].narration);
    }
  });
  it('按指定发布版鉴权加载成片，讲解要点不冒充操作完成，字幕在末尾消失', async () => {
    const course = teaching();
    api.read.mockResolvedValue({ success: true, data: { entryId: 'entry', store: { id: 'store', name: '交接知识库' }, publication: source, affectedSources: [], entries: [{ id: 'entry', title: source.title }], canEdit: false, teaching: { ...course, sourceVersion: 1 } } });
    await mount(true);
    expect(api.read).toHaveBeenCalledWith('entry', { overview: false, version: 1, course: 'course1' });
    expect(api.media).toHaveBeenCalledWith('entry', 'course1', false); expect(api.content).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('我做完了'); expect(container.textContent).toContain('每批必须经审核人确认');
    const video = await metadata(); video.currentTime = 1;
    await act(async () => video.dispatchEvent(new Event('timeupdate', { bubbles: true })));
    expect(container.querySelector('.capbox')?.textContent).toContain(course.scenes[0].narration);
    video.currentTime = 7.833; await act(async () => video.dispatchEvent(new Event('timeupdate', { bubbles: true })));
    expect(container.querySelector('.capbox')?.textContent).toBe('');
  });
  it('快速阅读优先呈现作者原句，完整结论保留折叠且可定位正文', async () => {
    const publication = structuredClone(source); publication.summary = '普通摘要'; publication.conclusions = ['经审核的完整结论'];
    publication.intentCoverage = [{ intentIndex: 0, paragraphIds: ['p1'], confirmed: true }];
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    api.read.mockResolvedValue({ success: true, data: { entryId: 'entry', store: { id: 'store', name: '交接知识库' }, publication, affectedSources: [], entries: [], canEdit: false } });
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => root!.render(<MemoryRouter><WritingReaderPage entryId="entry" storeId="store" tutorial={false} /></MemoryRouter>));
    const primary = container.querySelector('.writing-reader-takeaways > .writing-conclusions');
    expect(primary?.textContent).toContain('正式租户禁止执行'); expect(primary?.textContent).not.toContain('完整结论');
    expect(container.querySelector<HTMLDetailsElement>('.writing-full-conclusions')?.open).toBe(false);
    expect(container.querySelector('.writing-full-conclusions')?.textContent).toContain('经审核的完整结论');
    const target = container.querySelector<HTMLElement>('[data-paragraph-id="p1"]')!; target.scrollIntoView = vi.fn();
    await click('查看正文'); expect(target.scrollIntoView).toHaveBeenCalled(); expect(document.activeElement).toBe(target);
  });
});
