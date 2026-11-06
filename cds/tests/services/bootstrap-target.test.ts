import { describe, expect, it } from 'vitest';
import { bootstrapRepository, bootstrapTarget } from '../../src/services/bootstrap-target.js';

describe('建项目仓库身份绑定', () => {
  it.each(['ssh://git@ssh.github.com:443/acme/demo.git', 'http://gitbox:443/acme/demo',
    'ssh://git@gitbox:80/acme/demo', 'https://gitbox:8443/acme/demo',
    'https://github.com:443/acme/demo', 'ssh://git@github.com:22/acme/demo'])('规范仓库身份再次校验保持幂等：%s', value => {
    const requested = bootstrapTarget({ name: 'Demo', repository: value });
    expect(requested).not.toBeNull();
    expect(bootstrapTarget(requested)).toEqual(requested);
  });

  it('同一 GitHub 仓库的 HTTPS、SSH、大小写和 .git 等价且不存凭据', () => {
    for (const value of ['https://github.com/Acme/Demo.git', 'git@github.com:acme/demo',
      'ssh://git@github.com:22/ACME/demo.git', 'https://user:secret@github.com/acme/demo?token=secret#fragment']) {
      expect(bootstrapRepository(value)).toBe('github.com/acme/demo');
    }
  });
  it('主机和自定义端口不能丢掉，非法仓库不接受', () => {
    expect(bootstrapRepository('https://gitlab.com/acme/demo')).not.toBe(bootstrapRepository('https://github.com/acme/demo'));
    for (const value of ['', 'file:///tmp/demo', 'https://github.com/acme',
      'https://github.com/acme/%2Fdemo']) {
      expect(bootstrapRepository(value)).toBeNull();
    }
    expect(bootstrapRepository('ssh://git@gitbox:2222/acme/demo')).toBe('gitbox:2222/acme/demo');
    expect(bootstrapRepository('http://github.com:22/acme/demo')).not.toBe('github.com/acme/demo');
    expect(bootstrapTarget({ name: '   ', repository: 'https://github.com/acme/demo' })).toBeNull();
  });
});
