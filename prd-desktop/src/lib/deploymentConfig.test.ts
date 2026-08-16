import { describe, expect, it } from 'vitest';
import { parseDesktopPresetServers } from './deploymentConfig';

describe('parseDesktopPresetServers', () => {
  it('读取部署注入的服务器列表', () => {
    expect(parseDesktopPresetServers('[{"label":"正式环境","url":"https://map.example.test"}]'))
      .toEqual([{ label: '正式环境', url: 'https://map.example.test' }]);
  });

  it('拒绝无效或非 HTTP 地址', () => {
    expect(parseDesktopPresetServers('[{"label":"本机","url":"file:///tmp/api"}]')).toEqual([]);
    expect(parseDesktopPresetServers('not-json')).toEqual([]);
  });
});
