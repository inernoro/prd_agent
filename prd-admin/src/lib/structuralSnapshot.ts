/**
 * 结构快照：把一段渲染出来的 HTML 压成「只剩布局骨架」的可读文本，用来做回归基线。
 *
 * 要解决的问题：共享组件（卡片、面板、外壳）改一笔，会同时影响好几屏，但改的人当场
 * 看不到影响面——只有验收甚至上线才发现某一屏塌了。本仓库真实栽过的几次都是这一类：
 * hover 条以整条宽度接管指针把勾选框吞掉、卡片少了 h-full 高度不再一致、
 * 分享档整块摞到顶栏上面。
 *
 * 为什么不用像素截图：截图基线要跑起真实环境、字体渲染一变就假红、二进制文件在 PR 里
 * 读不出「改了什么」。而在 Tailwind 这套写法下，**几何决策就写在类名里**——
 * `h-full` / `flex-1` / `min-h-0` / `absolute inset-x-0` / `pointer-events-none` / `truncate`
 * 就是布局本身。把它们抽出来做文本基线，diff 直接读得懂：谁把 h-full 删了。
 *
 * 为什么要过滤：全量类名会把颜色、圆角、过渡、字号都卷进来，一次调色就是几十行 diff，
 * 人就开始无脑接受基线更新——那时基线只是个会自动同意的橡皮图章，比没有更糟
 * （.claude/rules/predicate-and-wiring-discipline.md 形状 4）。所以只留会改变
 * 「东西摆在哪、多大、会不会被裁掉、能不能点」的那些。
 */

/** 类名前缀：命中即保留（保留的是**几何**，不是外观） */
const LAYOUT_PREFIXES = [
  // 尺寸
  'w-', 'h-', 'min-w-', 'min-h-', 'max-w-', 'max-h-', 'size-', 'basis-',
  // 弹性 / 网格
  'flex-', 'grow', 'shrink', 'order-', 'col-', 'row-', 'grid-', 'auto-cols-', 'auto-rows-',
  // 定位
  'inset-', 'top-', 'right-', 'bottom-', 'left-', 'z-',
  // 间距
  'p-', 'px-', 'py-', 'pt-', 'pr-', 'pb-', 'pl-',
  'm-', 'mx-', 'my-', 'mt-', 'mr-', 'mb-', 'ml-',
  'gap-', 'space-x-', 'space-y-',
  // 溢出与截断
  'overflow-', 'line-clamp-', 'whitespace-', 'break-',
  // 对齐
  'items-', 'justify-', 'self-', 'place-', 'content-',
  // 可点与可见（hover 条那次事故正是这两类）
  'pointer-events-', 'opacity-',
  // 位移（会改变元素实际落点）
  'translate-', 'scale-', 'rotate-',
];

/** 类名全等：命中即保留 */
const LAYOUT_EXACT = new Set([
  'flex', 'inline-flex', 'grid', 'inline-grid', 'block', 'inline-block', 'inline',
  'hidden', 'contents', 'table', 'flow-root',
  'absolute', 'relative', 'fixed', 'sticky', 'static',
  'truncate', 'sr-only', 'not-sr-only',
  'text-center', 'text-left', 'text-right', 'text-justify',
  'aspect-square', 'aspect-video',
]);

/** 会影响布局的内联样式键（其余如颜色、边框、阴影一律丢掉） */
const LAYOUT_STYLE_KEYS = new Set([
  'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'gap', 'row-gap', 'column-gap',
  'flex', 'flex-grow', 'flex-shrink', 'flex-basis', 'flex-direction', 'flex-wrap',
  'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
  'align-items', 'justify-content', 'align-self',
  'overflow', 'overflow-x', 'overflow-y', 'overscroll-behavior',
  'transform', 'opacity', 'pointer-events', 'aspect-ratio',
]);

/**
 * 这些属性是**契约**，不是样式：别的代码按它们找元素（取证脚本、守卫、教程锚点）。
 * 悄悄改名会让一批看不见的东西同时失灵，所以进快照。
 */
const CONTRACT_ATTRS = ['data-hoverbar', 'data-tour-id', 'data-no-drag', 'aria-label', 'role', 'type'];

/** 自闭合标签：没有对应的结束标签，栈不能给它压一层 */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * 一个类名要不要留。
 *
 * 变体前缀（`sm:` `lg:` `group-hover:` `[@media(hover:hover)]:` `dark:`）一律**保留**并
 * 参与判断——`group-hover:opacity-100` 与 `opacity-100` 是两件完全不同的事，
 * 把前缀剥掉再判会让这两者在快照里长得一样，那次 hover 条事故就再也看不出来了。
 */
export function isLayoutClass(cls: string): boolean {
  if (!cls) return false;
  // 变体前缀可以有多段，且 `[@media(hover:hover)]:` 这种方括号里本身带冒号，
  // 所以要从右往左找最后一个「不在方括号里」的冒号。
  let depth = 0;
  let lastColon = -1;
  for (let i = 0; i < cls.length; i += 1) {
    const c = cls[i];
    if (c === '[') depth += 1;
    else if (c === ']') depth -= 1;
    else if (c === ':' && depth === 0) lastColon = i;
  }
  const base = lastColon >= 0 ? cls.slice(lastColon + 1) : cls;
  if (LAYOUT_EXACT.has(base)) return true;
  return LAYOUT_PREFIXES.some((p) => base.startsWith(p));
}

/** 从 style 字符串里挑出会影响布局的声明，按键排序（顺序变化不该算 diff） */
export function layoutStyle(style: string): string {
  return style
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const at = d.indexOf(':');
      return at < 0 ? null : { k: d.slice(0, at).trim().toLowerCase(), v: d.slice(at + 1).trim() };
    })
    .filter((d): d is { k: string; v: string } => !!d && LAYOUT_STYLE_KEYS.has(d.k))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
    .map((d) => `${d.k}:${d.v}`)
    .join(';');
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  // 无值属性也要认（`<div data-hoverbar>`）：React 渲染布尔属性时给的是 `data-hoverbar=""`，
  // 但手写的模板、以及别的地方复制来的片段常常是裸写的。只认带等号的那种，
  // 恰恰会漏掉最该进快照的一类——契约标记本来就多是无值的。
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (!m[1]) continue;
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

function decode(s: string): string {
  return s
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export interface SnapshotOptions {
  /** 文本节点最多留多少字（长文案改一个字不该让整行 diff 不可读） */
  maxText?: number;
  /**
   * 这些标签只记它自己，内部整棵子树不展开。
   *
   * 默认收掉 `svg`：图标库渲染出来是一串匿名 `path` / `circle`，既说明不了是哪个图标
   * （lucide 不留名字），又会在依赖升级换了画法时凭空产生几十行 diff——
   * 一个会因为无关变动而变红的基线，很快就没人认真看了。
   */
  collapseTags?: string[];
}

/**
 * 把 renderToStaticMarkup 的输出压成布局骨架。
 *
 * 输入是 React 服务端渲染的结果——标签闭合规范、属性都带引号，所以这里用扫描而不是
 * 完整 HTML 解析器：不引第三方依赖，也不会因为容错解析把畸形结构悄悄「修好」。
 */
export function structuralSnapshot(html: string, opts: SnapshotOptions = {}): string {
  const maxText = opts.maxText ?? 60;
  const collapse = new Set(opts.collapseTags ?? ['svg']);
  const lines: string[] = [];
  const stack: string[] = [];
  /** 正处在被折叠的子树里时，记住它在栈上的深度；null = 不在折叠区 */
  let collapsedAt: number | null = null;
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|<!--[\s\S]*?-->/g;
  let cursor = 0;
  let m: RegExpExecArray | null;

  const pushText = (raw: string) => {
    if (collapsedAt !== null) return;
    const text = decode(raw).replace(/\s+/g, ' ').trim();
    if (!text) return;
    const shown = text.length > maxText ? `${text.slice(0, maxText)}…` : text;
    lines.push(`${'  '.repeat(stack.length)}"${shown}"`);
  };

  while ((m = re.exec(html)) !== null) {
    pushText(html.slice(cursor, m.index));
    cursor = m.index + m[0].length;
    if (m[0].startsWith('<!--')) continue;

    const tag = m[1].toLowerCase();
    const closing = m[0][1] === '/';
    if (closing) {
      // 只在栈顶确实是它时才弹，避免畸形输入把整棵树的缩进带歪
      if (stack[stack.length - 1] === tag) stack.pop();
      // 折叠区在它自己那一层被弹掉时结束。用深度判而不是标签名判：
      // 折叠的 svg 里面还可能嵌套 svg，按名字判会在内层结束时就提前解除折叠。
      if (collapsedAt !== null && stack.length <= collapsedAt) collapsedAt = null;
      continue;
    }

    const selfClosedEarly = /\/\s*$/.test(m[2] || '');
    if (collapsedAt !== null) {
      // 折叠区里的元素一律不输出，但仍要维持栈深度，否则折叠结束的判定会错位
      if (!VOID_TAGS.has(tag) && !selfClosedEarly) stack.push(tag);
      continue;
    }

    const attrs = parseAttrs(m[2] || '');
    const classes = (attrs.class || '').split(/\s+/).filter(isLayoutClass).sort();
    const style = layoutStyle(attrs.style || '');
    const contracts = CONTRACT_ATTRS
      .filter((a) => attrs[a] !== undefined)
      .map((a) => (attrs[a] === '' ? a : `${a}=${decode(attrs[a])}`));

    const parts = [tag];
    if (classes.length) parts.push(`.${classes.join('.')}`);
    if (style) parts.push(`{${style}}`);
    if (contracts.length) parts.push(`[${contracts.join(' ')}]`);
    lines.push(`${'  '.repeat(stack.length)}${parts.join(' ')}`);

    const selfClosed = selfClosedEarly;
    if (!VOID_TAGS.has(tag) && !selfClosed) {
      stack.push(tag);
      if (collapse.has(tag)) collapsedAt = stack.length - 1;
    }
  }
  pushText(html.slice(cursor));

  return `${lines.join('\n')}\n`;
}
