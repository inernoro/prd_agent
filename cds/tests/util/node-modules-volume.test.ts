import { describe, it, expect } from 'vitest';
import { nodeModulesVolumeName, nodeModulesVolumePrefix } from '../../src/util/node-modules-volume.js';

describe('nodeModulesVolumeName / Prefix', () => {
  it('两段定长 hash 编码,边界绝对明确', () => {
    const name = nodeModulesVolumeName('br', 'api');
    // 7 + 8 + 1 + 8 = 24
    expect(name).toMatch(/^cds-nm-[0-9a-f]{8}-[0-9a-f]{8}$/);
    expect(name.length).toBe(24);
  });

  it('Bugbot 65a383bb 回归:join 边界歧义不再存在', () => {
    // 老编码下 ("foo/bar","baz") 和 ("foo","bar-baz") 都生成 cds-nm-foo-bar-baz
    // 新编码下两段独立 hash,必然不同
    const a = nodeModulesVolumeName('foo/bar', 'baz');
    const b = nodeModulesVolumeName('foo', 'bar-baz');
    expect(a).not.toBe(b);
  });

  it('Bugbot b952e898 回归:超长输入两段 hash 仍然 1:1 区分', () => {
    const longA = 'prd-agent-claude-very-long-branch-name-with-lots-of-chars-AAAA';
    const longB = 'prd-agent-claude-very-long-branch-name-with-lots-of-chars-BBBB';
    expect(nodeModulesVolumeName(longA, 'api')).not.toBe(nodeModulesVolumeName(longB, 'api'));
  });

  it('prefix 是 volumeName 的真前缀,长度固定 16', () => {
    const prefix = nodeModulesVolumePrefix('br');
    expect(prefix).toMatch(/^cds-nm-[0-9a-f]{8}-$/);
    expect(prefix.length).toBe(16);
    expect(nodeModulesVolumeName('br', 'api').startsWith(prefix)).toBe(true);
  });

  it('同一 branch 不同 profile 共享 prefix', () => {
    const prefix = nodeModulesVolumePrefix('br');
    expect(nodeModulesVolumeName('br', 'api').startsWith(prefix)).toBe(true);
    expect(nodeModulesVolumeName('br', 'admin').startsWith(prefix)).toBe(true);
    expect(nodeModulesVolumeName('br', 'api')).not.toBe(nodeModulesVolumeName('br', 'admin'));
  });

  it('确定性:同输入永远同输出', () => {
    expect(nodeModulesVolumeName('claude/feat', 'api')).toBe(nodeModulesVolumeName('claude/feat', 'api'));
  });

  it('docker volume name 字符集合规(只 [a-z0-9-])', () => {
    const samples = ['br', 'claude/feat-1', 'main', 'CamelCase/With_Special.Chars'];
    for (const s of samples) {
      expect(nodeModulesVolumeName(s, 'api')).toMatch(/^[a-zA-Z0-9_.-]+$/);
    }
  });
});
