/**
 * 兼容层 — 品牌标已从「金属三轨道」换代为「宝石六芒」(状态系统设定 v2)。
 * 旧调用点(rail 头像 / 登录卡 / 各处 CdsLogoLoader)保持 import 路径不变,
 * 内部渲染切换到 CdsGem;新代码请直接 import '@/components/brand/CdsGem'。
 */
import type { SVGProps } from 'react';
import { CdsGem, CdsGemLoader } from './CdsGem';

export function CdsMetallicLogo({
  className,
  title = 'CDS',
  ...props
}: {
  className?: string;
  title?: string;
} & Omit<SVGProps<SVGSVGElement>, 'mode' | 'children'>): JSX.Element {
  return <CdsGem mode="brand" className={className} title={title} {...props} />;
}

export { CdsGemLoader as CdsLogoLoader };
