export type ThemeAcceptanceState =
  | 'default'
  | 'hover-primary-card'
  | 'keyboard-overlay-open'
  | 'selected-tab'
  | 'empty-state'
  | 'populated-state';

export interface ThemeAcceptanceTarget {
  id: string;
  path: string;
  themes: readonly ['dark', 'light'];
  states: readonly ThemeAcceptanceState[];
}

const BOTH_THEMES = ['dark', 'light'] as const;

const settingsTarget = (tab: string): ThemeAcceptanceTarget => ({
  id: `settings-${tab}`,
  path: `/settings?tab=${tab}`,
  themes: BOTH_THEMES,
  states: ['default', 'selected-tab'],
});

/**
 * 双主题浏览器验收的单一目标清单。
 * 路由不是页面边界：query tab、键盘浮层、hover 和数据状态都必须独立取证。
 */
export const THEME_ACCEPTANCE_TARGETS: readonly ThemeAcceptanceTarget[] = [
  { id: 'home', path: '/', themes: BOTH_THEMES, states: ['default', 'hover-primary-card'] },
  { id: 'ai-toolbox', path: '/ai-toolbox', themes: BOTH_THEMES, states: ['default', 'hover-primary-card'] },
  { id: 'voc', path: '/team-activity', themes: BOTH_THEMES, states: ['default', 'populated-state'] },
  { id: 'command-palette', path: '/', themes: BOTH_THEMES, states: ['keyboard-overlay-open'] },
  { id: 'emergence', path: '/emergence', themes: BOTH_THEMES, states: ['default', 'hover-primary-card', 'empty-state', 'populated-state'] },
  settingsTarget('user-space'),
  settingsTarget('account'),
  settingsTarget('skin'),
  settingsTarget('nav-order'),
  settingsTarget('assets'),
  settingsTarget('authz'),
  settingsTarget('data'),
  settingsTarget('infra-services'),
  settingsTarget('update-accel'),
  settingsTarget('short-links'),
  settingsTarget('peer-sync'),
];

