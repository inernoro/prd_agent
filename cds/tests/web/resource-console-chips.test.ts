import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { expectGuardRedOnMutation, mutate } from '../helpers/guard-mutation.js';

/**
 * 2026-09-01 用户截图三连：
 *   1. 资源 chip 横条被上下裁掉（"Java" 只剩半行，右上角小圆钮也被切）；
 *   2. 从分支卡片点数据库 chip，要先落到抽屉、再点一次「打开工作台」；
 *   3. 面板整体偏暗、层次糊在一起（用户选定方案 B：底色不动，靠分层拆开）。
 *
 * 三条都是「看一眼就知道坏、但没有任何测试会红」的类型，所以钉成源码守卫。
 */
const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readDrawer(): string {
  return fs.readFileSync(path.join(CDS_ROOT, 'web/src/components/BranchDetailDrawer.tsx'), 'utf8');
}

function readBranchList(): string {
  return fs.readFileSync(path.join(CDS_ROOT, 'web/src/pages/BranchListPage.tsx'), 'utf8');
}

describe('资源 chip 横条不许再被裁', () => {
  it('滚动容器有纵向留白，chip 高度随内容而不是钉死一行半', () => {
    const source = readDrawer();
    // overflow-x:auto 会把纵轴一并变成裁剪轴：留白是这里唯一能让 -top-1 小圆钮
    // 和 chip 两行文字都活下来的办法。
    expect(source).toContain('className="flex gap-3 overflow-x-auto px-1 pb-2 pt-2"');
    expect(source, 'chip 不该再是固定 h-10（两行内容塞不下）')
      .not.toContain('inline-flex h-10 min-w-[132px] shrink-0 items-center');
    expect(source).toContain('inline-flex min-h-[2.75rem] min-w-[132px] shrink-0 items-center');
  });

  it('红用例：把 chip 改回固定 h-10，守卫必须变红', () => {
    const real = readDrawer();
    const guard = (source: string) => {
      expect(source).toContain('inline-flex min-h-[2.75rem] min-w-[132px] shrink-0 items-center');
    };
    expectGuardRedOnMutation(
      guard,
      real,
      mutate(real, 'inline-flex min-h-[2.75rem] min-w-[132px] shrink-0 items-center', 'inline-flex h-10 min-w-[132px] shrink-0 items-center'),
    );
  });
});

describe('滑动提示：右边还有东西才盖渐变', () => {
  it('渐变按实测滚动位置出现，不是常驻', () => {
    const source = readDrawer();
    expect(source).toContain('const updateChipScrollHint = useCallback(');
    expect(source).toContain('el.scrollWidth - el.clientWidth');
    expect(source).toContain('{chipScrollHint.right ? (');
    expect(source).toContain('bg-gradient-to-l from-[hsl(var(--surface-sunken))] to-transparent');
    // 常驻渐变会在资源不多、根本不用滑时平白糊掉最后一个 chip
    expect(source).toContain('{chipScrollHint.left ? (');
  });

  it('渐变不吃点击', () => {
    const source = readDrawer();
    const at = source.indexOf('{chipScrollHint.right ? (');
    expect(at).toBeGreaterThan(-1);
    expect(source.slice(at, at + 400)).toContain('pointer-events-none');
  });

  it('红用例：把渐变改成常驻，守卫必须变红', () => {
    const real = readDrawer();
    const guard = (source: string) => {
      expect(source).toContain('{chipScrollHint.right ? (');
    };
    expectGuardRedOnMutation(guard, real, mutate(real, '{chipScrollHint.right ? (', '{true ? ('));
  });
});

describe('数据库 chip 一步直达工作台', () => {
  it('分支卡片点数据库资源时带上直达标记', () => {
    const source = readBranchList();
    expect(source).toContain("directWorkbench: resource.kind === 'database',");
    expect(source).toContain('resourceWorkbenchDirect={detailDrawerResourceFocus?.directWorkbench || false}');
  });

  it('直达进来时，关掉工作台一路退回分支列表', () => {
    const source = readDrawer();
    expect(source).toContain('onWorkbenchDismiss={resourceWorkbenchDirect ? onClose : undefined}');
    // 两个工作台弹窗（SQL / Mongo）的关闭都要接上，漏一个就把人留在中间那层抽屉里
    expect(source.split('onClose={() => { setWorkbenchOpen(false); onWorkbenchDismiss?.(); }}').length - 1).toBe(2);
  });

  it('红用例：拆掉直达回退，守卫必须变红', () => {
    const real = readDrawer();
    const guard = (source: string) => {
      expect(source).toContain('onWorkbenchDismiss={resourceWorkbenchDirect ? onClose : undefined}');
    };
    expectGuardRedOnMutation(
      guard,
      real,
      mutate(real, 'onWorkbenchDismiss={resourceWorkbenchDirect ? onClose : undefined}', 'onWorkbenchDismiss={undefined}'),
    );
  });
});

describe('方案 B 的分层落在 token 上，不是硬编码颜色', () => {
  it('chip 区走凹陷带、chip 走抬升层、分区标题带竖分隔', () => {
    const source = readDrawer();
    expect(source).toContain('bg-[hsl(var(--surface-sunken))]/60 px-4 py-3');
    expect(source).toContain('bg-[hsl(var(--surface-raised))] shadow-[inset_0_1px_0_hsl(0_0%_100%/.05)]');
    expect(source).toContain('border-r border-[hsl(var(--hairline-strong))] pr-3');
  });

  it('这一块没有引入任何暗色/浅色字面量（cds-theme-tokens 规则）', () => {
    const source = readDrawer();
    const at = source.indexOf('方案 B（2026-09-01 用户选定）');
    expect(at).toBeGreaterThan(-1);
    const block = source.slice(at, at + 3000);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(block).not.toMatch(/rgba?\(/);
  });
});
