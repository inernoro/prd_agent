import { describe, expect, it } from 'vitest';

import { parseSyntheticLoginFragment } from './SyntheticLoginPage';

describe('parseSyntheticLoginFragment', () => {
  it('从不会发送给服务器的 URL fragment 读取一次性码和站内返回路径', () => {
    expect(parseSyntheticLoginFragment(
      '#code=ticket_value&returnUrl=%2Fvisual-agent%3Ftab%3Drecent',
    )).toEqual({
      ticket: 'ticket_value',
      returnUrl: '/visual-agent?tab=recent',
    });
  });

  it('拒绝 fragment 中的站外返回地址', () => {
    expect(parseSyntheticLoginFragment('#code=ticket_value&returnUrl=https%3A%2F%2Fevil.example')).toEqual({
      ticket: 'ticket_value',
      returnUrl: '/',
    });
  });

  it('不再从 query 字符串读取一次性码', () => {
    expect(parseSyntheticLoginFragment('?code=leaked-in-query')).toEqual({
      ticket: '',
      returnUrl: '/',
    });
  });
});
