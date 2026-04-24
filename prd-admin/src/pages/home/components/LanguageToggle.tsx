import { useLanguage } from '../contexts/LanguageContext';
import type { Lang } from '../i18n/landing';

/**
 * LanguageToggle — 顶栏右上角中英切换器
 *
 * 样式：一个胶囊 pill，里面两个小按钮（中 / EN），
 *       当前语言高亮，另一个淡化。仅用于首页。
 */
export function LanguageToggle() {
  const { lang, setLang } = useLanguage();

  return (
    <div
      className="inline-flex items-center p-[3px] rounded-full border border-white/15 bg-white/[0.04] backdrop-blur-md"
      role="group"
      aria-label="Language"
    >
      <ToggleButton label="中" active={lang === 'zh'} onClick={() => setLang('zh')} />
      <ToggleButton label="EN" active={lang === 'en'} onClick={() => setLang('en')} />
    </div>
  );
}

function ToggleButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      type="button"
      className="relative px-3 py-1 rounded-full text-[11.5px] font-medium transition-all duration-200"
      style={{
        color: active ? '#fff' : 'rgba(255, 255, 255, 0.5)',
        background: active
          ? 'linear-gradient(135deg, rgba(168, 85, 247, 0.3), rgba(124, 58, 237, 0.15))'
          : 'transparent',
        border: active ? '1px solid rgba(168, 85, 247, 0.45)' : '1px solid transparent',
        boxShadow: active ? '0 0 14px rgba(168, 85, 247, 0.35)' : 'none',
        fontFamily: 'var(--font-display)',
        letterSpacing: '0.04em',
        minWidth: '32px',
      }}
    >
      {label}
    </button>
  );
}

/** 类型 re-export 方便 import */
export type { Lang };
