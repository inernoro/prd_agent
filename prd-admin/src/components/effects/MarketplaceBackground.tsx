import React from 'react';
import { CssRainBackground } from './CssRainBackground';

export type BackgroundEffectType = 'none' | 'rain' | 'stars' | 'particles';

export interface BackgroundEffectConfig {
  type: BackgroundEffectType;
  opacity?: number;
  // Rain specific
  rainCount?: number;
  cloudCount?: number;
  rainSpeed?: number;
}

export interface MarketplaceBackgroundProps {
  config: BackgroundEffectConfig;
}

/**
 * 海鲜市场背景效果管理器
 * 支持多种动态背景效果切换
 */
export const MarketplaceBackground: React.FC<MarketplaceBackgroundProps> = ({ config }) => {
  switch (config.type) {
    case 'rain':
      return (
        <CssRainBackground
          opacity={config.opacity ?? 0.3}
          rainCount={config.rainCount ? Math.min(config.rainCount / 100, 150) : 100}
        />
      );
    case 'none':
    default:
      return null;
  }
};

/**
 * 预设背景效果配置
 */
export const BACKGROUND_PRESETS: Record<string, BackgroundEffectConfig> = {
  none: {
    type: 'none',
  },
  rainLight: {
    type: 'rain',
    opacity: 0.2,
    rainCount: 8000,
    cloudCount: 15,
    rainSpeed: 0.08,
  },
  rainNormal: {
    type: 'rain',
    opacity: 0.3,
    rainCount: 15000,
    cloudCount: 25,
    rainSpeed: 0.1,
  },
  rainHeavy: {
    type: 'rain',
    opacity: 0.4,
    rainCount: 25000,
    cloudCount: 35,
    rainSpeed: 0.15,
  },
};
