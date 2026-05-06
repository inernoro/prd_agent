import { describe, it, expect } from 'vitest';
import { nodeModulesVolumeName, nodeModulesVolumePrefix } from '../../src/util/node-modules-volume.js';

describe('nodeModulesVolumeName / Prefix', () => {
  it('短输入直接 sanitize,不加 hash', () => {
    expect(nodeModulesVolumeName('br', 'api')).toBe('cds-nm-br-api');
  });

  it('斜杠 / 大写 / 下划线被替换或保留', () => {
    expect(nodeModulesVolumeName('claude/feat_1', 'API')).toBe('cds-nm-claude-feat_1-API');
  });

  it('截断的输入加 sha1 短 hash 防碰撞', () => {
    const longA = 'prd-agent-claude-very-long-branch-name-with-lots-of-chars-AAAA';
    const longB = 'prd-agent-claude-very-long-branch-name-with-lots-of-chars-BBBB';
    const a = nodeModulesVolumeName(longA, 'api');
    const b = nodeModulesVolumeName(longB, 'api');
    // Bugbot b952e898:截断后必须不一致(否则删 A 会误吞 B 的 volume)
    expect(a).not.toBe(b);
  });

  it('prefix === volumeName 去掉 -profileId 后缀', () => {
    const name = nodeModulesVolumeName('br', 'api');
    const prefix = nodeModulesVolumePrefix('br');
    expect(name.startsWith(prefix)).toBe(true);
  });

  it('同一 branch 不同 profile 共享 prefix', () => {
    const a = nodeModulesVolumeName('br', 'api');
    const b = nodeModulesVolumeName('br', 'admin');
    const prefix = nodeModulesVolumePrefix('br');
    expect(a.startsWith(prefix)).toBe(true);
    expect(b.startsWith(prefix)).toBe(true);
    expect(a).not.toBe(b);
  });
});
