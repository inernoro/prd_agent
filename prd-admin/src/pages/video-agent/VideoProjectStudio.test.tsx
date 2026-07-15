import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { VideoGenRunListItem, VideoProject } from '@/services/contracts/videoAgent';
import { VideoProjectStudio } from './VideoProjectStudio';

const renderStudio = (runs: VideoGenRunListItem[] = [], projects: VideoProject[] = []) => renderToStaticMarkup(
  <VideoProjectStudio
    projects={projects}
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
    expect(html).toContain('AI 拆成分镜');
    expect(html).toContain('文稿</span>');
    expect(html).toContain('参考</span>');
    expect(html).toContain('设置</span>');
    expect(html).toContain('aria-current="location"');
    expect(html).toContain('还没有作品');
    expect(html).not.toContain('data-theme="light"');
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

    expect(html).toContain('最近作品');
    expect(html).toContain('0 个作品');
    expect(html).not.toContain('Failed task');
    expect(html).not.toContain('Cancelled task');
  });

  it('renders active legacy runs with a built-in cover and localized status', () => {
    const html = renderStudio([createRun('Rendering', { videoAssetUrl: 'https://cdn.example.com/output.mp4' })]);

    expect(html).toContain('最近作品');
    expect(html).toContain('1 个作品');
    expect(html).toContain('生成中');
    expect(html).toContain('镜头准备中');
    expect(html).toContain('视频作品');
    expect(html).not.toContain('/icon/backups/agent/video-agent.png');
    expect(html).not.toContain('<video');
    expect(html).not.toContain('output.mp4');
  });

  it('sanitizes malformed project titles before rendering recent cards', () => {
    const html = renderStudio([], [{
      id: 'project-1',
      appKey: 'video-agent',
      ownerAdminId: 'admin-1',
      title: '![](https://cdn.example.com/broken.jpg 文学视频项目',
      sourceMarkdown: '正文',
      styleDescription: '智能匹配',
      defaultVideoModel: 'doubao-seedance-1-5-pro-251215',
      defaultAspectRatio: '16:9',
      defaultResolution: '1080p',
      defaultDuration: 5,
      generateAudio: true,
      status: 'Draft',
      assets: [],
      timelineTracks: [],
      createdAt: '2026-07-14T00:00:00Z',
      updatedAt: '2026-07-14T00:00:00Z',
    }]);

    expect(html).toContain('文学视频项目');
    expect(html).not.toContain('broken.jpg');
  });
});
