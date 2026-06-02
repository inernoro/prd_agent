import { TipsDrawer } from './TipsDrawer';
import { SpotlightOverlay } from './SpotlightOverlay';

/**
 * 全屏页面（NAV_REGISTRY placement='fullscreen'，不进 AppShell）的「小技巧」补丁。
 *
 * AppShell 在右下角挂了 <TipsDrawer/>（教程书 + 抽屉）和 <SpotlightOverlay/>（落地引导）。
 * 视觉创作、智识殿堂等全屏页绕过 AppShell，否则点不到右下角小技巧、也跑不了本页教程。
 * 本组件把这两件事补齐，保证「每个页面右下角都能点小技巧看本页教程」。
 *
 * 同一时刻只有一个路由渲染，不会与 AppShell 内的实例重复挂载。
 */
export function FullscreenTipsDock() {
  return (
    <>
      <TipsDrawer />
      <SpotlightOverlay />
    </>
  );
}
