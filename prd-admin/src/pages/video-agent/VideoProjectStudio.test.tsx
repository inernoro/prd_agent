import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { VideoProjectStudio } from './VideoProjectStudio';

describe('VideoProjectStudio', () => {
  it('opens on the usable project console instead of the legacy task list', () => {
    const html = renderToStaticMarkup(
      <VideoProjectStudio
        projects={[]}
        project={null}
        runs={[]}
        busy={false}
        onSelectProject={vi.fn()}
        onNewProject={vi.fn()}
        onSave={vi.fn(async () => null)}
        onAnalyze={vi.fn(async () => undefined)}
        onOpenRun={vi.fn()}
      />,
    );

    expect(html).toContain('data-testid="video-project-studio"');
    expect(html).toContain('aria-label="文学稿内容"');
    expect(html).toContain('分析并拆镜');
    expect(html).toContain('项目控制器');
    expect(html).toContain('多轨时间线');
    expect(html).toContain('视频</span>');
    expect(html).toContain('字幕</span>');
    expect(html).toContain('配音</span>');
    expect(html).toContain('音乐</span>');
    expect(html).not.toContain('高级创作（拆分镜）');
    expect(html).not.toContain('共 36 个任务');
  });
});
