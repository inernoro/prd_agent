import { describe, expect, it } from 'vitest';
import { inferPresetTagKeys } from './modelPresetTags';

describe('GPT-5.6 model preset tags', () => {
  it.each(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])('识别 %s 的核心能力', (modelName) => {
    const tags = inferPresetTagKeys(modelName, modelName, 'openai', 'openai');

    expect(tags).toContain('reasoning');
    expect(tags).toContain('vision');
    expect(tags).toContain('function_calling');
    expect(tags).toContain('websearch');
  });
});
