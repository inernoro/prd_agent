/**
 * 页面右下角主操作按钮（如知识库「+」）向全局浮层声明占位。
 *
 * AppShell 的通知卡片 / 铃铛读 --page-fab-clearance 上移让位：哪个页面挂了按钮，哪个页面
 * 就自动让位，AppShell 不用按路由判断。曾经两者都贴右下角，周报提醒卡片把「+」整个盖住。
 */

/** 桌面端「+」占用的右下角高度：56px 按钮 + 24px 底边距 + 16px 间隙。 */
export const CORNER_CLEARANCE = '96px';
export const CLEARANCE_VAR = '--page-fab-clearance';

// 同一时刻可能挂着两个「+」（知识库首页与库内浏览器），按引用计数，最后一个卸载才撤销声明
let cornerClaims = 0;

/** 声明占位，返回撤销函数（直接当 useEffect 的清理函数用）。 */
export function claimCornerClearance(): () => void {
  cornerClaims += 1;
  document.documentElement.style.setProperty(CLEARANCE_VAR, CORNER_CLEARANCE);
  let released = false;
  return () => {
    if (released) return; // 同一个声明撤销两次不能把别人的也减掉
    released = true;
    cornerClaims = Math.max(0, cornerClaims - 1);
    if (cornerClaims === 0) document.documentElement.style.removeProperty(CLEARANCE_VAR);
  };
}
