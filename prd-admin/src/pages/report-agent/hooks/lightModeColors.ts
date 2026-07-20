/**
 * 周报语义色到全局主题 token 的映射。
 *
 * 文件名为历史兼容保留；这里不再保存浅色或暗色数值。组件只声明业务 hue，
 * 具体前景、柔和背景与边框由 tokens.css 的当前主题统一解析。
 */
export interface SemanticTriplet {
  color: string;
  bg: string;
  border: string;
}

export type SemanticHue =
  | 'slate'
  | 'blue'
  | 'green'
  | 'red'
  | 'purple'
  | 'orange'
  | 'pink'
  | 'teal'
  | 'sky'
  | 'emerald'
  | 'claude'
  | 'moss'
  | 'amber';

type SemanticTokenName =
  | 'neutral'
  | 'info'
  | 'success'
  | 'danger'
  | 'purple'
  | 'orange'
  | 'pink'
  | 'cyan';

const HUE_TO_TOKEN: Record<SemanticHue, SemanticTokenName | 'report-accent' | 'report-done' | 'report-going'> = {
  slate: 'neutral',
  blue: 'info',
  green: 'success',
  red: 'danger',
  purple: 'purple',
  orange: 'orange',
  pink: 'pink',
  teal: 'cyan',
  sky: 'cyan',
  emerald: 'success',
  claude: 'report-accent',
  moss: 'report-done',
  amber: 'report-going',
};

function reportTriplet(name: 'accent' | 'done' | 'going'): SemanticTriplet {
  const prefix = name === 'accent' ? '--report-accent' : `--report-status-${name}`;
  return {
    color: `var(${prefix})`,
    bg: `var(${prefix}-soft)`,
    border: `var(${prefix}-border)`,
  };
}

/**
 * 保留首个参数以兼容存量调用方；主题变化由 CSS token 自动响应，无需在 React 中分支。
 */
export function getSemantic(_isLight: boolean, hue: SemanticHue): SemanticTriplet {
  const token = HUE_TO_TOKEN[hue];
  if (token === 'report-accent') return reportTriplet('accent');
  if (token === 'report-done') return reportTriplet('done');
  if (token === 'report-going') return reportTriplet('going');

  return {
    color: `var(--semantic-${token}-text)`,
    bg: `var(--semantic-${token}-soft)`,
    border: `var(--semantic-${token}-border)`,
  };
}
