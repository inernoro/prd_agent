/**
 * 主题系统单元测试
 * 验证：CSS 变量计算、主题配置解析、样式映射
 *
 * 运行方式：pnpm -C prd-admin test themeSystem
 */

import { describe, it, expect } from 'vitest';
import { computeThemeVars } from '../themeComputed';
import {
  DEFAULT_THEME_CONFIG,
  COLOR_DEPTH_MAP,
  OPACITY_MAP,
  NESTED_BLOCK_STYLES,
  ACCENT_STYLES,
  type ThemeConfig,
  type ColorDepthLevel,
  type OpacityLevel,
} from '@/types/theme';

describe('主题系统单元测试', () => {
  describe('默认配置验证', () => {
    it('默认配置应包含所有必需字段', () => {
      expect(DEFAULT_THEME_CONFIG).toHaveProperty('version');
      expect(DEFAULT_THEME_CONFIG).toHaveProperty('colorDepth');
      expect(DEFAULT_THEME_CONFIG).toHaveProperty('opacity');
      expect(DEFAULT_THEME_CONFIG).toHaveProperty('enableGlow');
      expect(DEFAULT_THEME_CONFIG).toHaveProperty('sidebarGlass');
    });

    it('默认配置值应正确', () => {
      expect(DEFAULT_THEME_CONFIG.version).toBe(1);
      expect(DEFAULT_THEME_CONFIG.colorDepth).toBe('default');
      expect(DEFAULT_THEME_CONFIG.opacity).toBe('default');
      expect(DEFAULT_THEME_CONFIG.enableGlow).toBe(true);
      expect(DEFAULT_THEME_CONFIG.sidebarGlass).toBe('always');
    });
  });

  describe('色深配置映射验证', () => {
    const colorDepthLevels: ColorDepthLevel[] = ['darker', 'default', 'lighter'];

    for (const level of colorDepthLevels) {
      it(`色深级别 "${level}" 应包含所有必需字段`, () => {
        const config = COLOR_DEPTH_MAP[level];
        expect(config).toHaveProperty('bgBase');
        expect(config).toHaveProperty('bgElevated');
        expect(config).toHaveProperty('bgCard');
        expect(config).toHaveProperty('glassBrightness');
        expect(config).toHaveProperty('label');
      });

      it(`色深级别 "${level}" 的背景色应为有效的颜色值`, () => {
        const config = COLOR_DEPTH_MAP[level];
        // 检查 hex 颜色格式
        expect(config.bgBase).toMatch(/^#[0-9a-f]{6}$/i);
        expect(config.bgElevated).toMatch(/^#[0-9a-f]{6}$/i);
        // bgCard 是 rgba 格式
        expect(config.bgCard).toMatch(/^rgba\(/);
      });
    }

    it('色深级别应按深到浅排列', () => {
      // 提取 bgBase 的亮度（简化：使用红色通道）
      const getBrightness = (hex: string) => parseInt(hex.slice(1, 3), 16);

      const darkerBrightness = getBrightness(COLOR_DEPTH_MAP.darker.bgBase);
      const defaultBrightness = getBrightness(COLOR_DEPTH_MAP.default.bgBase);
      const lighterBrightness = getBrightness(COLOR_DEPTH_MAP.lighter.bgBase);

      expect(darkerBrightness).toBeLessThanOrEqual(defaultBrightness);
      expect(defaultBrightness).toBeLessThanOrEqual(lighterBrightness);
    });
  });

  describe('透明度配置映射验证', () => {
    const opacityLevels: OpacityLevel[] = ['solid', 'default', 'translucent'];

    for (const level of opacityLevels) {
      it(`透明度级别 "${level}" 应包含所有必需字段`, () => {
        const config = OPACITY_MAP[level];
        expect(config).toHaveProperty('glassStart');
        expect(config).toHaveProperty('glassEnd');
        expect(config).toHaveProperty('border');
        expect(config).toHaveProperty('label');
      });

      it(`透明度级别 "${level}" 的值应在 0-1 范围内`, () => {
        const config = OPACITY_MAP[level];
        expect(config.glassStart).toBeGreaterThanOrEqual(0);
        expect(config.glassStart).toBeLessThanOrEqual(1);
        expect(config.glassEnd).toBeGreaterThanOrEqual(0);
        expect(config.glassEnd).toBeLessThanOrEqual(1);
        expect(config.border).toBeGreaterThanOrEqual(0);
        expect(config.border).toBeLessThanOrEqual(1);
      });
    }

    it('透明度级别应按不透明到半透明排列', () => {
      expect(OPACITY_MAP.solid.glassStart).toBeGreaterThan(OPACITY_MAP.default.glassStart);
      expect(OPACITY_MAP.default.glassStart).toBeGreaterThan(OPACITY_MAP.translucent.glassStart);
    });
  });

  describe('内嵌块样式配置验证', () => {
    const opacityLevels: OpacityLevel[] = ['solid', 'default', 'translucent'];

    it('NESTED_BLOCK_STYLES 应包含所有必需的样式类别', () => {
      expect(NESTED_BLOCK_STYLES).toHaveProperty('bgAlpha');
      expect(NESTED_BLOCK_STYLES).toHaveProperty('borderAlpha');
      expect(NESTED_BLOCK_STYLES).toHaveProperty('listItemBgAlpha');
      expect(NESTED_BLOCK_STYLES).toHaveProperty('listItemBorderAlpha');
      expect(NESTED_BLOCK_STYLES).toHaveProperty('hoverBgAlpha');
    });

    for (const level of opacityLevels) {
      it(`透明度级别 "${level}" 应在所有内嵌块样式中定义`, () => {
        expect(NESTED_BLOCK_STYLES.bgAlpha[level]).toBeDefined();
        expect(NESTED_BLOCK_STYLES.borderAlpha[level]).toBeDefined();
        expect(NESTED_BLOCK_STYLES.listItemBgAlpha[level]).toBeDefined();
        expect(NESTED_BLOCK_STYLES.listItemBorderAlpha[level]).toBeDefined();
        expect(NESTED_BLOCK_STYLES.hoverBgAlpha[level]).toBeDefined();
      });

      it(`透明度级别 "${level}" 的内嵌块透明度值应在合理范围`, () => {
        expect(NESTED_BLOCK_STYLES.bgAlpha[level]).toBeGreaterThan(0);
        expect(NESTED_BLOCK_STYLES.bgAlpha[level]).toBeLessThan(0.5);
        expect(NESTED_BLOCK_STYLES.borderAlpha[level]).toBeGreaterThan(0);
        expect(NESTED_BLOCK_STYLES.borderAlpha[level]).toBeLessThan(0.5);
      });
    }
  });

  describe('强调色样式配置验证', () => {
    const accentColors = ['blue', 'green', 'gold', 'purple', 'red'] as const;

    for (const color of accentColors) {
      it(`强调色 "${color}" 应包含所有必需字段`, () => {
        expect(ACCENT_STYLES[color]).toHaveProperty('bg');
        expect(ACCENT_STYLES[color]).toHaveProperty('border');
        expect(ACCENT_STYLES[color]).toHaveProperty('text');
      });

      it(`强调色 "${color}" 的颜色值应为有效的 rgba 格式`, () => {
        expect(ACCENT_STYLES[color].bg).toMatch(/^rgba\(/);
        expect(ACCENT_STYLES[color].border).toMatch(/^rgba\(/);
        expect(ACCENT_STYLES[color].text).toMatch(/^rgba\(/);
      });
    }
  });

  describe('CSS 变量计算验证', () => {
    it('默认配置应生成所有必需的 CSS 变量', () => {
      const vars = computeThemeVars(DEFAULT_THEME_CONFIG);

      // 背景色变量
      expect(vars['--bg-base']).toBeDefined();
      expect(vars['--bg-elevated']).toBeDefined();
      expect(vars['--bg-card']).toBeDefined();

      // 玻璃效果变量
      expect(vars['--glass-bg-start']).toBeDefined();
      expect(vars['--glass-bg-end']).toBeDefined();
      expect(vars['--glass-border']).toBeDefined();

      // 边框变量
      expect(vars['--border-subtle']).toBeDefined();
      expect(vars['--border-default']).toBeDefined();
      expect(vars['--border-hover']).toBeDefined();
      expect(vars['--border-faint']).toBeDefined();

      // 内嵌块样式变量
      expect(vars['--nested-block-bg']).toBeDefined();
      expect(vars['--nested-block-border']).toBeDefined();
      expect(vars['--list-item-bg']).toBeDefined();
      expect(vars['--list-item-border']).toBeDefined();
      expect(vars['--list-item-hover-bg']).toBeDefined();

      // 表格样式变量
      expect(vars['--table-header-bg']).toBeDefined();
      expect(vars['--table-row-border']).toBeDefined();
      expect(vars['--table-row-hover-bg']).toBeDefined();
    });

    it('CSS 变量值应为有效的 rgba 格式', () => {
      const vars = computeThemeVars(DEFAULT_THEME_CONFIG);

      // 检查 rgba 格式的变量
      const rgbaVars = [
        '--glass-bg-start', '--glass-bg-end', '--glass-border',
        '--border-subtle', '--border-default', '--border-hover', '--border-faint',
        '--nested-block-bg', '--nested-block-border',
        '--list-item-bg', '--list-item-border', '--list-item-hover-bg',
        '--table-header-bg', '--table-row-border', '--table-row-hover-bg',
      ] as const;

      for (const varName of rgbaVars) {
        expect(vars[varName]).toMatch(/^rgba\(.*\)$/);
      }
    });

    describe('不同配置组合测试', () => {
      const colorDepthLevels: ColorDepthLevel[] = ['darker', 'default', 'lighter'];
      const opacityLevels: OpacityLevel[] = ['solid', 'default', 'translucent'];

      for (const colorDepth of colorDepthLevels) {
        for (const opacity of opacityLevels) {
          it(`配置 colorDepth="${colorDepth}" + opacity="${opacity}" 应正确计算`, () => {
            const config: ThemeConfig = {
              ...DEFAULT_THEME_CONFIG,
              colorDepth,
              opacity,
            };
            const vars = computeThemeVars(config);

            // 背景色应匹配色深配置
            expect(vars['--bg-base']).toBe(COLOR_DEPTH_MAP[colorDepth].bgBase);
            expect(vars['--bg-elevated']).toBe(COLOR_DEPTH_MAP[colorDepth].bgElevated);

            // 玻璃透明度应基于 opacity × glassBrightness
            const opacityConfig = OPACITY_MAP[opacity];
            const brightness = COLOR_DEPTH_MAP[colorDepth].glassBrightness;
            const expectedGlassStart = (opacityConfig.glassStart * brightness).toFixed(4);
            expect(vars['--glass-bg-start']).toContain(expectedGlassStart);
          });
        }
      }
    });
  });

  describe('内嵌块样式与主题配置联动验证', () => {
    it('solid 透明度应使用更高的内嵌块透明度值', () => {
      const config: ThemeConfig = { ...DEFAULT_THEME_CONFIG, opacity: 'solid' };
      const vars = computeThemeVars(config);

      // 提取 rgba 中的透明度值
      const extractAlpha = (rgba: string) => {
        const match = rgba.match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/);
        return match ? parseFloat(match[1]) : null;
      };

      const nestedBgAlpha = extractAlpha(vars['--nested-block-bg']);
      // 默认色深的 glassBrightness = 1.0，所以透明度值等于原始值
      expect(nestedBgAlpha).toBe(NESTED_BLOCK_STYLES.bgAlpha.solid);
    });

    it('translucent 透明度应使用更低的内嵌块透明度值', () => {
      const config: ThemeConfig = { ...DEFAULT_THEME_CONFIG, opacity: 'translucent' };
      const vars = computeThemeVars(config);

      const extractAlpha = (rgba: string) => {
        const match = rgba.match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/);
        return match ? parseFloat(match[1]) : null;
      };

      const nestedBgAlpha = extractAlpha(vars['--nested-block-bg']);
      // 默认色深的 glassBrightness = 1.0，所以透明度值等于原始值
      expect(nestedBgAlpha).toBe(NESTED_BLOCK_STYLES.bgAlpha.translucent);
    });
  });

  describe('色深对玻璃效果的影响验证', () => {
    it('深色模式应降低玻璃亮度', () => {
      const defaultConfig: ThemeConfig = { ...DEFAULT_THEME_CONFIG, colorDepth: 'default' };
      const darkerConfig: ThemeConfig = { ...DEFAULT_THEME_CONFIG, colorDepth: 'darker' };

      const defaultVars = computeThemeVars(defaultConfig);
      const darkerVars = computeThemeVars(darkerConfig);

      const extractAlpha = (rgba: string) => {
        const match = rgba.match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/);
        return match ? parseFloat(match[1]) : 0;
      };

      const defaultGlassAlpha = extractAlpha(defaultVars['--glass-bg-start']);
      const darkerGlassAlpha = extractAlpha(darkerVars['--glass-bg-start']);

      // 深色模式的玻璃应该更暗（透明度更低）
      expect(darkerGlassAlpha).toBeLessThan(defaultGlassAlpha);
    });

    it('浅色模式应提高玻璃亮度', () => {
      const defaultConfig: ThemeConfig = { ...DEFAULT_THEME_CONFIG, colorDepth: 'default' };
      const lighterConfig: ThemeConfig = { ...DEFAULT_THEME_CONFIG, colorDepth: 'lighter' };

      const defaultVars = computeThemeVars(defaultConfig);
      const lighterVars = computeThemeVars(lighterConfig);

      const extractAlpha = (rgba: string) => {
        const match = rgba.match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/);
        return match ? parseFloat(match[1]) : 0;
      };

      const defaultGlassAlpha = extractAlpha(defaultVars['--glass-bg-start']);
      const lighterGlassAlpha = extractAlpha(lighterVars['--glass-bg-start']);

      // 浅色模式的玻璃应该更亮（透明度更高）
      expect(lighterGlassAlpha).toBeGreaterThan(defaultGlassAlpha);
    });

    it('glassBrightness 倍数应按预期工作', () => {
      expect(COLOR_DEPTH_MAP.darker.glassBrightness).toBeLessThan(1);
      expect(COLOR_DEPTH_MAP.default.glassBrightness).toBe(1);
      expect(COLOR_DEPTH_MAP.lighter.glassBrightness).toBeGreaterThan(1);
    });
  });

  describe('边框透明度倍数计算验证', () => {
    it('solid 透明度应增加边框透明度', () => {
      const defaultConfig: ThemeConfig = { ...DEFAULT_THEME_CONFIG, opacity: 'default' };
      const solidConfig: ThemeConfig = { ...DEFAULT_THEME_CONFIG, opacity: 'solid' };

      const defaultVars = computeThemeVars(defaultConfig);
      const solidVars = computeThemeVars(solidConfig);

      const extractAlpha = (rgba: string) => {
        const match = rgba.match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/);
        return match ? parseFloat(match[1]) : 0;
      };

      const defaultBorderAlpha = extractAlpha(defaultVars['--border-default']);
      const solidBorderAlpha = extractAlpha(solidVars['--border-default']);

      expect(solidBorderAlpha).toBeGreaterThan(defaultBorderAlpha);
    });

    it('translucent 透明度应减少边框透明度', () => {
      const defaultConfig: ThemeConfig = { ...DEFAULT_THEME_CONFIG, opacity: 'default' };
      const translucentConfig: ThemeConfig = { ...DEFAULT_THEME_CONFIG, opacity: 'translucent' };

      const defaultVars = computeThemeVars(defaultConfig);
      const translucentVars = computeThemeVars(translucentConfig);

      const extractAlpha = (rgba: string) => {
        const match = rgba.match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/);
        return match ? parseFloat(match[1]) : 0;
      };

      const defaultBorderAlpha = extractAlpha(defaultVars['--border-default']);
      const translucentBorderAlpha = extractAlpha(translucentVars['--border-default']);

      expect(translucentBorderAlpha).toBeLessThan(defaultBorderAlpha);
    });
  });

  describe('配置一致性验证', () => {
    it('所有透明度级别应在所有映射中定义', () => {
      const levels: OpacityLevel[] = ['solid', 'default', 'translucent'];

      for (const level of levels) {
        // OPACITY_MAP
        expect(OPACITY_MAP[level]).toBeDefined();

        // NESTED_BLOCK_STYLES
        expect(NESTED_BLOCK_STYLES.bgAlpha[level]).toBeDefined();
        expect(NESTED_BLOCK_STYLES.borderAlpha[level]).toBeDefined();
        expect(NESTED_BLOCK_STYLES.listItemBgAlpha[level]).toBeDefined();
        expect(NESTED_BLOCK_STYLES.listItemBorderAlpha[level]).toBeDefined();
        expect(NESTED_BLOCK_STYLES.hoverBgAlpha[level]).toBeDefined();
      }
    });

    it('所有色深级别应在 COLOR_DEPTH_MAP 中定义', () => {
      const levels: ColorDepthLevel[] = ['darker', 'default', 'lighter'];

      for (const level of levels) {
        expect(COLOR_DEPTH_MAP[level]).toBeDefined();
      }
    });
  });

  describe('GlassCard CSS 变量集成验证', () => {
    it('计算的玻璃变量应可用于 GlassCard 组件', () => {
      const vars = computeThemeVars(DEFAULT_THEME_CONFIG);

      // GlassCard 使用的关键变量（默认配置：opacity=default, colorDepth=default, glassBrightness=1.0）
      expect(vars['--glass-bg-start']).toMatch(/rgba\(255, 255, 255, 0\.10/);
      expect(vars['--glass-bg-end']).toMatch(/rgba\(255, 255, 255, 0\.05/);
      expect(vars['--glass-border']).toMatch(/rgba\(255, 255, 255, 0\.14/);
    });

    it('修改透明度后玻璃变量应正确更新', () => {
      const solidVars = computeThemeVars({ ...DEFAULT_THEME_CONFIG, opacity: 'solid' });
      const translucentVars = computeThemeVars({ ...DEFAULT_THEME_CONFIG, opacity: 'translucent' });

      const extractAlpha = (rgba: string) => {
        const match = rgba.match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/);
        return match ? parseFloat(match[1]) : 0;
      };

      const solidAlpha = extractAlpha(solidVars['--glass-bg-start']);
      const translucentAlpha = extractAlpha(translucentVars['--glass-bg-start']);

      // solid 应有更高的透明度值
      expect(solidAlpha).toBeGreaterThan(translucentAlpha);
    });

    it('修改色深后玻璃变量应正确更新', () => {
      const darkerVars = computeThemeVars({ ...DEFAULT_THEME_CONFIG, colorDepth: 'darker' });
      const lighterVars = computeThemeVars({ ...DEFAULT_THEME_CONFIG, colorDepth: 'lighter' });

      const extractAlpha = (rgba: string) => {
        const match = rgba.match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/);
        return match ? parseFloat(match[1]) : 0;
      };

      const darkerAlpha = extractAlpha(darkerVars['--glass-bg-start']);
      const lighterAlpha = extractAlpha(lighterVars['--glass-bg-start']);

      // 深色模式玻璃更暗，浅色模式玻璃更亮
      expect(darkerAlpha).toBeLessThan(lighterAlpha);
    });
  });
});
