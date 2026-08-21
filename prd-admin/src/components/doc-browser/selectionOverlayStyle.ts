// 划词浮层（知识库逐句修改）的统一外观：品牌暖调、不整框描边、真玻璃。
//
// 为什么抽成一份（predicate-and-wiring-discipline.md 形状 3：判据分裂后各自漂移）：
// 同一套浮层配色本来抄在三个文件里（输入条 / 采纳条、划词 AI 面板、划词配图面板），
// 改一处必忘另两处 —— 2026-08-21 之前三处都是同一串冷紫 rgba(168,85,247,.4)，
// 与产品主色 #D97757 一冷一暖同屏打架，看着像上世纪的系统对话框。
// 现在颜色一律来自 tokens.css 的双写 token，这里只负责把它们组合成几个形状。
//
// 三条设计约束（来自 2026-08-21 的「浮窗 C · 品牌暖调」设计稿）：
//  1. 不整框实描边 —— 描边淡到几乎看不见，颜色的重量交给顶部那条 2px 渐变；
//  2. 底色 88%（浅色档 92%）让 blur 真的看得出来，不做「97% 不透明还挂 blur(40px)」的白工；
//  3. 阴影用 tokens.css 早就备好的 --shadow-glass-dropdown（双层柔影 + 内描边高光），
//     不再各自手写一层纯黑。

/**
 * 浮层面板本体。
 *
 * 顶部那条 2px 品牌渐变走 background 的第一层，不是 border-top 也不是绝对定位的子元素：
 * border-top 会被 border-radius 拉成一段弧线，绝对定位的子元素则要求容器 overflow:hidden，
 * 而面板里有会溢出的下拉与滚动区，裁不得。背景层天然被圆角裁剪，两个副作用都没有。
 */
export const SELECTION_OVERLAY_PANEL = {
  borderRadius: 16,
  background:
    'var(--selection-overlay-accent-line) top left / 100% 2px no-repeat, var(--selection-overlay-bg)',
  border: '1px solid var(--selection-overlay-border)',
  boxShadow: 'var(--shadow-glass-dropdown)',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
} as const;

/**
 * 划词后先冒出来的那条小工具条（评论 / AI 改写 / 配图）。
 * 与面板同底同边同影，只是矮，所以不挂顶部那条渐变——32px 高的条子上再压一条线太吵。
 */
export const SELECTION_OVERLAY_BAR = {
  borderRadius: 10,
  background: 'var(--selection-overlay-bg)',
  border: '1px solid var(--selection-overlay-border)',
  boxShadow: 'var(--shadow-glass-dropdown)',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
} as const;

/**
 * 浮层拿走 focus 之后压在正文上的那层选区高亮。
 * 它是这条链上视觉面积最大的一块，配色跟着浮层走，不能自己一套。
 */
export const SELECTION_OVERLAY_HIGHLIGHT = {
  background: 'var(--selection-highlight-bg)',
  borderBottom: '2px solid var(--selection-highlight-underline)',
} as const;

/** 浮层头部的标题字 / 图标色（暖赤陶的浅调，两个主题各自达标）。 */
export const SELECTION_OVERLAY_LABEL = 'var(--selection-text)';

/** 次级动作与被选中的动作 chip：淡淡的暖底 + 暖边，克制但认得出是自家颜色。 */
export const SELECTION_OVERLAY_CHIP = {
  background: 'var(--selection-bg)',
  border: '1px solid var(--selection-border)',
  color: 'var(--selection-text)',
} as const;

/**
 * 主操作（发送 / 采纳 / 替换原文）：整个浮层唯一的实心品牌色块。
 * 底走 --accent-gold、字走 --accent-on-gold —— 这一对在两个主题下是**相反**的
 * （暗色亮橙配深字，浅色深赭配暖白字），所以必须成对取，不能只换底。
 */
export const SELECTION_OVERLAY_PRIMARY = {
  background: 'var(--accent-gold)',
  border: '1px solid var(--accent-gold)',
  color: 'var(--accent-on-gold)',
  boxShadow: '0 2px 10px rgba(var(--accent-primary-rgb), 0.40)',
} as const;
