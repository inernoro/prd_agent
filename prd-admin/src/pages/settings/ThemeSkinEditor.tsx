/**
 * 皮肤/主题编辑器（2026-07-17 极简重做，用户定）：
 * 用户只决定两件属于"自己"的事——外观（深色/浅色）与界面材质（素色/液态玻璃）。
 * 色深、透明度、光晕、侧边栏玻璃、性能模式是设计参数，由系统统一决定
 * （themeApplier.normalizeThemeConfig 归一化为设计预设），不再转嫁给用户。
 */

import { GlassCard } from '@/components/design/GlassCard';
import { useThemeStore } from '@/stores/themeStore';
import { useMobileThemeStore, type MobileThemeMode } from '@/stores/mobileThemeStore';
import { MATERIAL_OPTIONS, DEFAULT_THEME_CONFIG, type MaterialMode } from '@/types/theme';
import { Moon, Sun, Square, Save } from 'lucide-react';

const APPEARANCE_OPTIONS: Array<{ value: MobileThemeMode; label: string; description: string; icon: React.ReactNode }> = [
  { value: 'dark', label: '深色', description: '夜晚与暗光环境（默认）', icon: <Moon size={14} /> },
  { value: 'light', label: '浅色', description: '白天与明亮环境，纸感浅色', icon: <Sun size={14} /> },
];

export function ThemeSkinEditor() {
  const { config, setConfig, saving } = useThemeStore();
  const appearance = useMobileThemeStore((s) => s.mode);
  const setAppearance = useMobileThemeStore((s) => s.setMode);
  const material = config.material ?? DEFAULT_THEME_CONFIG.material;

  return (
    <GlassCard glow animated accentHue={234} className="h-full flex flex-col">
      {/* 标题栏 */}
      <div className="flex items-center justify-between gap-3 mb-6">
        <div>
          <h2 className="text-base font-semibold text-token-primary">
            皮肤设置
          </h2>
          <p className="mt-1 text-xs text-token-muted">
            两个选择：白天还是黑夜，玻璃还是素色。其余交给系统。
          </p>
        </div>
        {saving && (
          <span className="flex items-center gap-1 text-xs text-token-muted">
            <Save size={12} className="animate-pulse" />
            保存中...
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto space-y-6">
        {/* 外观：深色 / 浅色（全局生效，与首页移动端切换同一偏好） */}
        <SettingSection
          icon={<Sun size={14} />}
          title="外观"
          description="深色或浅色，全站生效"
        >
          <div className="grid grid-cols-2 gap-2">
            {APPEARANCE_OPTIONS.map((option) => {
              const isActive = appearance === option.value;
              return (
                <button
                  key={option.value}
                  onClick={() => setAppearance(option.value)}
                  className="p-3 rounded-lg transition-all text-left"
                  style={{
                    background: isActive
                      ? 'rgba(99, 102, 241, 0.15)'
                      : 'var(--nested-block-bg)',
                    border: `1px solid ${isActive ? 'rgba(99, 102, 241, 0.4)' : 'var(--nested-block-border)'}`,
                  }}
                >
                  <div className={`flex items-center gap-1.5 text-xs font-medium ${isActive ? 'text-token-accent' : 'text-token-primary'}`}>
                    {option.icon}
                    {option.label}
                  </div>
                  <div className="mt-0.5 text-xs text-token-muted">
                    {option.description}
                  </div>
                </button>
              );
            })}
          </div>
        </SettingSection>

        {/* 界面材质：素色 / 液态玻璃（系统级统一调配，一处切换全站跟随） */}
        <SettingSection
          icon={<Square size={14} />}
          title="界面材质"
          description="素色实底或液态玻璃，一处切换全站生效"
        >
          <div className="grid grid-cols-2 gap-2">
            {MATERIAL_OPTIONS.map((option) => {
              const isActive = material === option.value;
              return (
                <button
                  key={option.value}
                  onClick={() => setConfig({ material: option.value as MaterialMode })}
                  className="p-3 rounded-lg transition-all text-left"
                  style={{
                    background: isActive
                      ? 'rgba(99, 102, 241, 0.15)'
                      : 'var(--nested-block-bg)',
                    border: `1px solid ${isActive ? 'rgba(99, 102, 241, 0.4)' : 'var(--nested-block-border)'}`,
                  }}
                >
                  <div className={`text-xs font-medium ${isActive ? 'text-token-accent' : 'text-token-primary'}`}>
                    {option.label}
                  </div>
                  <div className="mt-0.5 text-xs text-token-muted">
                    {option.description}
                  </div>
                </button>
              );
            })}
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
        <span className="text-token-accent">{icon}</span>
        <div>
          <div className="text-sm font-medium text-token-primary">
            {title}
          </div>
          <div className="text-xs text-token-muted">
            {description}
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}
