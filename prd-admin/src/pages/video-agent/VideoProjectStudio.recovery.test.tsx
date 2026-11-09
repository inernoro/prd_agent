// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VideoModelOption, VideoProject } from '@/services/contracts/videoAgent';
import { VideoProjectStudio } from './VideoProjectStudio';

let host: HTMLDivElement;
let root: Root | undefined;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); vi.clearAllMocks(); });
async function change(input: HTMLTextAreaElement, value: string) {
  await act(async () => { input.value = value; Simulate.change(input); });
}
const models: VideoModelOption[] = ['landscape', 'portrait'].map((id, index) => ({
  id, name: id, healthStatus: 'Healthy', supportsAudio: index === 1,
  supportsFirstFrame: true, supportsLastFrame: false, supportsReferenceAssets: false,
  aspectRatios: [index ? '9:16' : '16:9'], resolutions: [index ? '1080p' : '720p'], durations: [index ? 10 : 5],
}));
const project: VideoProject = {
  id: 'first', appKey: 'video-agent', ownerAdminId: 'synthetic', title: '原项目', status: 'Draft',
  sourceMarkdown: '原文稿', defaultVideoModel: 'portrait', defaultAspectRatio: '9:16',
  defaultResolution: '1080p', defaultDuration: 10, generateAudio: true,
  assets: [], timelineTracks: [], createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z',
};
async function setup(catalog = models) {
  const onSave = vi.fn(async () => null);
  const props = { projects: [project], project, runs: [], models: catalog, busy: false,
    onSelectProject: vi.fn(), onNewProject: vi.fn(), onSave, onAnalyze: vi.fn(async () => {}),
    onCreateDirect: vi.fn(async () => {}), onOpenRun: vi.fn(), onOpenDemo: vi.fn() };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const view = {
    rerender: async (node: ReactNode) => { await act(async () => root!.render(node)); },
    getByLabelText: (label: string) => { const node = host.querySelector(`[aria-label="${label}"]`); if (!node) throw new Error('缺少输入 '+label); return node; },
    getByTitle: (title: string) => { const node = host.querySelector<HTMLButtonElement>(`button[title="${title}"]`); if (!node) throw new Error('缺少操作 '+title); return node; },
  };
  await view.rerender(<VideoProjectStudio {...props} />);
  return { props, view, onSave, story: () => view.getByLabelText('文学稿内容') as HTMLTextAreaElement };
}
describe('视频工作台恢复与本地编辑', () => {
  it('模型目录刷新不能覆盖正在编辑的文稿', async () => {
    const { props, view, story } = await setup();
    await change(story(), '我正在修改的文稿');
    await view.rerender(<VideoProjectStudio {...props} models={models.map(model => ({ ...model }))} />);
    expect(story().value).toBe('我正在修改的文稿');
  });
  it('同一项目的列表回读不能覆盖未保存编辑', async () => {
    const { props, view, story } = await setup();
    await change(story(), '未保存的文稿');
    await view.rerender(<VideoProjectStudio {...props} project={{ ...project }} />);
    expect(story().value).toBe('未保存的文稿');
  });
  it('迟到的模型目录恢复项目设置，同时保留用户输入', async () => {
    const { props, view, story, onSave } = await setup([]);
    await change(story(), '目录加载期间的修改');
    await view.rerender(<VideoProjectStudio {...props} models={models} />);
    expect(story().value).toBe('目录加载期间的修改');
    await act(async () => view.getByTitle('保存草稿').click());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      sourceMarkdown: '目录加载期间的修改', defaultVideoModel: 'portrait',
      defaultAspectRatio: '9:16', defaultResolution: '1080p', defaultDuration: 10, generateAudio: true,
    }));
  });
  it('明确切换项目时恢复新文稿和该项目模型的可用设置', async () => {
    const { props, view, story, onSave } = await setup();
    await change(story(), '旧项目草稿');
    await view.rerender(<VideoProjectStudio {...props} project={{ ...project, id: 'second', sourceMarkdown: '新项目正文',
      defaultVideoModel: 'landscape', defaultAspectRatio: '9:16', defaultResolution: '1080p', defaultDuration: 10 }} />);
    expect(story().value).toBe('新项目正文');
    await act(async () => view.getByTitle('保存草稿').click());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ defaultVideoModel: 'landscape',
      defaultAspectRatio: '16:9', defaultResolution: '720p', defaultDuration: 5, generateAudio: false }));
  });
});
