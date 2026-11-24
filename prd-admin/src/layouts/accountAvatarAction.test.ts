import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { isMenuKeyboardActivation, resolveAccountAvatarAction } from './accountAvatarAction';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const layoutSource = readFileSync(path.resolve(testDirectory, 'AppShell.tsx'), 'utf8');

describe('侧栏底部头像的点击语义', () => {
  it('菜单关着时，点头像是打开用户菜单', () => {
    expect(resolveAccountAvatarAction(false)).toBe('open-user-menu');
  });

  it('菜单开着时，再点一次头像才是修改头像', () => {
    expect(resolveAccountAvatarAction(true)).toBe('edit-avatar');
  });

  it('AppShell 的头像事件走的是这个唯一判定源（防止有人把语义又写回事件处理里）', () => {
    expect(layoutSource).toContain('resolveAccountAvatarAction(userMenuOpenRef.current)');
  });

  it('头像本身是用户菜单的触发器，且侧栏不再有独立的「···」入口', () => {
    // 触发器必须包着头像进度环，否则「点头像开菜单」这条诉求就掉了。
    expect(layoutSource).toMatch(
      /DropdownMenu\.Trigger asChild>\s*<button[\s\S]{0,1400}?<AvatarProgressRing/
    );
    // 「···」按钮（MoreHorizontal）已从侧栏移除，连 import 都不该留。
    expect(layoutSource).not.toContain('MoreHorizontal');
  });
});

describe('展开态用户名按钮的键盘可达性', () => {
  // 它从 DropdownMenu.Trigger 退回普通 button 时丢了 Trigger 自带的键盘激活。
  // Enter / Space 不发 pointerdown —— 只挂 onPointerDown 的按钮对键盘用户是死的。
  it('Enter 与 Space 算激活', () => {
    expect(isMenuKeyboardActivation('Enter')).toBe(true);
    expect(isMenuKeyboardActivation(' ')).toBe(true);
    expect(isMenuKeyboardActivation('Spacebar')).toBe(true);
  });

  it('普通字符与导航键不算激活', () => {
    for (const key of ['a', 'Tab', 'Escape', 'ArrowDown', 'Shift']) {
      expect(isMenuKeyboardActivation(key)).toBe(false);
    }
  });

  it('用户名按钮同时挂了 onPointerDown 和 onKeyDown（少一个就有一半用户点不动）', () => {
    const block = layoutSource.slice(
      layoutSource.indexOf('handleUserMenuTogglePointerDown}'),
      layoutSource.indexOf('handleUserMenuTogglePointerDown}') + 400,
    );
    expect(block).toContain('onKeyDown={handleUserMenuToggleKeyDown}');
    expect(block).toContain('aria-haspopup="menu"');
  });
});
