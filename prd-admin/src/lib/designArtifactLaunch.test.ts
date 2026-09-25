import { describe, expect, it } from 'vitest';
import {
  MAX_LAUNCH_REQUEST_CHARS,
  buildDesignArtifactLaunchPath,
  parseDesignArtifactLaunch,
  readLaunchRequest,
  stashLaunchRequest,
} from './designArtifactLaunch';

describe('designArtifactLaunch', () => {
  it('builds and parses a knowledge-to-web launch without losing Chinese titles', () => {
    const path = buildDesignArtifactLaunchPath({
      target: 'web-page',
      sourceStoreId: 'store-1',
      sourceEntryId: 'entry-2',
      sourceTitle: '产品发布说明',
      sourceStoreName: '产品知识库',
    });

    expect(path.startsWith('/web-pages?')).toBe(true);
    expect(parseDesignArtifactLaunch(path.slice(path.indexOf('?')))).toEqual({
      target: 'web-page',
      sourceStoreId: 'store-1',
      sourceEntryId: 'entry-2',
      sourceTitle: '产品发布说明',
      sourceStoreName: '产品知识库',
    });
  });

  it('carries only a short handoff id in the URL, never the request text', () => {
    const storage = new Map<string, string>();
    const store = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); } };
    const request = '讲给客户听 & 突出变化'.repeat(300);
    const handoffId = stashLaunchRequest(request, store, () => 'abc123def456');
    const path = buildDesignArtifactLaunchPath({
      target: 'html-ppt', sourceStoreId: 'store-1', sourceEntryId: 'entry-2', sourceTitle: '季度复盘', handoffId,
    });
    expect(path.startsWith('/md-to-ppt-agent?')).toBe(true);
    expect(path).not.toContain(encodeURIComponent('讲给客户听'));
    expect(path.length).toBeLessThan(300);
    const parsed = parseDesignArtifactLaunch(path.slice(path.indexOf('?')));
    expect(parsed?.handoffId).toBe('abc123def456');
    expect(readLaunchRequest('abc123def456', store)).toEqual({ status: 'ready', text: request.slice(0, MAX_LAUNCH_REQUEST_CHARS) });
  });

  it('skips the handoff for a blank request and ignores malformed ids from the URL', () => {
    expect(stashLaunchRequest('   ', null)).toBeUndefined();
    const parsed = parseDesignArtifactLaunch('?designTarget=html-ppt&sourceStore=s&sourceEntry=e&sourceTitle=t&handoff=../x');
    expect(parsed?.handoffId).toBeUndefined();
  });

  it('a storage write failure still yields an id, so the target page can say the request was lost', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    const id = stashLaunchRequest('做成宣讲 PPT', broken, () => 'deadbeef0001');
    expect(id).toBe('deadbeef0001');
    expect(readLaunchRequest('deadbeef0001', broken)).toEqual({ status: 'missing' });
  });

  it('rejects incomplete or unsupported launch context', () => {
    expect(parseDesignArtifactLaunch('?designTarget=video&sourceStore=a&sourceEntry=b&sourceTitle=c')).toBeNull();
    expect(parseDesignArtifactLaunch('?designTarget=html-ppt&sourceStore=a')).toBeNull();
  });
});
