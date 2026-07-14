import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE_PATH = new URL('./VideoProjectStudio.tsx', import.meta.url);
const FORBIDDEN_GRAPHICAL_CHARACTER = /[\u2600-\u27BF]|\p{Extended_Pictographic}/u;

function readStudioSource(): string {
  const source = readFileSync(SOURCE_PATH, 'utf8');
  expect(source).toContain('data-testid="video-project-studio"');
  return source;
}

describe('VideoProjectStudio actions', () => {
  it('keeps primary action labels as plain text beside Lucide icons', () => {
    const source = readStudioSource();
    const labels = ['新项目', '文稿', '参考', '设置', 'AI 拆成分镜'];

    labels.forEach((label) => expect(source).toContain(label));
    expect(labels.join('')).not.toMatch(FORBIDDEN_GRAPHICAL_CHARACTER);
  });
});
