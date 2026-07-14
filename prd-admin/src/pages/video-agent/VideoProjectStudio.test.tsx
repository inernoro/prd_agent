import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { VideoGenRunListItem } from '@/services/contracts/videoAgent';
import { VideoProjectStudio } from './VideoProjectStudio';

const renderStudio = (runs: VideoGenRunListItem[] = []) => renderToStaticMarkup(
  <VideoProjectStudio
    projects={[]}
    project={null}
    runs={runs}
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

const createRun = (status: string, overrides: Partial<VideoGenRunListItem> = {}): VideoGenRunListItem => ({
  id: `run-${status.toLowerCase()}`,
  status,
  mode: 'storyboard',
  articleTitle: `${status} task`,
  currentPhase: status,
  phaseProgress: 0,
  totalDurationSeconds: 0,
  createdAt: '2026-07-14T00:00:00Z',
  scenesCount: 0,
  scenesReady: 0,
  hasActiveScenes: false,
  ...overrides,
});

describe('VideoProjectStudio', () => {
  it('opens on a focused literary creation flow instead of an editor console', () => {
    const html = renderStudio();

    expect(html).toContain('data-testid="video-project-studio"');
    expect(html).toContain('aria-label="文学稿内容"');
    expect(html).toContain('文学创作转视频');
    expect(html).toContain('把一个故事变成一组镜头');
    expect(html).toContain('雨夜街巷的电影画面风格预览');
    expect(html).toContain('aria-label="镜头草图"');
    expect(html.match(/\/video-studio\/story-to-film-stage\.jpg/g)).toHaveLength(4);
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

  it('does not present failed or cancelled legacy runs as recent works', () => {
    const html = renderStudio([
      createRun('Failed'),
      createRun('Cancelled'),
    ]);

    expect(html).not.toContain('最近作品');
    expect(html).not.toContain('Failed task');
    expect(html).not.toContain('Cancelled task');
  });

  it('renders active legacy runs with a built-in cover and localized status', () => {
    const html = renderStudio([createRun('Rendering')]);

    expect(html).toContain('最近作品');
    expect(html).toContain('1 个作品');
    expect(html).toContain('生成中');
    expect(html).toContain('镜头准备中');
    expect(html).toContain('视频作品');
    expect(html).not.toContain('/icon/backups/agent/video-agent.png');
  });
});
