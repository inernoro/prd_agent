import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { VersionRegistryApplication } from '@/services/real/versionRegistration';
import { VersionRegistrySelect } from './VersionRegistrationDialog';

const applications: VersionRegistryApplication[] = [
  { id: 'app-a', name: '应用甲', systemId: 'system-a', systemName: '系统甲', source: 'history_seed', createdAt: '', updatedAt: '' },
  { id: 'app-b', name: '应用乙', systemId: 'system-b', systemName: '系统乙', source: 'history_seed', createdAt: '', updatedAt: '' },
];

describe('版本号申领应用选择', () => {
  it('直接列出不同系统下的应用，不展示系统选择或系统名称', () => {
    const html = renderToStaticMarkup(
      <VersionRegistrySelect
        applications={applications}
        selectedApplicationId="app-a"
        suggestedApplication={applications[0]}
        onSelectApplication={() => {}}
        onOpenRegistry={() => {}}
      />,
    );

    expect(html).toContain('应用甲');
    expect(html).toContain('应用乙');
    expect(html).toContain('已从方案匹配到');
    expect(html).not.toContain('系统甲');
    expect(html).not.toContain('系统乙');
    expect(html).not.toContain('请选择系统');
    expect(html).not.toContain('系统和应用');
  });

  it('手动改选应用后不再提示旧方案匹配结果', () => {
    const html = renderToStaticMarkup(
      <VersionRegistrySelect
        applications={applications}
        selectedApplicationId="app-b"
        suggestedApplication={applications[0]}
        onSelectApplication={() => {}}
        onOpenRegistry={() => {}}
      />,
    );

    expect(html).not.toContain('已从方案匹配到');
  });
});
