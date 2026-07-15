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
    onCreateDirect={vi.fn(async () => undefined)}
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

const createProject = (overrides: Partial<VideoProject> = {}): VideoProject => ({
  id: 'project-1',
  appKey: 'prd-admin',
  ownerAdminId: 'admin-1',
  title: '雨夜街巷',
  status: 'Draft',
  sourceMarkdown: '',
  defaultAspectRatio: '16:9',
  defaultResolution: '1080p',
  defaultDuration: 5,
  generateAudio: true,
  assets: [],
  timelineTracks: [],
  createdAt: '2026-07-14T00:00:00Z',
  updatedAt: '2026-07-14T00:00:00Z',
  ...overrides,
});

describe('VideoProjectStudio', () => {
  it('opens on a focused literary creation flow instead of an editor console', () => {
    const html = renderStudio();

    expect(html).toContain('data-testid="video-project-studio"');
    expect(html).not.toContain('data-theme="light"');
    expect(html).toContain('aria-current="location"');
    expect(html).toContain('aria-label="文学稿内容"');
    expect(html).toContain('文学视频创作');
    expect(html).toContain('把故事变成镜头');
    expect(html).toContain('故事分镜');
    expect(html).toContain('单镜直出');
    expect(html).toContain('雨夜街巷的电影画面风格预览');
    expect(html).toContain('aria-label="镜头草图"');
    expect(html.match(/\/video-studio\/story-to-film-stage\.jpg/g)).toHaveLength(4);
    expect(html).toContain('生成故事分镜');
    expect(html).not.toContain('Seedance 1.5 Pro');
    expect(html).not.toContain('视频模型</span>');
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

    expect(html).toContain('还没有作品');
    expect(html).not.toContain('Failed task');
    expect(html).not.toContain('Cancelled task');
  });

  it('renders active legacy runs with a built-in cover and localized status', () => {
    const html = renderStudio([createRun('Rendering')]);

    expect(html).toContain('最近作品');
    expect(html).toContain('1 个作品');
    expect(html).toContain('生成中');
    expect(html).toContain('镜头准备中');
    expect(html).toContain('继续创作');
    expect(html).not.toContain('/icon/backups/agent/video-agent.png');
  });

  it('sanitizes malformed project titles before rendering recent work cards', () => {
    const html = renderStudio([], [createProject({ title: '![](' })]);

    expect(html).not.toContain('![](');
    expect(html).toContain('视频草稿');
  });

  it('does not preload generated videos in the recent work grid', () => {
    const html = renderStudio([createRun('Completed', { videoAssetUrl: 'https://media.example/video.mp4' })]);

    expect(html).toContain('视频已生成');
    expect(html).not.toContain('<video');
    expect(html).not.toContain('https://media.example/video.mp4');
  });
});
