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

/**
 * 守卫：在途的**拉取**也要能被登出作废。
 *
 * 上一版只堵了保存那一侧。读这一侧的后果更重：A 打开藏书阁、GET 还在路上就登出，
 * 响应落地时把 A 的整份进度写回那个持久化的 store（登出清空已经跑完了），
 * B 登录先看到 A 的记录，一动手还会把 A 的快照 PUT 进 B 的账号。
 */
describe('藏书阁在途拉取的作废', () => {
  const src = fs.readFileSync(STORE, 'utf-8');

  it('loadFromServer 取了序号', () => {
    expect(
      /loadFromServer:\s*async[\s\S]{0,200}?\+\+loadSeq/.test(src),
      'loadFromServer 没有取 loadSeq：登出后落地的响应会把上一个人的进度写回来',
    ).toBe(true);
  });

  it('响应落地前比对过序号', () => {
    expect(
      src.includes('seq !== loadSeq'),
      '拿到响应后没有比对 loadSeq，作废机制等于没接上',
    ).toBe(true);
  });

  it('登出重置里把拉取那一侧也作废了', () => {
    const resetAt = src.indexOf('registerLogoutReset(');
    expect(resetAt).toBeGreaterThan(-1);
    expect(
      src.slice(resetAt).includes('loadSeq += 1'),
      '登出只作废了保存那一侧，在途的拉取仍会把上一个人的进度写回来',
    ).toBe(true);
  });
});
