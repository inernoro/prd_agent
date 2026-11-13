// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { VideoGenRun, VideoTimelineTrack } from '@/services/contracts/videoAgent';
import { calculateVideoRunDuration, Timeline } from './VideoStoryboardEditor';

const run = { directDuration: 5, scenes: [
  { index: 0, topic: '第一镜', duration: 5, narration: { text: '第一句', durationSeconds: 2 } },
  { index: 1, topic: '第二镜', duration: 5 },
  { index: 2, topic: '第三镜', duration: 5, narration: { text: '第三句', durationSeconds: 3 } },
] } as VideoGenRun;
const render = (tracks: VideoTimelineTrack[] = [], sourceRun = run) => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<Timeline run={sourceRun} tracks={tracks} selectedSceneIndex={0}
    onSelect={vi.fn()} onReorder={vi.fn()} disabled={false} />);
  return host;
};
const card = (host: HTMLDivElement, text: string) => Array.from(host.querySelectorAll<HTMLDivElement>('.video-console__timeline-aux > div'))
  .find(item => item.querySelector('strong')?.textContent === text)!;

describe('制作台时间线与导出时序一致', () => {
  it('导入非整数秒镜头按匹配素材的精确时长排布，采用新版本后不复用旧素材时长', () => {
    const durations = [2.4, 5.2, 3.4];
    const imported = { ...run, scenes: run.scenes.map((scene, index) => ({
      ...scene, videoUrl: `/scene-${index}.mp4`, duration: Math.ceil(durations[index]),
    })) } as VideoGenRun;
    const tracks = [{ id: 'v', type: 'video', clips: durations.map((durationSeconds, sceneIndex) => ({
      id: `${sceneIndex}`, sceneIndex, durationSeconds, assetUrl: `/scene-${sceneIndex}.mp4`,
      startSeconds: 0, trimStartSeconds: 0, trimEndSeconds: 0,
    })) }] as VideoTimelineTrack[];
    const host = render(tracks, imported);
    expect(host.textContent).toContain('3 个镜头 · 11 秒');
    expect(calculateVideoRunDuration(imported, tracks)).toBe(11);
    expect(card(host, '第三句').textContent).toContain('7.60s');
    expect(parseFloat(card(host, '第三句').style.left)).toBeCloseTo(100 * 7.6 / 11);
    const replaced = { ...imported, scenes: imported.scenes.map((scene, index) =>
      index === 0 ? { ...scene, videoUrl: '/new-scene.mp4', duration: 4 } : scene) };
    expect(card(render(tracks, replaced), '第三句').textContent).toContain('9.20s');
  });
  it('单段不足一秒素材的顶部总时长和时间线保持真实长度', () => {
    const short = { ...run, scenes: [{ ...run.scenes[0], duration: 1, videoUrl: '/short.mp4' }] } as VideoGenRun;
    const tracks = [{ id: 'v', type: 'video', clips: [{
      id: '0', sceneIndex: 0, durationSeconds: 0.44, assetUrl: '/short.mp4',
      startSeconds: 0, trimStartSeconds: 0, trimEndSeconds: 0,
    }] }] as VideoTimelineTrack[];
    expect(calculateVideoRunDuration(short, tracks)).toBe(0.44);
    expect(render(tracks, short).textContent).toContain('1 个镜头 · 0.44 秒');
  });
  it('未配音镜头占用时间，第三镜字幕和配音从 10 秒开始', () => {
    const host = render();
    expect(parseFloat(card(host, '第三句').style.left)).toBeCloseTo(100 * 10 / 15);
    expect(parseFloat(card(host, '镜头 3 已采用配音').style.left)).toBeCloseTo(100 * 10 / 15);
    expect(parseFloat(card(host, '第三句').style.width)).toBeCloseTo(20);
    expect(card(host, '第三句').textContent).toContain('10.00s');
  });
  it('使用视频轨顺序和裁剪后长度，不用原镜头编号或 clip.startSeconds 推算', () => {
    const host = render([{ id: 'v', type: 'video', clips: [
      { id: 'a', sceneIndex: 2, startSeconds: 100, durationSeconds: 5, trimStartSeconds: 1, trimEndSeconds: 1 },
      { id: 'b', sceneIndex: 0, startSeconds: 200, durationSeconds: 5, trimStartSeconds: 0, trimEndSeconds: 1 },
    ] } as VideoTimelineTrack]);
    const clips = host.querySelectorAll<HTMLButtonElement>('.video-console__clip');
    expect(clips[0].textContent).toContain('第三镜');
    expect(parseFloat(clips[1].style.left)).toBeCloseTo(100 * 3 / 7);
    expect(card(host, '第三句').style.left).toBe('0%');
    expect(parseFloat(card(host, '第一句').style.left)).toBeCloseTo(100 * 3 / 7);
    expect(host.textContent).toContain('2 个镜头 · 7 秒');
  });
  it('字幕、配音、音乐的显式片段按开始时间排布，音频裁剪生效，重叠片段分行', () => {
    const tracks = (['subtitle', 'voice', 'music'] as const).map(type => ({ id: type, type, clips: [
      { id: 'manual', text: '手工字幕', assetUrl: '/manual.wav', startSeconds: 10, durationSeconds: 4, trimStartSeconds: 1, trimEndSeconds: 1 },
    ] } as VideoTimelineTrack));
    const host = render(tracks);
    const manual = card(host, '手工字幕');
    expect(parseFloat(manual.style.left)).toBeCloseTo(100 * 10 / 15);
    expect(parseFloat(manual.style.width)).toBeCloseTo(100 * 4 / 15);
    const audio = Array.from(host.querySelectorAll<HTMLDivElement>('.video-console__timeline-aux > div'))
      .filter(item => item.querySelector('strong')?.textContent === 'manual.wav');
    expect(audio).toHaveLength(2);
    for (const item of audio) expect(parseFloat(item.style.width)).toBeCloseTo(100 * 2 / 15);
    expect(manual.style.top).not.toBe(card(host, '第三句').style.top);
  });
});
