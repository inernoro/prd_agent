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
const ADMIN_ROOT = path.resolve(TEST_DIR, '../../..');
const TOKENS_PATH = path.resolve(TEST_DIR, '../../styles/tokens.css');
const MOBILE_COMPAT_GATE_PATH = path.resolve(TEST_DIR, '../../components/MobileCompatGate.tsx');
const COMMAND_PALETTE_PATH = path.resolve(TEST_DIR, '../../components/command-palette/CommandPalette.tsx');
const TEAM_ACTIVITY_DIR = path.resolve(TEST_DIR, '../../pages/team-activity');

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const linear = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrastRatio(foreground: string, background: string): number {
  const light = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const dark = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (light + 0.05) / (dark + 0.05);
}

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
    const darkBlock = tokens.slice(0, tokens.indexOf('[data-theme="light"]'));
    const lightBlock = tokens.slice(
      tokens.indexOf('[data-theme="light"]'),
      tokens.indexOf('/* 固定暗色可视化表面'),
    );
    const artworkTokenPattern = /--agent-card-artwork-[^:]+:\s*url\('\.\.\/assets\/agent-card-art\/[^']+\.webp'\);/g;

    expect(tokens).toContain('[data-material="solid"]');
    expect(lightBlock).toContain('--bg-base:');
    expect(darkBlock.match(artworkTokenPattern)).toHaveLength(23);
    expect(lightBlock.match(artworkTokenPattern)).toHaveLength(23);
    expect(lightBlock.match(/agent-card-art\/[a-z-]+-light\.webp/g)).toHaveLength(23);
    expect(lightBlock).toContain('--media-art-filter:');
    expect(lightBlock).toContain('--media-art-wash: linear-gradient(135deg, transparent, transparent)');
    expect(lightBlock).toContain('--text-on-media:');
    expect(lightBlock).not.toContain('brightness(1.48)');
    expect(lightBlock).not.toMatch(/#fff(?:fff)?\b/i);
    expect(lightBlock).not.toContain('rgba(255, 255, 255');
    expect(lightBlock).not.toContain('!important');
  });

  it('浅色主题语义文字保持可读，并为固定暗色可视化提供单一表面契约', () => {
    const tokens = fs.readFileSync(TOKENS_PATH, 'utf8');
    const lightBlock = tokens.slice(
      tokens.indexOf('[data-theme="light"]'),
      tokens.indexOf('/* 固定暗色可视化表面'),
    );
    const semanticNames = [
      'success',
      'warning',
      'danger',
      'info',
      'neutral',
      'purple',
      'pink',
      'orange',
      'cyan',
      'indigo',
    ];

    semanticNames.forEach((name) => {
      const match = lightBlock.match(new RegExp(`--semantic-${name}-text:\\s*(#[0-9a-fA-F]{6})`));
      expect(match?.[1]).toBeTruthy();
      expect(contrastRatio(match![1], '#F8F5EF')).toBeGreaterThanOrEqual(4.5);
    });
    expect(lightBlock).toContain('--workflow-accent-text-lightness: 36%');
    const selectionText = lightBlock.match(/--selection-text:\s*(#[0-9a-fA-F]{6})/)?.[1];
    expect(selectionText).toBeTruthy();
    expect(contrastRatio(selectionText!, '#F8F5EF')).toBeGreaterThanOrEqual(4.5);
    expect(tokens).toContain('.surface-tone-dark');
    expect(tokens).toContain('--workflow-accent-text-lightness: 65%');
  });

  it('关键自适应入口禁止回退为固定暗色表面或低对比小字', () => {
    const commandPalette = fs.readFileSync(COMMAND_PALETTE_PATH, 'utf8');
    const teamActivity = fs.readdirSync(TEAM_ACTIVITY_DIR)
      .filter((name) => name.endsWith('.tsx'))
      .map((name) => fs.readFileSync(path.join(TEAM_ACTIVITY_DIR, name), 'utf8'))
      .join('\n');

    expect(commandPalette).toContain('variant="raised"');
    expect(commandPalette).toContain('className="surface-backdrop"');
    expect(commandPalette).not.toMatch(/linear-gradient\([^\n]*(?:22,22,28|15,16,20)/);
    expect(commandPalette).not.toMatch(/var\(--text-primary,\s*#fff\)/);

    expect(teamActivity).not.toContain('tone="dark"');
    expect(teamActivity).not.toContain('surface-tone-dark');
    expect(teamActivity).not.toMatch(/text-white\/(?:[1-4]?\d|5[0-5])\b/);
    expect(teamActivity).not.toMatch(/bg-\[#(?:0c0d0f|16171a|16171b|1a1c20)\]/i);
  });

  it('测试与正式镜像共用同一构建入口，并完整复制浅色插画产物', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(ADMIN_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const dockerfile = fs.readFileSync(path.join(ADMIN_ROOT, 'Dockerfile'), 'utf8');
    const artworkDir = path.join(ADMIN_ROOT, 'src/assets/agent-card-art');
    const lightArtwork = fs.readdirSync(artworkDir).filter((name) => name.endsWith('-light.webp'));

    expect(packageJson.scripts.build).toBe('tsc && vite build');
    expect(dockerfile).toContain('pnpm run build');
    expect(dockerfile).toContain('COPY --from=builder /app/dist ./dist');
    expect(lightArtwork).toHaveLength(23);
  });

  it('移动端兼容提示复用跨主题语义色与固定暗色表面契约', () => {
    const gate = fs.readFileSync(MOBILE_COMPAT_GATE_PATH, 'utf8');

    expect(gate).toContain("color: 'var(--semantic-warning-text)'");
    expect(gate).toContain('className="surface-tone-dark w-full max-w-md rounded-2xl p-5"');
    expect(gate).toContain('data-surface-tone="dark"');
    expect(gate).not.toContain("color: 'rgba(255, 236, 179");
  });
});
