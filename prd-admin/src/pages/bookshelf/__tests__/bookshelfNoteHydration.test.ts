import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 守卫：笔记编辑框在 hydration 之前打开时，不能用空串把服务端那条删掉。
 *
 * 真实路径（手机档与桌面档各有一份，先只修了手机档那一份）：
 *   刚登录就打开编辑框（loadFromServer 还在路上，bookNotes 里没有这本书）
 *   → 草稿是空串 → hydration 落地 → 编辑框还是空的
 *   → 保存/失焦 → setNote(id, '') → 用户一个字没打，笔记没了
 *
 * 判据是「有没有跟随服务端 + 有没有区分用户是否编辑过」这两根线，
 * 两个档位都要有。只修一处正是本 PR 反复栽的那个形状（形状 2）。
 */

const PAGES = path.resolve(__dirname, '..');

const FILES = [
  { label: '桌面档', file: path.join(PAGES, 'BookshelfPage.tsx'), touched: 'noteDraftTouchedRef' },
  { label: '手机档', file: path.join(PAGES, 'mobile/MobileBook.tsx'), touched: 'draftTouchedRef' },
];

describe('笔记草稿跟随 hydration', () => {
  FILES.forEach(({ label, file, touched }) => {
    it(`${label}记录了用户是否编辑过草稿`, () => {
      const src = fs.readFileSync(file, 'utf-8');
      expect(
        src.includes(touched),
        `${label}没有「用户动过没有」这根线：无法区分「还没写」与「写了又清空」`,
      ).toBe(true);
    });

    it(`${label}在未编辑时跟随服务端那条`, () => {
      const src = fs.readFileSync(file, 'utf-8');
      expect(
        new RegExp(`${touched}\\.current`).test(src) && /useEffect\(/.test(src),
        `${label}没有跟随 hydration 的 effect：服务端已有的笔记会被空串覆盖删掉`,
      ).toBe(true);
    });
  });
});
