import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

const harness = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, mounted: false, api: vi.fn() }));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.values)) harness.values[index] = initial;
    return [harness.values[index], (next: unknown) => {
      harness.values[index] = typeof next === 'function' ? next(harness.values[index]) : next;
    }];
  },
  useEffect: (effect: () => void) => {
    if (!harness.mounted) { harness.mounted = true; effect(); }
  },
}));
vi.mock('@/lib/api', () => ({ apiRequest: harness.api }));
import { UserProjectAccessDialog } from '../../web/src/pages/cds-settings/components/UserProjectAccessDialog';

// 执行真实弹窗的事件处理器；仅替代 React 调度，避免引入 DOM 测试运行时。
type Node = ReactElement<Record<string, any>>;
function nodes(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Node;
  return [element, ...nodes(element.props.children)];
}
function text(value: ReactNode): string {
  if (Array.isArray(value)) return value.map(text).join('');
  if (value && typeof value === 'object' && 'props' in value) return text((value as Node).props.children);
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
const fixtures = [
  { id: 'project-a', name: '当前项目', repository: 'org/Keep', authorized: true, previouslyAuthorized: true },
  { id: 'project-b', name: '原来项目', repository: 'org/Original', authorized: false, previouslyAuthorized: true },
  { id: 'project-c', name: '全新项目', repository: 'org/New', authorized: false, previouslyAuthorized: false },
];
const user = { id: 'test-user', username: '验收用户' };
const onClose = vi.fn();
function render(): Node[] {
  harness.cursor = 0;
  return nodes(UserProjectAccessDialog({ user: user as any, onClose, onToast: vi.fn() }));
}
async function mount(projects: typeof fixtures | Array<{ id: string; name: string; authorized: boolean }> = fixtures): Promise<Node[]> {
  harness.api.mockResolvedValue({ userId: user.id, allProjects: false, projects });
  render();
  await Promise.resolve();
  return render();
}
function button(tree: Node[], name: string): Node {
  const result = tree.find(node => typeof node.props.onClick === 'function' && text(node).startsWith(name));
  if (!result) throw new Error(`找不到按钮 ${name}`);
  return result;
}
function checkboxes(tree: Node[]): Node[] { return tree.filter(node => node.type === 'input' && node.props.type === 'checkbox'); }
function search(tree: Node[], value: string): Node[] {
  tree.find(node => node.type === 'input' && node.props.type === 'search')!.props.onChange({ target: { value } });
  return render();
}

beforeEach(() => {
  harness.values = [];
  harness.cursor = 0;
  harness.mounted = false;
  harness.api.mockReset();
  onClose.mockReset();
});

describe('管理员定位原项目', () => {
  it('以名称、仓库和项目 ID 搜索，忽略大小写及首尾空白', async () => {
    let tree = await mount();
    expect(checkboxes(search(tree, ' 原来 '))).toHaveLength(1);
    tree = search(render(), ' ORG/original ');
    expect(checkboxes(tree)).toHaveLength(1);
    expect(text(tree)).toContain('原来项目');
    expect(checkboxes(search(tree, 'PROJECT-C'))).toHaveLength(1);
    expect(checkboxes(search(render(), '没有这个项目'))).toHaveLength(0);
    expect(render().some(node => node.props.title === '没有匹配的项目')).toBe(true);
  });

  it('定位原项目只筛选当前和历史授权，不自动恢复撤回权限', async () => {
    let tree = await mount();
    button(tree, '定位原项目').props.onClick();
    tree = render();
    expect(checkboxes(tree).map(node => node.props.checked)).toEqual([true, false]);
    expect(text(tree)).toContain('曾授权，当前已撤回');
    expect(text(tree)).not.toContain('全新项目');
    expect(button(tree, '定位原项目').props['aria-pressed']).toBe(true);
    await button(tree, '保存授权').props.onClick();
    expect(harness.api).toHaveBeenLastCalledWith('/api/auth/users/test-user/projects', { method: 'PUT', body: { projectIds: ['project-a'] } });
  });

  it('搜索后勾选另一项目并保存，保留当前过滤范围外的选择', async () => {
    let tree = await mount();
    tree = search(tree, 'org/Original');
    expect(text(tree)).toContain('另有 1 个已选项目在当前范围外');
    checkboxes(tree)[0].props.onChange({ target: { checked: true } });
    tree = search(render(), '不存在');
    expect(text(tree)).toContain('另有 2 个已选项目在当前范围外');
    button(tree, '定位原项目').props.onClick();
    tree = render();
    await button(tree, '保存授权').props.onClick();
    expect(harness.api).toHaveBeenLastCalledWith('/api/auth/users/test-user/projects', { method: 'PUT', body: { projectIds: ['project-a', 'project-b'] } });
  });

  it('缺少新字段时正常降级，切回全部项目保留未保存勾选', async () => {
    let tree = await mount(fixtures.map(({ id, name, authorized }) => ({ id, name, authorized })));
    button(tree, '定位原项目').props.onClick();
    tree = render();
    expect(checkboxes(tree)).toHaveLength(1);
    checkboxes(tree)[0].props.onChange({ target: { checked: false } });
    button(render(), '全部项目').props.onClick();
    tree = render();
    expect(checkboxes(tree)).toHaveLength(3);
    expect(checkboxes(tree).map(node => node.props.checked)).toEqual([false, false, false]);
    await button(tree, '保存授权').props.onClick();
    expect(harness.api).toHaveBeenLastCalledWith('/api/auth/users/test-user/projects', { method: 'PUT', body: { projectIds: [] } });
  });
});
