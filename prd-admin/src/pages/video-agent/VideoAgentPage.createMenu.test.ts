import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE_PATH = new URL('./VideoAgentPage.tsx', import.meta.url);
const FORBIDDEN_GRAPHICAL_CHARACTER = /[\u2600-\u27BF]|\p{Extended_Pictographic}/u;

function readCreateMenuLabels(): string[] {
  const source = readFileSync(SOURCE_PATH, 'utf8');
  const start = source.indexOf('const CreateMenu');
  const end = source.indexOf('// ─── 作品列表');

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  return [...source.slice(start, end).matchAll(
    /className="text-xs font-semibold"[^>]*>([^<]+)<\/div>/g,
  )].map((match) => match[1].trim());
}

function readStoryboardStylePresetSource(): string {
  const source = readFileSync(SOURCE_PATH, 'utf8');
  const start = source.indexOf('const STYLE_PRESETS');
  const end = source.indexOf('const ACCEPT_TEXT');

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  return source.slice(start, end);
}

describe('VideoAgentPage create menu', () => {
  it('keeps mode labels as plain text beside the registered SVG icons', () => {
    const labels = readCreateMenuLabels();

    expect(labels).toEqual(['创作分镜（高级）', '大模型直出（初级）']);
    expect(labels.join('')).not.toMatch(FORBIDDEN_GRAPHICAL_CHARACTER);
  });

  it('keeps storyboard style presets as plain text', () => {
    const presetSource = readStoryboardStylePresetSource();
    const labels = [...presetSource.matchAll(/label: '([^']+)'/g)].map((match) => match[1]);

    expect(labels).toEqual([
      '电影级光影',
      '3D 卡通',
      '写实纪录片',
      '像素风',
      '水墨国风',
      '赛博朋克',
      '极简插画',
      '复古胶片',
    ]);
    expect(presetSource).not.toMatch(FORBIDDEN_GRAPHICAL_CHARACTER);
    expect(presetSource).not.toContain('emoji');
  });
});
