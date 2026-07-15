import { describe, expect, it } from 'vitest';
import type { VideoProject, VideoProjectInput } from '@/services/contracts/videoAgent';
import { buildDirectVideoRunInput } from './VideoAgentPage';

const project: VideoProject = {
  id: 'project-1',
  appKey: 'video-agent',
  ownerAdminId: 'user-1',
  title: '雨夜重逢',
  status: 'Draft',
  sourceMarkdown: '两个人在雨夜重逢。',
  defaultAspectRatio: '16:9',
  defaultResolution: '1080p',
  defaultDuration: 5,
  generateAudio: true,
  assets: [
    { id: 'audio-1', type: 'audio', name: '环境音', url: 'https://example.com/rain.mp3', createdAt: '2026-07-15T00:00:00Z' },
    { id: 'scene-1', type: 'scene', name: '雨夜街巷', url: 'https://example.com/rain.jpg', createdAt: '2026-07-15T00:00:00Z' },
  ],
  timelineTracks: [],
  createdAt: '2026-07-15T00:00:00Z',
  updatedAt: '2026-07-15T00:00:00Z',
};

describe('buildDirectVideoRunInput', () => {
  it('passes style, model controls and the first visual reference to direct generation', () => {
    const input: VideoProjectInput = {
      sourceMarkdown: '  两个人在雨夜重逢。  ',
      styleDescription: '电影叙事',
      defaultVideoModel: 'doubao-seedance-1-5-pro-251215',
      defaultAspectRatio: '16:9',
      defaultResolution: '1080p',
      defaultDuration: 10,
      generateAudio: true,
    };

    expect(buildDirectVideoRunInput(project, input)).toEqual({
      projectId: 'project-1',
      mode: 'direct',
      articleTitle: '雨夜重逢',
      directPrompt: '两个人在雨夜重逢。\n视觉风格：电影叙事',
      directVideoModel: 'doubao-seedance-1-5-pro-251215',
      directAspectRatio: '16:9',
      directResolution: '1080p',
      directDuration: 10,
      generateAudio: true,
      directFirstFrameUrl: 'https://example.com/rain.jpg',
    });
  });
});
