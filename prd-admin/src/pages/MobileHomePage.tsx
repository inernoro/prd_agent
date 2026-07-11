/**
 * 移动端首页（<768px）—— 双模板试运行外壳。
 *
 * 两个模板共享同一份真实数据（useMobileHomeData），页内右上角可即时切换：
 *  - 「早报」  MorningPostTemplate：米多刊系纸墨版式（暖纸 + 衬线 + 赭红），
 *              挂载期把全局主题切到白天 token。
 *  - 「工作台」ConsoleTemplate：暗色高密度控制台，背景交还 AppShell 极光层。
 *
 * 模板选择仅存 sessionStorage（.claude/rules/no-localstorage.md 默认规则），
 * 定稿后删掉未选中的模板与本切换器。
 */
import { useState } from 'react';
import MorningPostTemplate from '@/pages/mobile-home/MorningPostTemplate';
import ConsoleTemplate from '@/pages/mobile-home/ConsoleTemplate';
import {
  readTemplatePreference,
  writeTemplatePreference,
  useMobileHomeData,
  type MobileHomeTemplateKey,
} from '@/pages/mobile-home/shared';

const OPTIONS: Array<{ key: MobileHomeTemplateKey; label: string }> = [
  { key: 'post', label: '早报' },
  { key: 'console', label: '工作台' },
];

export default function MobileHomePage() {
  const [template, setTemplate] = useState<MobileHomeTemplateKey>(() => readTemplatePreference());
  const data = useMobileHomeData();

  const switchTo = (key: MobileHomeTemplateKey) => {
    setTemplate(key);
    writeTemplatePreference(key);
  };

  const switcher = (
    <TemplateSwitcher current={template} onSwitch={switchTo} tone={template === 'post' ? 'paper' : 'dark'} />
  );

  return template === 'post' ? (
    <MorningPostTemplate data={data} switcher={switcher} />
  ) : (
    <ConsoleTemplate data={data} switcher={switcher} />
  );
}

/** 模板切换段控：随宿主模板换肤（纸面用油墨描边，暗色用白色透明层） */
function TemplateSwitcher({
  current,
  onSwitch,
  tone,
}: {
  current: MobileHomeTemplateKey;
  onSwitch: (key: MobileHomeTemplateKey) => void;
  tone: 'paper' | 'dark';
}) {
  const ink = tone === 'paper';
  return (
    <div
      className="flex shrink-0 items-center overflow-hidden"
      role="tablist"
      aria-label="首页模板切换"
      style={{
        borderRadius: 999,
        border: `1px solid ${ink ? 'rgba(33,29,24,0.35)' : 'rgba(255,255,255,0.16)'}`,
        background: ink ? 'rgba(255,253,248,0.9)' : 'rgba(255,255,255,0.07)',
      }}
    >
      {OPTIONS.map((opt) => {
        const active = opt.key === current;
        return (
          <button
            key={opt.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSwitch(opt.key)}
            className="min-h-[30px] transition-opacity active:opacity-70"
            style={{
              padding: '5px 11px',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.02em',
              color: active
                ? ink
                  ? '#fffdf8'
                  : '#1a1206'
                : ink
                  ? 'rgba(33,29,24,0.6)'
                  : 'rgba(245,245,247,0.62)',
              background: active ? (ink ? '#c05b3c' : '#FF9F0A') : 'transparent',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
