/**
 * 保存之后，同仓横幅不许凭空消失。
 *
 * 各个保存接口回的是裸 Project / toSummary，没有 `repoSharing`（那是 GET 才做的
 * 富化）。直接拿它整体替换页面状态，横幅就会在保存成功的那一刻消失，直到用户手动
 * 刷新——而绑仓库那条更糟：正是「这一刻该出现横幅」的操作把横幅弄没了
 * （2026-09-02 Codex P2）。
 *
 * 判据是合并算得对，不是「代码写在那儿」，所以这里直接断言那个纯函数。
 */

import { describe, expect, it } from 'vitest';
import { preserveRepoSharing } from '../../web/src/pages/ProjectSettingsPage.js';
import type { ProjectSummary } from '../../web/src/types/project.js';

const SHARING = {
  total: 2,
  unscoped: 1,
  headline: '同一个仓库下有 2 个项目',
  level: 'warn' as const,
  sharedInfra: [],
  siblings: [{ id: 'p1', name: 'MAP', scope: [] }],
};

function proj(over: Partial<ProjectSummary> = {}): ProjectSummary {
  return { id: 'p1', slug: 'p1', name: 'MAP', kind: 'git', createdAt: '', updatedAt: '', ...over } as ProjectSummary;
}

describe('保存响应不许把 repoSharing 弄丢', () => {
  it('新对象没带富化字段时，留住上一次的值', () => {
    const prev = proj({ repoSharing: SHARING });
    const merged = preserveRepoSharing(prev, proj({ name: '改了名' }));
    expect(merged.name).toBe('改了名');
    expect(merged.repoSharing).toEqual(SHARING);
  });

  it('新对象自己带了就以它为准，不拿旧的盖新的', () => {
    const next = proj({ repoSharing: { ...SHARING, total: 3 } });
    expect(preserveRepoSharing(proj({ repoSharing: SHARING }), next).repoSharing?.total).toBe(3);
  });

  it('换了项目就整体以新的为准 —— 别把上一个项目的同仓事实带过去', () => {
    const merged = preserveRepoSharing(proj({ repoSharing: SHARING }), proj({ id: 'p2' }));
    expect(merged.repoSharing).toBeUndefined();
  });

  it('没有上一份状态时原样返回', () => {
    expect(preserveRepoSharing(null, proj()).repoSharing).toBeUndefined();
  });
});
