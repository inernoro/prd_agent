import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { VideoGenRun } from '@/services/contracts/videoAgent';
import { getStoryboardExperienceState } from './VideoStoryboardEditor';
import { VideoStudioDemo } from './VideoStudioDemo';

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

  it('keeps zero-scene generation in a visible progress experience and rejects terminal empty runs', () => {
    expect(getStoryboardExperienceState(runWith('Scripting', 'scripting'))).toBe('progress');
    expect(getStoryboardExperienceState(runWith('Rendering', 'analyzing-source'))).toBe('progress');
    expect(getStoryboardExperienceState(runWith('Editing', 'editing'))).toBe('empty-error');
    expect(getStoryboardExperienceState(runWith('Failed', 'failed'))).toBe('empty-error');
    expect(getStoryboardExperienceState(runWith('Editing', 'editing', [{ index: 0 }] as VideoGenRun['scenes']))).toBe('editor');
  });
});
