import { describe, expect, it } from 'vitest';

import { parseCurlCommand } from '../../web/src/lib/curl-import';

describe('parseCurlCommand', () => {
  it('imports a simple GET curl', () => {
    expect(parseCurlCommand('curl https://example.com/api/status')).toEqual({
      method: 'GET',
      url: 'https://example.com/api/status',
      headers: {},
      body: '',
    });
  });

  it('imports POST json with headers and body', () => {
    expect(parseCurlCommand(
      `curl -X POST 'https://example.com/api/sync' -H 'Content-Type: application/json' -H 'X-Token: abc' --data-raw '{"a":1}'`
    )).toEqual({
      method: 'POST',
      url: 'https://example.com/api/sync',
      headers: {
        'Content-Type': 'application/json',
        'X-Token': 'abc',
      },
      body: '{"a":1}',
    });
  });

  it('defaults to POST when data is present', () => {
    const imported = parseCurlCommand(`curl 'https://example.com/api/sync' -d 'a=1' -d 'b=2'`);
    expect(imported.method).toBe('POST');
    expect(imported.body).toBe('a=1&b=2');
  });

  it('imports multiline curl with --url', () => {
    const imported = parseCurlCommand(`curl \\
      --request PATCH \\
      --url 'https://example.com/api/item/1' \\
      --header 'Accept: application/json'`);
    expect(imported).toMatchObject({
      method: 'PATCH',
      url: 'https://example.com/api/item/1',
      headers: { Accept: 'application/json' },
    });
  });

  it('imports compact short options', () => {
    const imported = parseCurlCommand(`curl -XPUT -H'Content-Type: application/json' -d'{"ok":true}' https://example.com/api/item`);
    expect(imported.method).toBe('PUT');
    expect(imported.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(imported.body).toBe('{"ok":true}');
  });

  it('rejects unsupported methods and missing urls', () => {
    expect(() => parseCurlCommand('curl -X OPTIONS https://example.com')).toThrow('暂不支持 OPTIONS 方法');
    expect(() => parseCurlCommand('curl -H "Accept: application/json"')).toThrow('curl 命令里没有 URL');
  });
});
