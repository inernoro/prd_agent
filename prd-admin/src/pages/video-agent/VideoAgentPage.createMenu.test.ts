import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE_PATH = new URL('./VideoProjectStudio.tsx', import.meta.url);
const FORBIDDEN_GRAPHICAL_CHARACTER = /[\u2600-\u27BF]|\p{Extended_Pictographic}/u;

function readCreationModes(): string[] {
  const source = readFileSync(SOURCE_PATH, 'utf8');
  return [...source.matchAll(/<strong>(故事分镜|单镜直出)<\/strong>/g)]
    .map((match) => match[1]);
}

describe('VideoProjectStudio creation modes', () => {
  it('keeps mode labels as plain text beside the registered SVG icons', () => {
    const labels = readCreationModes();

    expect(labels).toEqual(['故事分镜', '单镜直出']);
    expect(labels.join('')).not.toMatch(FORBIDDEN_GRAPHICAL_CHARACTER);
  });
});
