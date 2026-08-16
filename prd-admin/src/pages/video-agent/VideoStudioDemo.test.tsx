import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { VideoGenRun } from '@/services/contracts/videoAgent';
import {
  calculateVideoRunSpentCost,
  formatVideoSceneError,
  getStoryboardExperienceState,
  markVideoSceneSubmitting,
  playVideoSafely,
  shouldKeepVideoRunPolling,
} from './VideoStoryboardEditor';
import { VideoStudioDemo } from './VideoStudioDemo';

const videoConsoleCss = readFileSync(new URL('./videoConsole.css', import.meta.url), 'utf8');
const videoEditorSource = readFileSync(new URL('./VideoStoryboardEditor.tsx', import.meta.url), 'utf8');

const runWith = (
  status: string,
  currentPhase: string,
  scenes: VideoGenRun['scenes'] = [],
) => ({ status, currentPhase, scenes });

describe('VideoStudioDemo', () => {
  it('renders an interactive, system-adaptive creation sample without claiming a real generation', () => {
    const html = renderToStaticMarkup(<VideoStudioDemo onBack={vi.fn()} />);

    expect(html).toContain('data-testid="video-studio-demo"');
    expect(html).toContain('体验样片');
    expect(html).toContain('故事分镜');
    expect(html).toContain('镜头编辑');
    expect(html).toContain('这是交互 Demo，不会产生实际费用');
    expect(html).toContain('雨夜来信');
    expect(html).not.toContain('data-theme="dark"');
  });

  it('keeps the mobile scene strip touchable instead of placing the viewer above it', () => {
    expect(videoConsoleCss).toContain('.video-demo__viewer-shade { position: absolute; inset: 0; pointer-events: none;');
    expect(videoConsoleCss).toContain('.video-demo__header { position: static; z-index: auto;');
    expect(videoConsoleCss).toContain('.video-demo__scenes { order: 0; }');
    expect(videoConsoleCss).toContain('.video-demo__canvas { order: 1; }');
  });

  it('keeps zero-scene generation in a visible progress experience and rejects terminal empty runs', () => {
    expect(getStoryboardExperienceState(runWith('Scripting', 'scripting'))).toBe('progress');
    expect(getStoryboardExperienceState(runWith('Rendering', 'analyzing-source'))).toBe('progress');
    expect(getStoryboardExperienceState(runWith('Editing', 'editing'))).toBe('empty-error');
    expect(getStoryboardExperienceState(runWith('Failed', 'failed'))).toBe('empty-error');
    expect(getStoryboardExperienceState(runWith('Editing', 'editing', [{ index: 0 }] as VideoGenRun['scenes']))).toBe('editor');
  });

  it('turns unsupported duration errors into an actionable retry message', () => {
    expect(formatVideoSceneError('Duration 6s is not supported for this model. Supported durations: 5, 10s'))
      .toContain('请改用支持的时长后重试');
  });

  it('keeps polling during the submission grace period even when the first reload is stale', () => {
    const staleRun = runWith('Editing', 'editing', [{ index: 0, status: 'Error' }] as VideoGenRun['scenes']);
    expect(shouldKeepVideoRunPolling(staleRun, 1_000, 46_000)).toBe(true);
    expect(shouldKeepVideoRunPolling(staleRun, 46_001, 46_000)).toBe(false);
  });

  it.each(['SubmittingClaimed', 'Polling', 'PollingClaimed'] as const)(
    'keeps polling while the server is in the %s recovery state',
    (status) => {
      const activeRun = runWith('Editing', 'editing', [{ index: 0, status }] as VideoGenRun['scenes']);
      expect(shouldKeepVideoRunPolling(activeRun, 60_000, 1_000)).toBe(true);
    },
  );

  it('reports all recorded generation versions instead of only the active scene cost', () => {
    const scenes = [
      {
        index: 0,
        status: 'Done',
        cost: 0.6,
        versions: [
          { id: 'v1', cost: 0.6 },
          { id: 'v2', cost: 0.6 },
          { id: 'v3', cost: 0.6 },
          { id: 'v4', cost: 0.6 },
        ],
      },
      { index: 1, status: 'Done', cost: 0.6, versions: [{ id: 'v5', cost: 0.6 }] },
      { index: 2, status: 'Draft', cost: 0.2, versions: [] },
    ] as VideoGenRun['scenes'];

    expect(calculateVideoRunSpentCost(scenes)).toBeCloseTo(3.2);
  });

  it('shows an optimistic rendering state immediately after a real generation click', () => {
    const staleRun = {
      ...runWith('Editing', 'editing', [{ index: 0, status: 'Error', errorMessage: '旧错误' }] as VideoGenRun['scenes']),
      id: 'run-1',
    } as VideoGenRun;
    const nextRun = markVideoSceneSubmitting(staleRun, 0);

    expect(nextRun.scenes[0].status).toBe('Submitting');
    expect(nextRun.scenes[0].errorMessage).toBeUndefined();
  });

  it('absorbs interrupted playback promises instead of creating an unhandled rejection', async () => {
    const interrupted = Object.assign(new Error('media was removed'), { name: 'AbortError' });
    const onFailure = vi.fn();
    const player = { play: vi.fn().mockRejectedValue(interrupted) };

    await expect(playVideoSafely(player, onFailure)).resolves.toBe(false);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('keeps one stable controllable player and does not preload every version thumbnail', () => {
    expect(videoEditorSource).not.toContain('key={previewUrl}');
    expect(videoEditorSource).toContain('controls\n                  playsInline');
    expect(videoEditorSource).not.toContain('<video src={version.videoUrl} muted preload="metadata" />');
    expect(videoEditorSource).toContain('title="预览这个版本"');
  });
});
