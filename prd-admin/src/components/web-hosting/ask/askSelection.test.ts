import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveShareAskSelection, addAskPick, toggleAskPick, ASK_MAX_DISPLAY } from './askTypes';

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

/**
 * 展示上限是**跨语言重复的判据**（后端 AskOpeningQuestions.MaxDisplay 是 SSOT，
 * 前端为了在选的时候就挡住必须再写一份），所以给它钉一条守卫：
 * 值变了必须两边一起改，而不是某一边悄悄漂走，让用户挑了 6 条却只显示 4 条。
 */
describe('ASK_MAX_DISPLAY', () => {
  it('与后端 AskOpeningQuestions.MaxDisplay 对齐（改动必须同步两边）', () => {
    expect(ASK_MAX_DISPLAY).toBe(4);
  });

  it('必须小于题库上限，否则分享时无从挑选', () => {
    // 后端 MaxLibrary = 12；这里只断言"展示上限得留出挑选空间"
    expect(ASK_MAX_DISPLAY).toBeLessThan(12);
  });
});

/**
 * 上限判据必须只有一处。
 *
 * 第四轮 review 修上限时，我只给「点题库标签」那一处加了判断，漏掉了自定义输入回车、
 * 自定义输入点按钮、以及按题库初始预勾——UI 能显示 5 条以上，后端只存 4 条，
 * 分享出去多余的就没了。这正是 predicate-and-wiring-discipline 形状 3（判据分裂后各自漂移）。
 * 现在四处都走 addAskPick / toggleAskPick，这组用例锁住它。
 */
describe('addAskPick / toggleAskPick', () => {
  const full = ['一', '二', '三', '四'];

  it('没满时正常追加', () => {
    expect(addAskPick(['一'], '二')).toEqual(['一', '二']);
  });

  it('满了就不再追加', () => {
    expect(addAskPick(full, '五')).toEqual(full);
    expect(addAskPick(full, '五')).toHaveLength(ASK_MAX_DISPLAY);
  });

  it('重复的不追加，也不因此挤掉别的', () => {
    expect(addAskPick(['一', '二'], '一')).toEqual(['一', '二']);
  });

  it('空白输入不追加', () => {
    expect(addAskPick(['一'], '   ')).toEqual(['一']);
  });

  it('追加时去掉首尾空白，避免"看着一样"的重复项', () => {
    expect(addAskPick(['一'], '  二  ')).toEqual(['一', '二']);
    expect(addAskPick(['一'], '  一  ')).toEqual(['一']);
  });

  it('取消永远允许——满了也能取消', () => {
    expect(toggleAskPick(full, '二')).toEqual(['一', '三', '四']);
  });

  it('满了再点未选中的，不产生变化', () => {
    expect(toggleAskPick(full, '五')).toEqual(full);
  });

  it('取消一条之后又能加一条', () => {
    const afterRemove = toggleAskPick(full, '一');
    expect(addAskPick(afterRemove, '五')).toEqual(['二', '三', '四', '五']);
  });
});

/**
 * 完成后的答案必须真的按 markdown 渲染。
 *
 * 由 review 第一轮（#1358）抓出：`StreamingText` 的最终 markdown 视图要求
 * `markdown` **和** `renderMarkdown` 同时给到（`showFinalMarkdown = markdown && !streaming && !!renderMarkdown`），
 * 只传 `markdown` 会静默退回纯文本，`**加粗**`、列表、链接以原始语法裸露在气泡里。
 *
 * 这条接线删掉之后没有任何行为测试会红——它是形状 2（建了一半的接线），
 * 所以按源码守住：AskPanel 里的 StreamingText 必须带 renderMarkdown。
 */
describe('提问答案的 markdown 接线', () => {
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'AskPanel.tsx'),
    'utf8',
  );

  it('StreamingText 必须同时给 markdown 与 renderMarkdown', () => {
    const call = source.slice(source.indexOf('<StreamingText'));
    const end = call.indexOf('/>');
    expect(end).toBeGreaterThan(-1);
    const props = call.slice(0, end);
    expect(props).toMatch(/\bmarkdown\b/);
    expect(props).toMatch(/renderMarkdown=/);
  });

  it('渲染器不放行原始 HTML —— 答案的输入里有用户上传的网页正文，等于间接可控', () => {
    const md = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'AskMarkdown.tsx'),
      'utf8',
    );
    expect(md).toContain('rehypeSanitize');
    expect(md).not.toMatch(/rehypePlugins=\{\[[^\]]*rehypeRaw/);
  });
});
