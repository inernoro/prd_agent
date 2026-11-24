import { describe, expect, it } from 'vitest';
import { isLayoutClass, layoutStyle, structuralSnapshot } from '../structuralSnapshot';

/**
 * 结构快照的过滤判据。
 *
 * 这个判据两头都会坏，且都是静默的：
 *   太宽 → 一次调色几十行 diff，人开始无脑接受基线更新，基线退化成橡皮图章；
 *   太窄 → 真正的几何改动（h-full 被删、hover 条接管指针）根本不进快照，基线永远绿。
 * 所以两侧都要有用例钉着。
 */

describe('哪些类名算「几何」', () => {
  it('尺寸、弹性、定位、间距、溢出、对齐都要留', () => {
    for (const c of [
      'h-full', 'min-h-0', 'w-[26px]', 'max-w-md', 'flex-1', 'shrink-0', 'grow',
      'absolute', 'relative', 'inset-x-0', 'bottom-0', 'z-20',
      'px-3', 'mt-auto', 'gap-1.5', 'space-y-2',
      'overflow-y-auto', 'truncate', 'line-clamp-2', 'whitespace-nowrap',
      'items-center', 'justify-between', 'self-start',
      'flex', 'inline-flex', 'grid', 'hidden', 'contents', 'block',
      'text-center',
    ]) {
      expect(isLayoutClass(c), `${c} 应该算几何`).toBe(true);
    }
  });

  it('可点与可见要留——hover 条那次事故就出在这两类', () => {
    expect(isLayoutClass('pointer-events-none')).toBe(true);
    expect(isLayoutClass('pointer-events-auto')).toBe(true);
    expect(isLayoutClass('opacity-0')).toBe(true);
    expect(isLayoutClass('group-hover:pointer-events-auto')).toBe(true);
  });

  it('纯外观一律不留：颜色、圆角、阴影、过渡、字号字重、光标', () => {
    for (const c of [
      'bg-white/5', 'text-token-muted', 'border-white/10',
      'rounded-md', 'rounded-[12px]', 'shadow-lg',
      'transition-colors', 'duration-200', 'ease-out',
      'text-[11px]', 'font-semibold', 'tabular-nums', 'font-mono',
      'cursor-pointer', 'hover-bg-soft', 'backdrop-blur',
    ]) {
      expect(isLayoutClass(c), `${c} 不该算几何`).toBe(false);
    }
  });

  it('变体前缀保留并参与判断：带前缀与不带是两件事', () => {
    // group-hover:opacity-100 与 opacity-100 若在快照里长得一样，
    // 「平时不可见、hover 才出现」这条契约就没被记录，改坏了也看不出来
    expect(isLayoutClass('group-hover:opacity-100')).toBe(true);
    expect(isLayoutClass('sm:flex')).toBe(true);
    expect(isLayoutClass('lg:w-[360px]')).toBe(true);
    expect(isLayoutClass('group-hover:text-white')).toBe(false);
  });

  it('方括号里自带冒号的变体不能把判断带歪', () => {
    // `[@media(hover:hover)]:flex` 里面那个冒号属于媒体查询，不是变体分隔符
    expect(isLayoutClass('[@media(hover:hover)]:flex')).toBe(true);
    expect(isLayoutClass('[@media(hover:hover)]:text-white')).toBe(false);
  });
});

describe('内联样式只留影响布局的那些', () => {
  it('几何键留下并按键排序（顺序变化不该算 diff）', () => {
    const a = layoutStyle('height:100%;min-height:0;overflow-y:auto');
    const b = layoutStyle('overflow-y:auto;height:100%;min-height:0');
    expect(a).toBe(b);
    expect(a).toBe('height:100%;min-height:0;overflow-y:auto');
  });

  it('颜色边框阴影一律丢掉', () => {
    expect(layoutStyle('background:var(--bg-card);border:1px solid red;height:20px'))
      .toBe('height:20px');
  });

  it('没有几何键就是空串，不是一堆噪音', () => {
    expect(layoutStyle('color:#fff;font-size:11px')).toBe('');
  });
});

describe('骨架抽取', () => {
  it('层级用缩进表达，文本进快照', () => {
    const snap = structuralSnapshot(
      '<div class="flex h-full bg-red-500"><span class="truncate text-[11px]">标题</span></div>',
    );
    expect(snap).toBe('div .flex.h-full\n  span .truncate\n    "标题"\n');
  });

  it('自闭合标签不压栈（压了会把后面整棵树的缩进带歪）', () => {
    const snap = structuralSnapshot('<div class="flex"><img class="w-4"/><span class="h-2">x</span></div>');
    const lines = snap.trimEnd().split('\n');
    expect(lines[1].startsWith('  img')).toBe(true);
    expect(lines[2].startsWith('  span'), `span 缩进错了：${lines[2]}`).toBe(true);
  });

  it('void 标签即使没写斜杠也不压栈', () => {
    const snap = structuralSnapshot('<div class="flex"><input class="w-4"><span class="h-2">x</span></div>');
    expect(snap.trimEnd().split('\n')[2].startsWith('  span')).toBe(true);
  });

  it('契约属性进快照——别的代码按它们找元素，改名会让一批东西同时失灵', () => {
    const snap = structuralSnapshot('<div data-hoverbar class="flex"><button type="button" aria-label="分享">x</button></div>');
    expect(snap).toContain('[data-hoverbar]');
    expect(snap).toContain('[aria-label=分享 type=button]');
  });

  it('无值属性也要认——契约标记本来就多是裸写的', () => {
    expect(structuralSnapshot('<div data-hoverbar class="flex"></div>')).toContain('[data-hoverbar]');
    expect(structuralSnapshot('<div data-hoverbar="" class="flex"></div>')).toContain('[data-hoverbar]');
  });

  it('注释不进快照', () => {
    expect(structuralSnapshot('<div class="flex"><!-- 说明 --><span class="h-2">x</span></div>'))
      .not.toContain('说明');
  });

  it('类名排序：顺序调整不该产生 diff', () => {
    expect(structuralSnapshot('<div class="h-full flex min-h-0"></div>'))
      .toBe(structuralSnapshot('<div class="min-h-0 flex h-full"></div>'));
  });

  it('长文案截断，改一个字不会让整行读不出来', () => {
    const long = 'x'.repeat(200);
    const snap = structuralSnapshot(`<p class="flex">${long}</p>`, { maxText: 20 });
    expect(snap).toContain('…');
    expect(snap.split('\n')[1].length).toBeLessThan(40);
  });

  it('HTML 实体解回原文，否则中文引号会在快照里变乱码', () => {
    expect(structuralSnapshot('<span class="flex">「上传网页」&amp;更多</span>'))
      .toContain('「上传网页」&更多');
  });

  it('删掉一个 h-full 就是一行 diff——这正是要它拦的那种改动', () => {
    const before = structuralSnapshot('<div class="flex h-full min-h-0"><span class="truncate">a</span></div>');
    const after = structuralSnapshot('<div class="flex min-h-0"><span class="truncate">a</span></div>');
    expect(before).not.toBe(after);
  });

  it('只改颜色不产生 diff（不然基线会变成橡皮图章）', () => {
    const before = structuralSnapshot('<div class="flex h-full bg-red-500 text-white"></div>');
    const after = structuralSnapshot('<div class="flex h-full bg-blue-500 text-black"></div>');
    expect(before).toBe(after);
  });
});

describe('折叠子树', () => {
  it('默认收掉 svg 内部：图标库换个画法不该产生几十行 diff', () => {
    const snap = structuralSnapshot(
      '<button class="flex"><svg class="w-3"><path d="M1"/><circle cx="2"/></svg><span class="truncate">预览</span></button>',
    );
    expect(snap).toContain('svg');
    expect(snap).not.toContain('path');
    expect(snap).not.toContain('circle');
    // 折叠不能把后面的兄弟节点一起吃掉
    expect(snap).toContain('"预览"');
  });

  it('折叠区结束按深度判，嵌套同名标签不会提前解除', () => {
    const snap = structuralSnapshot(
      '<div class="flex"><svg class="w-3"><svg class="w-2"><path d="M1"/></svg></svg><span class="h-2">后面</span></div>',
    );
    const lines = snap.trimEnd().split('\n');
    // svg 只该出现一次（外层那个），后面的 span 缩进要回到第二层
    expect(lines.filter((l) => l.trim().startsWith('svg')).length).toBe(1);
    expect(lines[lines.length - 2].startsWith('  span'), `span 缩进错了：${lines[lines.length - 2]}`).toBe(true);
  });

  it('折叠区里的文本也不进快照', () => {
    expect(structuralSnapshot('<div class="flex"><svg class="w-3"><title>图标名</title></svg></div>'))
      .not.toContain('图标名');
  });

  it('折叠标签可配：不传 svg 就照常展开', () => {
    expect(structuralSnapshot('<svg class="w-3"><path d="M1"/></svg>', { collapseTags: [] }))
      .toContain('path');
  });
});
