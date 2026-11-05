// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { VideoProjectStudio } from './VideoProjectStudio';

describe('视频模型恢复选择', () => {
  it.each([true, false])('恢复资格为 %s 时遵守服务端资格并保持健康状态语义', async (eligible) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(
        <VideoProjectStudio projects={[]} project={null} runs={[]} models={[{
          id: 'recovery-video', name: '恢复视频', healthStatus: 'Unavailable',
          isRecoveryProbeAvailable: eligible, supportsAudio: false, supportsFirstFrame: true,
          supportsLastFrame: false, supportsReferenceAssets: false, aspectRatios: ['16:9'],
          resolutions: ['720p'], durations: [5],
        }]} busy={false} onSelectProject={vi.fn()} onNewProject={vi.fn()}
          onSave={vi.fn(async () => null)} onAnalyze={vi.fn(async () => undefined)}
          onCreateDirect={vi.fn(async () => undefined)} onOpenRun={vi.fn()} onOpenDemo={vi.fn()} />,
      ));
      const settings = [...container.querySelectorAll('button')].find(button => button.textContent === '设置');
      expect(settings).toBeTruthy();
      await act(async () => { settings!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      const option = container.querySelector<HTMLOptionElement>('option[value="recovery-video"]');
      expect(option).not.toBeNull();
      expect(option!.disabled).toBe(!eligible);
      expect(option!.textContent?.includes('恢复试探')).toBe(eligible);
      expect((option!.parentElement as HTMLSelectElement).value).toBe(eligible ? 'recovery-video' : '');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});
