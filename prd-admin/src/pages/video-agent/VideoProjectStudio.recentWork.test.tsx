// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { VideoProject } from '@/services/contracts/videoAgent';
import { VideoProjectStudio } from './VideoProjectStudio';

describe('最近作品从项目恢复任务', () => {
  it('六个项目占满卡片时仍打开该项目的已保存任务，无任务草稿继续进入编辑', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const projects = Array.from({ length: 6 }, (_, index) => ({
      id: `project-${index}`, appKey: 'prd-admin', ownerAdminId: 'owner',
      title: `作品${index}`, status: index === 0 ? 'Completed' : 'Draft',
      latestRunId: index === 0 ? 'saved-run' : undefined,
      sourceMarkdown: '', defaultAspectRatio: '16:9', defaultResolution: '720p',
      defaultDuration: 5, generateAudio: true, assets: [], timelineTracks: [],
      createdAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T00:00:00Z',
    })) as VideoProject[];
    const onOpenRun = vi.fn(), onSelectProject = vi.fn();
    const host = document.createElement('div');document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<VideoProjectStudio projects={projects} project={null}
        runs={[]} models={[]} busy={false} onSelectProject={onSelectProject}
        onNewProject={vi.fn()} onSave={vi.fn(async () => null)}
        onAnalyze={vi.fn(async () => undefined)} onCreateDirect={vi.fn(async () => undefined)}
        onOpenRun={onOpenRun} onOpenDemo={vi.fn()} />));
      const cards = host.querySelectorAll<HTMLButtonElement>('.video-create-project-grid button');
      expect(cards).toHaveLength(6);
      await act(async () => cards[0].click());
      expect(onOpenRun).toHaveBeenCalledWith('saved-run');
      expect(onSelectProject).toHaveBeenCalledWith(projects[0]);
      expect(onSelectProject.mock.invocationCallOrder[0]).toBeLessThan(onOpenRun.mock.invocationCallOrder[0]);
      await act(async () => cards[1].click());
      expect(onSelectProject).toHaveBeenCalledWith(projects[1]);
      expect(onOpenRun).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());host.remove();vi.unstubAllGlobals();
    }
  });
});
