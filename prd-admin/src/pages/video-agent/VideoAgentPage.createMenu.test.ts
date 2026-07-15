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

describe('VideoAgentPage create menu', () => {
  it('keeps mode labels as plain text beside the registered SVG icons', () => {
    const labels = readCreateMenuLabels();

    expect(labels).toEqual(['创作分镜（高级）', '大模型直出（初级）']);
    expect(labels.join('')).not.toMatch(FORBIDDEN_GRAPHICAL_CHARACTER);
  });
});
