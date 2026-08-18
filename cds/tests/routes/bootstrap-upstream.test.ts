import { describe, expect, it } from 'vitest';
import { isDistinctCdsUpstream, resolveCdsSkillPackUpstream } from '../../src/routes/bootstrap.js';

describe('CDS 技能包上游隔离', () => {
  it('只接受与当前实例不同的显式上游', () => {
    expect(isDistinctCdsUpstream('https://cds.example.com', '')).toBe(false);
    expect(isDistinctCdsUpstream('https://cds.example.com', 'https://cds.example.com/')).toBe(false);
    expect(isDistinctCdsUpstream('https://cds.example.com', 'https://upstream.example.com')).toBe(true);
  });

  it('自指或缺失配置不生成回源请求，独立上游生成唯一下载地址', () => {
    expect(resolveCdsSkillPackUpstream('https://cds.example.com', '')).toBeNull();
    expect(resolveCdsSkillPackUpstream('https://cds.example.com', 'https://cds.example.com/')).toBeNull();
    expect(resolveCdsSkillPackUpstream('https://cds.example.com', 'https://upstream.example.com/'))
      .toBe('https://upstream.example.com/api/skills/cds-pack/download');
  });
});
