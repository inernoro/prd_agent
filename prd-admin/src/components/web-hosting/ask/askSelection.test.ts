import { describe, expect, it } from 'vitest';
import { resolveShareAskSelection } from './askTypes';

/**
 * 「分享时自选开场问题」的三态守卫（前端侧）。
 *
 * 后端有一条对称的守卫（AskOpeningQuestionsTests），两边守的是同一个契约的两端：
 * 前端决定**传不传这个字段**，后端决定**null 与空数组分别怎么解释**。
 * 任何一端塌成两态，用户都会看到"取消了全部开场问题、保存后又原样回来"。
 */
describe('分享链接的开场问题选择', () => {
  it('用户没碰过这一栏时不传字段，让链接继承站点题库', () => {
    // undefined 而不是 [] —— 传 [] 会被后端理解成"明确不要开场问题"
    expect(resolveShareAskSelection(false, ['站点题库一', '站点题库二'])).toBeUndefined();
  });

  it('用户清空全部选项时传空数组，而不是退化成"没选过"', () => {
    const result = resolveShareAskSelection(true, []);
    expect(result).toEqual([]);
    expect(result).not.toBeUndefined();
  });

  it('用户挑了几条时原样传出，顺序即展示顺序', () => {
    expect(resolveShareAskSelection(true, ['先问这个', '再问那个'])).toEqual([
      '先问这个',
      '再问那个',
    ]);
  });

  it('没碰过的判定与选项内容无关——空题库也照样是"继承"而非"清空"', () => {
    expect(resolveShareAskSelection(false, [])).toBeUndefined();
  });
});
