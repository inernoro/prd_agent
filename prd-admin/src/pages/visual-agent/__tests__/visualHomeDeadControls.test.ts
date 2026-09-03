import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 视觉创作首页：看着能点的东西必须真的能点。
 *
 * 这一批守的不是样式，是**假控件**——长得像控件、也确实是 <button>、
 * 鼠标移上去还有 hover，但点下去没有任何事情发生。编译、类型、lint、
 * 全量测试全绿，只有真人点一下才发现。审这一页时一次抓到三个：
 *
 *   1. 预设行第一格 MAP Pro —— onClick 写着 if (!tag.isPro)，它永远进不去；
 *      就算进去了，onTagSelect 第一行还有个 if (!prompt) return 等着（同一条链
 *      断了两处，典型的「修了第一处不修第二处」）。而它是六格里默认高亮的那一格。
 *   2. 顶栏「创作」—— 一个 padding 3 / radius 8 的分段控件外壳里只装了一个
 *      不可点的 span，没有第二项可切。
 *   3. 左侧浮动条的「新建项目」—— 页面第三个同名入口，贴着视口左缘、没有文字。
 *
 * 判据一律盯**源码形状**而不是某个数值：这些东西不会因为数值漂移复发，
 * 只会因为有人「顺手加个占位」复发。
 */

const ROOT = resolve(__dirname, '../../../..');
const read = (relative: string) => readFileSync(resolve(ROOT, relative), 'utf8');

/* 注释里出现的字面量不算数——本仓库已经被自己的说明文字喂绿过四次。 */
/**
 * 剥注释。
 *
 * 块注释的正则必须钉住**行首**：这一页有 accept="image/*"，那个 MIME 通配符里的 /*
 * 会被当成注释开头，一路吃到下一个 * 斜杠为止——实测吃掉了 5700 个字符，
 * 把 SCENARIO_TAGS.map 和 const hasCover 整段吞掉，判据于是对着空串断言。
 * （这正是本仓库反复写守卫在防的那类错：判据本身的谓词太天真。）
 */
const strip = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^[ \t]*\/\/[^\n]*/gm, '');

const PAGE = 'src/pages/visual-agent/VisualAgentWorkspaceListPage.tsx';
const BACKDROP_PANEL = 'src/components/visual-agent/BackdropSettings.tsx';

describe('预设行六格都能点', () => {
  const page = strip(read(PAGE));

  it('点击处理器不按格子分叉——不许有哪一格进不去', () => {
    const tags = page.slice(page.indexOf('SCENARIO_TAGS.map'), page.indexOf('function ProjectCard('));
    expect(tags).toContain('onClick={() => onSelect(tag.prompt)}');
    expect(tags).not.toMatch(/onClick=\{\(\)\s*=>\s*\{?\s*if\s*\(!?tag\.isPro/);
    // 剥完注释还剩真代码，否则上面两条是在对空串断言。
    expect(tags).toContain('tag.label');
  });

  it('onTagSelect 不吞空 prompt——MAP Pro 的 prompt 本来就是空串', () => {
    const fn = page.slice(page.indexOf('const onTagSelect'), page.indexOf('const onImageSelect'));
    expect(fn).toContain('setInputValue(prompt)');
    expect(fn).not.toMatch(/if\s*\(!prompt\)\s*return/);
  });

  it('选完预设把光标送进输入框——否则「清空」在本来就空时是一次零反馈的点击', () => {
    expect(page).toContain('promptRef');
    expect(page).toContain('inputRef={promptRef}');
    // 接线的另一头：QuickInputBox 真的把 ref 挂到了 textarea 上。
    expect(page).toContain('if (inputRef) inputRef.current = el;');
  });
});

describe('看着能点的必须能点', () => {
  it('输入框里那个虚线空槽是真按钮，点了会开文件选择器', () => {
    // 它长得完完全全像一个上传区（虚线框 + 图片图标 + 一句「拖到这里」），
    // 用户第一反应就是点它。第一版给它挂了 pointer-events-none，
    // 理由是「它只是个提示」——那就又造了一个死控件。
    const page = strip(read(PAGE));
    const slot = page.slice(page.indexOf('{!selectedImage && ('), page.indexOf('{selectedImage && ('));
    expect(slot).toContain('onClick={handleImageButtonClick}');
    expect(slot).not.toContain('pointer-events-none');
    // 剥完注释还剩真代码。
    expect(slot).toContain('aria-label="选择参考图"');
  });
});

describe('不摆只有一项的分段控件', () => {
  it('顶栏「创作」是纯标签，没有套控件外壳', () => {
    const page = strip(read(PAGE));
    const bar = page.slice(page.indexOf('DARKROOM'), page.indexOf('TipsEntryButton compact'));
    // 外壳的标志是 glass-sub + 内边距 + 圆角的容器。这一段里不该再有。
    expect(bar).not.toContain('glass-sub');
    expect(bar).toContain('创作');
  });
});

describe('新建项目不再有第三个入口', () => {
  it('左侧浮动工具栏已整条移除', () => {
    const page = strip(read(PAGE));
    for (const gone of ['FloatingToolbar', 'ToolbarButton', 'FilePlus']) {
      expect(page).not.toContain(gone);
    }
    // 大虚线卡这个入口仍在（不能连它一起删掉）。
    expect(page).toContain('NewProjectCard');
  });

  it('新建文件夹挪到了列表标题行，且带文字', () => {
    // 判据盯「它在标题行、带文字」——那是当初把它从匿名浮动图标搬过来的理由。
    // 上一版还钉着 `onClick={onCreateFolder}`，把「它必须可点」也一并锁死了；
    // 后端还没有文件夹，那个 onClick 走完取名对话框只会回一句「开发中」，
    // 该被禁用而不是被守卫要求存在（形状 4a：断言实现的字面写法，
    // 连带把一个不该有的行为一起钉住）。
    const page = strip(read(PAGE));
    const header = page.slice(page.indexOf('data-tour-id="visual-projects"'), page.indexOf('<NewProjectCard'));
    expect(header).toContain('新建文件夹');
    expect(header).toContain('FolderPlus');
  });
});

describe('看得出是什么 / 看得出是空的', () => {
  it('背景缩略图有肉眼可见的名字，不是只挂在 title 里', () => {
    const panel = strip(read(BACKDROP_PANEL));
    const grid = panel.slice(panel.indexOf('或钉住一张'), panel.indexOf('想要别的'));
    // title/alt 属性里的 a.name 不算——要的是渲染进 DOM 文本的那个。
    // 判据取「name 出现在一个元素的文本位置」，不逐字锁缩进：上一版把整段带缩进的
    // JSX 抄进断言，换个标签或改一次列数就假红（形状 4a：断言字面存在而不是行为）。
    expect(grid).toMatch(/>\s*\{a\.name\}\s*<\//);
  });

  it('没有封面的项目卡不是一个纯色空框', () => {
    const page = strip(read(PAGE));
    const card = page.slice(page.indexOf('const hasCover'), page.indexOf('formatDate(ws.updatedAt)'));
    expect(card).toContain('还没有图');
  });

  it('输入台的高度是定值，不跟视口长', () => {
    // 这块面的高度是拿内容换来的（打字区 + 参考图槽都在面内），不是按屏幕分配的空间。
    // 写成 vw/vh/clamp 就会在宽屏上长出一块空白——真出过：clamp(190,19vw,360)
    // 在 1950 的屏上顶到 360 上限，整块成了空荡荡的大方块。
    const page = strip(read(PAGE));
    const pad = page.slice(page.indexOf('className="relative px-5 pt-4 pb-2 flex flex-col"'));
    const decl = pad.slice(0, pad.indexOf('>') + 1);
    expect(decl).toMatch(/minHeight:\s*\d+\s*[,}]/);
    expect(decl).not.toMatch(/minHeight:[^,}]*(vw|vh|clamp)/);
  });

  it('输入台与预设行同宽，且只有一个宽度值', () => {
    // 这一页的中列宽度写在两处（输入台根 + 预设行）。它们必须相等，
    // 否则预设行会比输入框宽或窄一截，露出一条错位的边。
    //
    // 这条同时钉住「有几个值」：断言 set 只有一个成员，谁只改一处就红。
    // 不锁具体数字——真要调宽，两处一起改，这条照样绿；用户认的是「和原来一样」，
    // 不是某个特定数字，把数字写进判据只会在下次合理调整时假红。
    const page = strip(read(PAGE));
    const widths = [...page.matchAll(/width: 'min\(([^)]*)\)'/g)].map((m) => m[1].trim());
    expect(widths.length).toBe(2);
    expect(new Set(widths).size).toBe(1);
  });
});
