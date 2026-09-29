/**
 * 品牌主渐变（SSOT）：登录 CTA / 落地页 CTA / Arena 主按钮 / 片花共用。
 * 陶土同族色（对齐应用内 --accent-primary），邻近色相保证"彩而不乱"，与登录后的工作台观感统一。
 *
 * 从 HeroSection.tsx 挪出来单独成文件，只为断开循环引用（HeroSection → HeroStage → 片花调色板 → 这里）；
 * HeroSection 仍原样转出这几个常量，老的 import 路径照常可用。
 */
/**
 * 品牌渐变的三档色标（SSOT 的 SSOT）。
 *
 * CSS 渐变、SVG `<stop>` 都从这里取——这条渐变已经被手抄过三份（页脚徽标、
 * 产品预览发送键、导航 Logo），每一份都各自漂移、各自配错前景色。
 * 想用它就 import，不要再抄一遍色值。
 */

export const HERO_GRADIENT_STOPS = ['#CE6B41', '#D97757', '#E0A06B'] as const;
export const HERO_GRADIENT = `linear-gradient(135deg, ${HERO_GRADIENT_STOPS[0]} 0%, ${HERO_GRADIENT_STOPS[1]} 48%, ${HERO_GRADIENT_STOPS[2]} 100%)`;
/**
 * 铺在 HERO_GRADIENT 上的文字色。
 *
 * 这条渐变对白字只有 2.23~3.62:1（越往右越亮越糟），13-15px 的主 CTA 标签一律不达标。
 * 陶土底配深墨字才是这套配色的正解，三档分别 4.74 / 5.49 / 7.68:1；起点 #C8623A
 * 抬到 #CE6B41 就是为了让最暗那档也过 4.5。
 *
 * 走专用 token --hero-gradient-fg（两主题同为深墨）。原来复用 --button-primary-fg，
 * 2026-09-24 浅色主按钮改成「深陶土底 + 白字」后两者分道：这条渐变更亮，白字不达标。
 * 守卫：themeSystem 逐档算「渐变色标 x 两主题的该 token」是否过 4.5，
 * inkPalette 拦「HERO_GRADIENT 当底再配浅色字」。
 */
export const HERO_GRADIENT_FG = 'var(--hero-gradient-fg)';
export const HERO_GRADIENT_TEXT = {
  background: HERO_GRADIENT,
  WebkitBackgroundClip: 'text' as const,
  WebkitTextFillColor: 'transparent' as const,
  backgroundClip: 'text' as const,
};

