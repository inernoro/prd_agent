/**
 * 皮肤/主题编辑器组件
 * 允许用户配置色深、透明度、glow 效果等
 */

import { GlassCard } from '@/components/design/GlassCard';
import { glassPanel } from '@/lib/glassStyles';
import { useThemeStore } from '@/stores/themeStore';
import {
  COLOR_DEPTH_MAP,
  OPACITY_MAP,
  SIDEBAR_GLASS_OPTIONS,
  PERFORMANCE_MODE_OPTIONS,
  type ColorDepthLevel,
  type OpacityLevel,
  type SidebarGlassMode,
  type PerformanceMode,
} from '@/types/theme';
import { isWindowsPlatform } from '@/lib/themeApplier';
import { RotateCcw, Sparkles, Palette, Layers, PanelLeft, Save, Gauge } from 'lucide-react';

export function ThemeSkinEditor() {
  const { config, setConfig, reset, saving } = useThemeStore();

  return (
    <GlassCard glow animated accentHue={234} className="h-full flex flex-col">
      {/* 标题栏 */}
      <div className="flex items-center justify-between gap-3 mb-6">
        <div>
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
            皮肤设置
          </h2>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            自定义界面外观与主题配色
          </p>
        </div>
        <div className="flex items-center gap-2">
          {saving && (
            <span className="text-xs flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
              <Save size={12} className="animate-pulse" />
              保存中...
            </span>
          )}
          <button
            onClick={reset}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
            style={{
              background: 'rgba(255, 255, 255, 0.06)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              color: 'var(--text-secondary)',
            }}
          >
            <RotateCcw size={12} />
            重置默认
          </button>
        </div>
      </div>

      {/* 设置项网格 */}
      <div className="flex-1 overflow-y-auto space-y-6">
        {/* 色深选择 */}
        <SettingSection
          icon={<Palette size={14} />}
          title="色深"
          description="调整界面背景的深浅程度"
        >
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(COLOR_DEPTH_MAP) as ColorDepthLevel[]).map((level) => {
              const item = COLOR_DEPTH_MAP[level];
              const isActive = config.colorDepth === level;
              return (
                <button
                  key={level}
                  onClick={() => setConfig({ colorDepth: level })}
                  className="p-3 rounded-lg transition-all text-left"
                  style={{
                    background: isActive
                      ? 'rgba(99, 102, 241, 0.15)'
                      : 'rgba(255, 255, 255, 0.04)',
                    border: `1px solid ${isActive ? 'rgba(99, 102, 241, 0.4)' : 'rgba(255, 255, 255, 0.08)'}`,
                  }}
                >
                  <div
                    className="w-full h-6 rounded mb-2"
                    style={{ background: item.bgBase }}
                  />
                  <div
                    className="text-xs font-medium"
                    style={{ color: isActive ? 'var(--accent-gold)' : 'var(--text-primary)' }}
                  >
                    {item.label}
                  </div>
                </button>
              );
            })}
          </div>
        </SettingSection>

        {/* 透明度选择 */}
        <SettingSection
          icon={<Layers size={14} />}
          title="透明度"
          description="调整玻璃效果的透明程度"
        >
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(OPACITY_MAP) as OpacityLevel[]).map((level) => {
              const item = OPACITY_MAP[level];
              const isActive = config.opacity === level;
              return (
                <button
                  key={level}
                  onClick={() => setConfig({ opacity: level })}
                  className="p-3 rounded-lg transition-all text-left"
                  style={{
                    background: isActive
                      ? 'rgba(99, 102, 241, 0.15)'
                      : 'rgba(255, 255, 255, 0.04)',
                    border: `1px solid ${isActive ? 'rgba(99, 102, 241, 0.4)' : 'rgba(255, 255, 255, 0.08)'}`,
                  }}
                >
                  <div
                    className="w-full h-6 rounded mb-2 relative overflow-hidden"
                    style={{
                      background: `linear-gradient(180deg, rgba(255,255,255,${item.glassStart}) 0%, rgba(255,255,255,${item.glassEnd}) 100%)`,
                      border: `1px solid rgba(255, 255, 255, ${item.border})`,
                    }}
                  >
                    {/* 模拟背景网格 */}
                    <div
                      className="absolute inset-0"
                      style={{
                        backgroundImage: `
                          linear-gradient(45deg, rgba(255,255,255,0.05) 25%, transparent 25%),
                          linear-gradient(-45deg, rgba(255,255,255,0.05) 25%, transparent 25%),
                          linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.05) 75%),
                          linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.05) 75%)
                        `,
                        backgroundSize: '8px 8px',
                        backgroundPosition: '0 0, 0 4px, 4px -4px, -4px 0',
                      }}
                    />
                  </div>
                  <div
                    className="text-xs font-medium"
                    style={{ color: isActive ? 'var(--accent-gold)' : 'var(--text-primary)' }}
                  >
                    {item.label}
                  </div>
                </button>
              );
            })}
          </div>
        </SettingSection>

        {/* Glow 效果开关 */}
        <SettingSection
          icon={<Sparkles size={14} />}
          title="光晕效果"
          description="卡片顶部的渐变光晕"
        >
          <div className="flex items-center gap-3">
            <button
              onClick={() => setConfig({ enableGlow: true })}
              className="flex-1 p-3 rounded-lg transition-all flex items-center justify-center gap-2"
              style={{
                background: config.enableGlow
                  ? 'rgba(99, 102, 241, 0.15)'
                  : 'rgba(255, 255, 255, 0.04)',
                border: `1px solid ${config.enableGlow ? 'rgba(99, 102, 241, 0.4)' : 'rgba(255, 255, 255, 0.08)'}`,
              }}
            >
              <Sparkles
                size={14}
                style={{ color: config.enableGlow ? 'var(--accent-gold)' : 'var(--text-muted)' }}
              />
              <span
                className="text-xs font-medium"
                style={{ color: config.enableGlow ? 'var(--accent-gold)' : 'var(--text-primary)' }}
              >
                启用
              </span>
            </button>
            <button
              onClick={() => setConfig({ enableGlow: false })}
              className="flex-1 p-3 rounded-lg transition-all flex items-center justify-center gap-2"
              style={{
                background: !config.enableGlow
                  ? 'rgba(99, 102, 241, 0.15)'
                  : 'rgba(255, 255, 255, 0.04)',
                border: `1px solid ${!config.enableGlow ? 'rgba(99, 102, 241, 0.4)' : 'rgba(255, 255, 255, 0.08)'}`,
              }}
            >
              <span
                className="text-xs font-medium"
                style={{ color: !config.enableGlow ? 'var(--accent-gold)' : 'var(--text-primary)' }}
              >
                禁用
              </span>
            </button>
          </div>
        </SettingSection>

        {/* 侧边栏玻璃效果 */}
        <SettingSection
          icon={<PanelLeft size={14} />}
          title="侧边栏玻璃效果"
          description="控制侧边栏的液态玻璃效果"
        >
          <div className="space-y-2">
            {SIDEBAR_GLASS_OPTIONS.map((option) => {
              const isActive = config.sidebarGlass === option.value;
              return (
                <button
                  key={option.value}
                  onClick={() => setConfig({ sidebarGlass: option.value as SidebarGlassMode })}
                  className="w-full p-3 rounded-lg transition-all text-left"
                  style={{
                    background: isActive
                      ? 'rgba(99, 102, 241, 0.15)'
                      : 'rgba(255, 255, 255, 0.04)',
                    border: `1px solid ${isActive ? 'rgba(99, 102, 241, 0.4)' : 'rgba(255, 255, 255, 0.08)'}`,
                  }}
                >
                  <div
                    className="text-xs font-medium"
                    style={{ color: isActive ? 'var(--accent-gold)' : 'var(--text-primary)' }}
                  >
                    {option.label}
                  </div>
                  <div
                    className="text-xs mt-0.5"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {option.description}
                  </div>
                </button>
              );
            })}
          </div>
        </SettingSection>

        {/* 性能模式 */}
        <SettingSection
          icon={<Gauge size={14} />}
          title="性能模式"
          description={isWindowsPlatform() ? 'Windows 检测到，建议使用自动或性能优先' : '调整渲染特效强度'}
        >
          <div className="space-y-2">
            {PERFORMANCE_MODE_OPTIONS.map((option) => {
              const isActive = config.performanceMode === option.value;
              return (
                <button
                  key={option.value}
                  onClick={() => setConfig({ performanceMode: option.value as PerformanceMode })}
                  className="w-full p-3 rounded-lg transition-all text-left"
                  style={{
                    background: isActive
                      ? 'rgba(99, 102, 241, 0.15)'
                      : 'rgba(255, 255, 255, 0.04)',
                    border: `1px solid ${isActive ? 'rgba(99, 102, 241, 0.4)' : 'rgba(255, 255, 255, 0.08)'}`,
                  }}
                >
                  <div
                    className="text-xs font-medium"
                    style={{ color: isActive ? 'var(--accent-gold)' : 'var(--text-primary)' }}
                  >
                    {option.label}
                  </div>
                  <div
                    className="text-xs mt-0.5"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {option.description}
                  </div>
                </button>
              );
            })}
          </div>
        </SettingSection>

        {/* 实时预览 */}
        <SettingSection
          icon={<Palette size={14} />}
          title="实时预览"
          description="当前配置的效果预览"
        >
          <div className="grid grid-cols-2 gap-3">
            {/* 预览卡片 1 - 默认 */}
            <div
              className="p-3 rounded-lg"
              style={{
                ...glassPanel,
                background: `linear-gradient(180deg, var(--glass-bg-start, rgba(255,255,255,0.08)) 0%, var(--glass-bg-end, rgba(255,255,255,0.03)) 100%)`,
                border: `1px solid var(--glass-border, rgba(255,255,255,0.14))`,
              }}
            >
              <div className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                默认卡片
              </div>
              <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                标准液态玻璃效果
              </div>
            </div>

            {/* 预览卡片 2 - 带 Glow */}
            <div
              className="p-3 rounded-lg relative overflow-hidden"
              style={{
                ...glassPanel,
                background: config.enableGlow
                  ? `radial-gradient(ellipse 100% 60% at 50% -10%, rgba(99, 102, 241, 0.25) 0%, transparent 65%), linear-gradient(180deg, var(--glass-bg-start, rgba(255,255,255,0.08)) 0%, var(--glass-bg-end, rgba(255,255,255,0.03)) 100%)`
                  : `linear-gradient(180deg, var(--glass-bg-start, rgba(255,255,255,0.08)) 0%, var(--glass-bg-end, rgba(255,255,255,0.03)) 100%)`,
                border: `1px solid var(--glass-border, rgba(255,255,255,0.14))`,
              }}
            >
              <div className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                光晕卡片
              </div>
              <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                {config.enableGlow ? '已启用光晕' : '光晕已禁用'}
              </div>
            </div>
          </div>
        </SettingSection>
      </div>
    </GlassCard>
  );
}

/** 设置项区块组件 */
function SettingSection({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span style={{ color: 'var(--accent-gold)' }}>{icon}</span>
        <div>
          <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            {title}
          </div>
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {description}
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}
