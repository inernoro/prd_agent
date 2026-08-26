/**
 * 侧栏底部头像的点击语义（唯一判定源）。
 *
 * 侧栏底部原本有两个控件：头像（直接开「修改我的头像」）+「···」（开用户菜单）。
 * 现在「···」已移除，头像同时承担两件事，靠「菜单当前开没开」区分：
 *   - 菜单关着：这一次点击是「打开用户菜单」
 *   - 菜单开着：这一次点击才是「修改我的头像」
 *
 * 抽成函数是为了让这条语义有一个能变红的判据 —— 直接写在 AppShell 的事件处理里，
 * 删掉也没有任何测试会红。
 */
export type AccountAvatarAction = 'open-user-menu' | 'edit-avatar';

export function resolveAccountAvatarAction(userMenuOpen: boolean): AccountAvatarAction {
  return userMenuOpen ? 'edit-avatar' : 'open-user-menu';
}

/**
 * 键盘是不是在「激活」这个菜单按钮。
 *
 * 展开态的用户名按钮不再是 Radix 的 DropdownMenu.Trigger（一个 Root 只能有一个锚点，
 * 锚点归头像），因此也失去了 Trigger 自带的键盘激活。它只挂 onPointerDown，而键盘
 * 敲 Enter / Space **不会**触发 pointerdown —— 光靠指针处理，这个 aria-haspopup="menu"
 * 的按钮对键盘用户就是死的。所以显式补一条键盘判据。
 */
export function isMenuKeyboardActivation(key: string): boolean {
  return key === 'Enter' || key === ' ' || key === 'Spacebar';
}
