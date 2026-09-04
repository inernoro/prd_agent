import { describe, expect, it } from 'vitest';
import { buildDesignArtifactLaunchPath, parseDesignArtifactLaunch } from './designArtifactLaunch';

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

  it('rejects incomplete or unsupported launch context', () => {
    expect(parseDesignArtifactLaunch('?designTarget=video&sourceStore=a&sourceEntry=b&sourceTitle=c')).toBeNull();
    expect(parseDesignArtifactLaunch('?designTarget=html-ppt&sourceStore=a')).toBeNull();
  });
});
