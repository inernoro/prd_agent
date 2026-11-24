import { describe, expect, it } from 'vitest';
import { resolveInitialReleaseProject, resolveReleaseProject } from '../../web/src/lib/releaseCenter';

const projects = [{ id: 'preview-demo' }, { id: 'snap-prd-agent' }];
const storage = (value: string | null) => ({ getItem: () => value }) as unknown as Storage;

describe('发布项目必须来自当前实例', () => {
  it('跨实例链接不能显示首项却继续拿原项目取数', () => {
    expect(resolveReleaseProject('prd-agent', projects)).toBe('');
    expect(resolveInitialReleaseProject(new URLSearchParams('project=prd-agent'), storage(null), projects)).toBe('');
  });

  it('过期记忆不换成别的项目，显式有效链接优先于记忆', () => {
    expect(resolveInitialReleaseProject(new URLSearchParams(), storage('deleted-project'), projects)).toBe('');
    expect(resolveInitialReleaseProject(new URLSearchParams('project=snap-prd-agent'), storage('deleted-project'), projects)).toBe('snap-prd-agent');
  });

  it('首次进入可选择当前实例默认项目，空项目列表保持未选择', () => {
    expect(resolveInitialReleaseProject(new URLSearchParams(), storage(null), projects)).toBe('preview-demo');
    expect(resolveInitialReleaseProject(new URLSearchParams(), storage(null), [{ id: 'other' }, { id: 'prd-agent' }])).toBe('prd-agent');
    expect(resolveInitialReleaseProject(new URLSearchParams(), storage(null), [])).toBe('');
  });
});
