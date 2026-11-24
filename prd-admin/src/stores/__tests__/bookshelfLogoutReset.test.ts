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

/**
 * 守卫：本地有没推上去的改动时，不许拿服务端那份整份盖掉。
 *
 * 真实路径：断网标了几本已读 → PUT 失败 → 关掉页面 → 联网后重进。
 * 持久化把数据读了回来，但 syncState 不持久化、会重置成 local，
 * 于是 loadFromServer 照常替换——那几本在用户眼前消失，一次提示都没有。
 */
describe('未同步的本地改动', () => {
  const src = fs.readFileSync(STORE, 'utf-8');

  it('dirty 被持久化（syncState 不持久化，救不了这条路径）', () => {
    expect(
      /partialize:[\s\S]{0,200}?dirty: s\.dirty/.test(src),
      'dirty 没进 partialize：关掉页面再回来就不知道有没有没推上去的改动',
    ).toBe(true);
  });

  it('任何改动都会置 dirty', () => {
    expect(
      /function schedulePush\(\)\s*\{[\s\S]{0,120}?set\(\{ dirty: true \}\)/.test(src),
      'schedulePush 没有置 dirty：改了却不算脏，守卫等于没接上',
    ).toBe(true);
  });

  it('loadFromServer 在 dirty 时先推不覆盖', () => {
    const load = src.slice(src.indexOf('loadFromServer:'));
    const guard = load.indexOf('get().dirty');
    const replace = load.indexOf('set({\n              readBookIds:');
    expect(guard, 'loadFromServer 没有检查 dirty').toBeGreaterThan(-1);
    expect(
      replace === -1 || guard < replace,
      'dirty 的判断排在整份替换之后，挡不住数据被盖掉',
    ).toBe(true);
  });
});

/**
 * 守卫：联网恢复时的补推判据要看 dirty，不能只看 syncState。
 *
 * syncState 不持久化——断网时关掉页面再打开，它重置成 'local'，而那份没推上去的
 * 数据还在盘上。只认 'failed' 的话这条路径下的 online 事件被忽略，那些改动永远
 * 推不上去，而「本地」那个态界面上还不给重试按钮。
 */
describe('联网恢复后的补推', () => {
  const src = fs.readFileSync(STORE, 'utf-8');

  it('online 处理器看 dirty，不只看 syncState', () => {
    const at = src.indexOf("addEventListener('online'");
    expect(at, '找不到 online 处理器，守卫判据已过期').toBeGreaterThan(-1);
    const body = src.slice(at, at + 220);
    expect(
      body.includes('dirty'),
      'online 只认 syncState：断网重载后 syncState 被重置成 local，那些改动永远推不上去',
    ).toBe(true);
  });
});
