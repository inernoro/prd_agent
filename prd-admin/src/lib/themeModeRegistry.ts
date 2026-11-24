/**
 * 外观偏好注册表（唯一数据源）。
 *
 * 「有哪几种外观 / 各自叫什么 / 用哪个图标」只在这里定义一次。三处入口消费它：
 *   - 侧栏用户菜单里的横排三选项（AppShell）
 *   - 设置 → 皮肤设置「外观」（ThemeSkinEditor）
 *   - 周报 Agent 工具条的主题控件（report-agent/ThemeControl）
 *
 * 之前三处各写一份 OPTIONS 数组，加「随系统」时会漏掉两处 —— 漏掉的那两处不会报错，
 * 只是选中态谁都不高亮（选了随系统，控件看着像没选）。注册表就是为了让这种漏掉不可能发生。
 */
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import type { MobileThemeMode } from '@/stores/mobileThemeStore';

export interface ThemeModeConfig {
  value: MobileThemeMode;
  /** 短标签，横排控件用 */
  label: string;
  /** 一句话说明，设置页那种带描述的卡片用 */
  description: string;
  icon: LucideIcon;
}

export const THEME_MODE_REGISTRY: Record<MobileThemeMode, ThemeModeConfig> = {
  light: { value: 'light', label: '白天', description: '明亮环境，纸感浅色', icon: Sun },
  dark: { value: 'dark', label: '黑夜', description: '夜晚与暗光环境（默认）', icon: Moon },
  system: { value: 'system', label: '随系统', description: '跟随操作系统的深浅设置', icon: Monitor },
};

/** 横排顺序：白天 -> 黑夜 -> 随系统。 */
export const THEME_MODE_ORDER: MobileThemeMode[] = ['light', 'dark', 'system'];

export const THEME_MODE_OPTIONS: ThemeModeConfig[] = THEME_MODE_ORDER.map(
  (mode) => THEME_MODE_REGISTRY[mode],
);
