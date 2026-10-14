import { describe, expect, it } from 'vitest';
import { bootstrapRepository, bootstrapTarget } from '../../src/services/bootstrap-target.js';

describe('建项目仓库身份绑定', () => {
  it('同一 GitHub 仓库的 HTTPS、SSH、大小写和 .git 等价且不存凭据', () => {
    for (const value of ['https://github.com/Acme/Demo.git', 'git@github.com:acme/demo',
      'ssh://git@github.com:22/ACME/demo.git', 'https://user:secret@github.com/acme/demo?token=secret#fragment']) {
      expect(bootstrapRepository(value)).toBe('github.com/acme/demo');
    }
  });
  it('主机不能丢掉，异常仓库和非默认端口不接受', () => {
    expect(bootstrapRepository('https://gitlab.com/acme/demo')).not.toBe(bootstrapRepository('https://github.com/acme/demo'));
    for (const value of ['', 'file:///tmp/demo', 'https://github.com/acme',
      'https://github.com:2222/acme/demo', 'http://github.com:22/acme/demo', 'https://github.com/acme/%2Fdemo']) {
      expect(bootstrapRepository(value)).toBeNull();
    }
    expect(bootstrapTarget({ name: '   ', repository: 'https://github.com/acme/demo' })).toBeNull();
  });
});
