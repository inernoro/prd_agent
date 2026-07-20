import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeThemeConfig } from '../themeApplier';
import {
  ACCENT_STYLES,
  DEFAULT_THEME_CONFIG,
  MATERIAL_OPTIONS,
  type ThemeConfig,
} from '@/types/theme';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_PATH = path.resolve(TEST_DIR, '../../styles/tokens.css');

describe('主题系统契约', () => {
  it('默认配置只向用户暴露外观和材质的稳定预设', () => {
    expect(DEFAULT_THEME_CONFIG).toMatchObject({
      version: 1,
      colorDepth: 'default',
      opacity: 'default',
      enableGlow: true,
      sidebarGlass: 'always',
      material: 'solid',
    });
    expect(MATERIAL_OPTIONS.map((item) => item.value)).toEqual(['solid', 'glass']);
  });

  it('存量个性化字段会被归一化，兼容数据不再成为第二份样式来源', () => {
    const legacyConfig: ThemeConfig = {
      ...DEFAULT_THEME_CONFIG,
      colorDepth: 'lighter',
      opacity: 'translucent',
      enableGlow: false,
      sidebarGlass: 'never',
      material: 'glass',
    };

    expect(normalizeThemeConfig(legacyConfig)).toMatchObject({
      colorDepth: 'default',
      opacity: 'default',
      enableGlow: true,
      sidebarGlass: 'always',
      material: 'glass',
    });
  });

  it('强调色配置保持统一结构', () => {
    Object.values(ACCENT_STYLES).forEach((accent) => {
      expect(accent.bg).toMatch(/^rgba\(/);
      expect(accent.border).toMatch(/^rgba\(/);
      expect(accent.text).toMatch(/^rgba\(/);
    });
  });

  it('tokens.css 是明暗主题与材质视觉值的唯一契约', () => {
    const tokens = fs.readFileSync(TOKENS_PATH, 'utf8');
    const lightBlock = tokens.slice(
      tokens.indexOf('[data-theme="light"]'),
      tokens.indexOf('html, body'),
    );

    expect(tokens).toContain('[data-material="solid"]');
    expect(lightBlock).toContain('--bg-base:');
    expect(lightBlock).toContain('--media-art-filter:');
    expect(lightBlock).toContain('--text-on-media:');
    expect(lightBlock).not.toContain('!important');
  });
});
