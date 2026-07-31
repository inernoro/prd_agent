import { describe, expect, it } from 'vitest';

import { DEFAULT_SSH_PORT, parseSshTarget, suggestHostName } from '../../web/src/lib/sshTarget';

describe('parseSshTarget', () => {
  it('认得 ssh:// 形态', () => {
    expect(parseSshTarget('ssh://root@1.2.3.4:2222')).toEqual({ host: '1.2.3.4', port: 2222, user: 'root' });
  });

  it('认得 ssh 命令行 + -p 端口', () => {
    expect(parseSshTarget('ssh root@map.ebcone.net -p 2222')).toEqual({
      host: 'map.ebcone.net', port: 2222, user: 'root',
    });
  });

  it('认得 -p 紧贴数字的写法', () => {
    expect(parseSshTarget('ssh deploy@10.0.0.5 -p2222')).toEqual({
      host: '10.0.0.5', port: 2222, user: 'deploy',
    });
  });

  it('认得 user@host:port', () => {
    expect(parseSshTarget('root@map.ebcone.net:22')).toEqual({
      host: 'map.ebcone.net', port: 22, user: 'root',
    });
  });

  it('缺端口时回落 22', () => {
    expect(parseSshTarget('root@map.ebcone.net')).toEqual({
      host: 'map.ebcone.net', port: DEFAULT_SSH_PORT, user: 'root',
    });
  });

  it('缺用户名时只给主机与端口', () => {
    expect(parseSshTarget('map.ebcone.net:2222')).toEqual({
      host: 'map.ebcone.net', port: 2222, user: undefined,
    });
  });

  it('-p 与 :port 同时出现时以 -p 为准（ssh 命令的真实语义）', () => {
    expect(parseSshTarget('ssh root@host.example:22 -p 2222')?.port).toBe(2222);
  });

  it('IPv6 带方括号时脱括号并取端口', () => {
    expect(parseSshTarget('root@[fe80::1]:2222')).toEqual({ host: 'fe80::1', port: 2222, user: 'root' });
  });

  it('裸 IPv6 不把地址里的冒号误当端口', () => {
    // 这是「判据太窄」的典型反面：按单个冒号拆端口会把 fe80::1 切成 host=fe80: port=NaN
    expect(parseSshTarget('fe80::1')).toEqual({ host: 'fe80::1', port: DEFAULT_SSH_PORT, user: undefined });
  });

  it('端口不是数字时整串当主机名，不静默丢掉后半段', () => {
    expect(parseSshTarget('host.example:abc')).toEqual({
      host: 'host.example:abc', port: DEFAULT_SSH_PORT, user: undefined,
    });
  });

  it('端口越界按无端口处理', () => {
    expect(parseSshTarget('host.example:70000')?.port).toBe(DEFAULT_SSH_PORT);
  });

  it('URL 形态的路径与查询被截断', () => {
    expect(parseSshTarget('ssh://root@host.example:2222/var/www?x=1')).toEqual({
      host: 'host.example', port: 2222, user: 'root',
    });
  });

  it('空串与纯空白返回 null（表单保持用户已敲的内容）', () => {
    expect(parseSshTarget('')).toBeNull();
    expect(parseSshTarget('   ')).toBeNull();
  });

  it('非法主机名返回 null 而不是造一个出来', () => {
    expect(parseSshTarget('root@'))
      .toBeNull();
    expect(parseSshTarget('ssh://')).toBeNull();
  });
});

describe('suggestHostName', () => {
  it('域名取最有辨识度的第一段', () => {
    expect(suggestHostName('map.ebcone.net')).toBe('map');
  });

  it('IP 原样保留', () => {
    expect(suggestHostName('10.0.0.5')).toBe('10.0.0.5');
  });

  it('IPv6 原样保留', () => {
    expect(suggestHostName('fe80::1')).toBe('fe80::1');
  });

  it('空串返回空串', () => {
    expect(suggestHostName('  ')).toBe('');
  });
});
