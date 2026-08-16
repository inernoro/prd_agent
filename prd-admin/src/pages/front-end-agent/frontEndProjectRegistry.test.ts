import { describe, expect, it } from 'vitest';
import { parseFrontEndProjectRegistry } from './frontEndProjectRegistry';

describe('frontEndProjectRegistry', () => {
  it('loads a valid deployment-injected project catalog', () => {
    const projects = parseFrontEndProjectRegistry(JSON.stringify([
      { name: '示例项目', kind: 'admin', tech: 'React', codingUrl: 'https://code.example.test/repo', tags: ['后台'] },
    ]));

    expect(projects).toEqual([
      { name: '示例项目', kind: 'admin', tech: 'React', codingUrl: 'https://code.example.test/repo', tags: ['后台'] },
    ]);
  });

  it('fails closed when deployment data is absent or malformed', () => {
    expect(parseFrontEndProjectRegistry(undefined)).toEqual([]);
    expect(parseFrontEndProjectRegistry('{bad json')).toEqual([]);
    expect(parseFrontEndProjectRegistry(JSON.stringify([{ name: '缺字段' }]))).toEqual([]);
  });
});
