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

  it('清 per-user 持久化数据的那段真的会在换人时跑到', () => {
    /*
     * 断言的是**行为**不是某个调用点：logout 早先直接调 clearUserScopedStorage()，
     * 后来收敛成共用的 runUserScopedCleanup()，写死调用点的判据会在重构时假红。
     * 这里只要求「共用函数里清了盘，且 logout 走了它」。
     */
    const fnAt = auth.indexOf('function runUserScopedCleanup()');
    expect(fnAt, '找不到 runUserScopedCleanup，守卫判据已过期，请修守卫').toBeGreaterThan(-1);
    expect(
      auth.slice(fnAt, fnAt + 1600).includes('clearUserScopedStorage()'),
      '共用清理里没有清盘：懒加载 store 没被求值时，上一个人的数据会留在盘上',
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

/**
 * 守卫：换号（不经过 logout）也要清。
 *
 * 跨账号串数据在这个 PR 里前后修了四次，每次都是「又发现一条没覆盖到的路径」：
 * 登出没清 → 在途保存没作废 → 在途拉取没作废 → 清理代码挂在懒加载模块上 →
 * 最后是这条：`/synthetic-login` 直接调 login() 换掉当前用户，根本不经过 logout。
 *
 * 所以判据不再是「logout 里有没有清」，而是**换人这件事有没有唯一的咽喉**。
 */
describe('换号路径的清理', () => {
  const auth = fs.readFileSync(AUTH_STORE, 'utf-8');

  it('清理逻辑收敛成一个函数，登出与换号共用', () => {
    expect(
      /function runUserScopedCleanup\(\)/.test(auth),
      '清理没有收成唯一入口：每条换人路径各写一份，必然又漏一条',
    ).toBe(true);
  });

  it('login 在用户变化时调用它', () => {
    const at = auth.indexOf('login: (user, token)');
    expect(at, '找不到 login，守卫判据已过期').toBeGreaterThan(-1);
    const body = auth.slice(at, at + 420);
    expect(
      body.includes('runUserScopedCleanup()'),
      'login 换掉另一个人时不清理：synthetic-login 这类不经过 logout 的入口会把上一个人的数据留给下一个人',
    ).toBe(true);
    expect(
      body.includes('userId'),
      'login 无条件清理会把同一个人续期时未推送的本地改动也抹掉——必须只在 userId 变化时清',
    ).toBe(true);
  });

  it('logout 也走同一个函数', () => {
    const at = auth.indexOf('logout: () => {');
    expect(at).toBeGreaterThan(-1);
    expect(auth.slice(at, at + 300).includes('runUserScopedCleanup()')).toBe(true);
  });
});
