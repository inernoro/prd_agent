import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { USER_SCOPED_STORAGE_KEYS } from '../userScopedStorageKeys';

/**
 * 守卫：属于某个人的持久化数据，必须由**一定会被加载**的那一侧清掉。
 *
 * 藏书阁把同一个洞修到第三次才找对地方。前两次修的都是「登出时清 store」，
 * 而问题是那段清理代码本身挂在懒加载的 `bookshelfStore.ts` 上——
 * 没进过 /bookshelf 就等于没注册：
 *
 *   A 上次用过藏书阁 → 关浏览器 → 重开 → 在别的页面登出 → B 登录 → B 看到 A 的数据
 *
 * 所以判据不是「有没有 registerLogoutReset」（那条前两轮就有了，照样漏），
 * 而是「authStore 的 logout 里有没有一条不依赖任何 store 被求值的清理」。
 */

const REPO = path.resolve(__dirname, '../../..');
const AUTH_STORE = path.join(REPO, 'src/stores/authStore.ts');
const BOOKSHELF_STORE = path.join(REPO, 'src/stores/bookshelfStore.ts');

describe('per-user 持久化数据的登出清理', () => {
  const auth = fs.readFileSync(AUTH_STORE, 'utf-8');

  it('authStore 的 logout 里调了 clearUserScopedStorage', () => {
    const logoutAt = auth.indexOf('logout: () => {');
    expect(logoutAt, '找不到 logout，守卫判据已过期，请修守卫').toBeGreaterThan(-1);
    expect(
      auth.slice(logoutAt).includes('clearUserScopedStorage()'),
      'logout 没有清 per-user 持久化数据：懒加载 store 没被求值时，上一个人的数据会留在盘上',
    ).toBe(true);
  });

  it('清理是饿加载的：authStore 直接 import，不经过任何 store', () => {
    expect(
      /^import \{ clearUserScopedStorage \} from '@\/lib\/userScopedStorageKeys';$/m.test(auth),
      'clearUserScopedStorage 不是在 authStore 顶层 import 的——它必须与懒加载无关',
    ).toBe(true);
  });

  it('藏书阁的 persist 键取自同一张清单，不各写一个字符串', () => {
    const shelf = fs.readFileSync(BOOKSHELF_STORE, 'utf-8');
    expect(
      shelf.includes('USER_SCOPED_STORAGE_KEYS'),
      'bookshelfStore 自己手写了 persist name：清单与实际键一漂移，登出就清不掉了（形状 3）',
    ).toBe(true);
    expect(USER_SCOPED_STORAGE_KEYS).toContain('bookshelf-progress');
  });
});
