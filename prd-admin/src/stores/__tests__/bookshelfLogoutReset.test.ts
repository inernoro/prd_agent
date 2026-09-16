import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 守卫：藏书阁进度必须在登出时清空。
 *
 * 这份进度持久化在 localStorage（`bookshelf-progress`），而 `authStore.logout()`
 * 只 `sessionStorage.clear()`——清不掉它。不清的后果是 A 登出、B 在同一台机器
 * 登录，B 先看到的是 A 的已读、笔记与考试成绩；若首次 GET 还没回来 B 就动了手，
 * A 的快照还会被 PUT 进 B 的账号。
 *
 * 判据见 `.claude/rules/no-localstorage.md`：服务器权威数据不进 localStorage。
 *
 * 为什么是源码扫描而不是行为测试：`registerLogoutReset` 是模块加载时的副作用，
 * 把这段删掉，store 照常工作、类型照常过、其它用例照常绿——没有任何东西会红。
 * 这正是 predicate-and-wiring-discipline 形状 2 说的「链路只建一半」，
 * 所以这里要的就是「那根线还在不在」。
 */

const STORE = path.resolve(__dirname, '../bookshelfStore.ts');

describe('藏书阁进度的登出清理', () => {
  const src = fs.readFileSync(STORE, 'utf-8');

  it('注册了登出重置', () => {
    expect(
      src.includes('registerLogoutReset('),
      '没有注册 registerLogoutReset：换账号后下一位用户会看到上一位的读书笔记与成绩',
    ).toBe(true);
  });

  it('登出时把三份数据都清掉', () => {
    const body = src.slice(src.indexOf('registerLogoutReset('));
    for (const field of ['readBookIds', 'bookNotes', 'examResults']) {
      expect(body.includes(field), `登出重置漏了 ${field}，它会跟着带进下一个账号`).toBe(true);
    }
  });

  /*
   * 防抖推送送的是「当前完整快照」。登出时不掐掉排着的那次，它会在换号之后触发，
   * 把上一位用户的数据 PUT 进新账号——和「看到别人的笔记」是同一个事故的两个入口。
   */
  it('登出时掐掉排着的那次防抖推送', () => {
    const body = src.slice(src.indexOf('registerLogoutReset('));
    expect(
      body.includes('clearTimeout(pushTimer)'),
      '登出没有清掉 pushTimer：排队中的那次 PUT 会把上一位用户的快照写进新账号',
    ).toBe(true);
  });
});
