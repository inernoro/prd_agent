import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { VideoProjectStudio } from './VideoProjectStudio';

describe('VideoProjectStudio', () => {
  it('opens on a focused literary creation flow instead of an editor console', () => {
    const html = renderToStaticMarkup(
      <VideoProjectStudio
        projects={[]}
        project={null}
        runs={[]}
        models={[{
          id: 'doubao-seedance-1-5-pro-251215',
          name: 'Seedance 1.5 Pro',
          healthStatus: 'Healthy',
          supportsAudio: true,
          supportsFirstFrame: true,
          supportsLastFrame: true,
          supportsReferenceAssets: false,
          aspectRatios: ['16:9', '9:16'],
          resolutions: ['720p', '1080p'],
          durations: [5, 10],
        }]}
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
    expect(html).toContain('文学创作转视频');
    expect(html).toContain('把一个故事变成一组镜头');
    expect(html).toContain('AI 拆成分镜');
    expect(html).toContain('Seedance 1.5 Pro');
    expect(html).toContain('文稿</span>');
    expect(html).toContain('参考</span>');
    expect(html).toContain('设置</span>');
    expect(html).not.toContain('项目控制器');
    expect(html).not.toContain('多轨时间线');
    expect(html).not.toContain('镜头控制器');
    expect(html).not.toContain('添加字幕片段');
    expect(html).not.toContain('高级创作（拆分镜）');
    expect(html).not.toContain('共 36 个任务');
  });
});
