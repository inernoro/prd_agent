import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { translations, type Lang, type TranslationShape } from '../i18n/landing';

interface LanguageContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: TranslationShape;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

const STORAGE_KEY = 'map:landing:lang';

/**
 * LanguageProvider — 首页 /home 语言切换容器
 *
 * - 默认中文 zh
 * - 记忆：sessionStorage（项目禁用 localStorage，刷新 tab 不丢失）
 * - 挂在 LandingPage 根节点，仅影响首页
 * - 切换时通过 <html lang="xx"> 更新浏览器语言提示
 */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    if (typeof window === 'undefined') return 'zh';
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      return stored === 'en' || stored === 'zh' ? stored : 'zh';
    } catch {
      return 'zh';
    }
  });

  const setLang = (next: Lang) => {
    setLangState(next);
    try {
      sessionStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    try {
      document.documentElement.setAttribute('lang', lang === 'en' ? 'en' : 'zh-CN');
    } catch {
      /* ignore */
    }
  }, [lang]);

  return (
    <LanguageContext.Provider value={{ lang, setLang, t: translations[lang] }}>
      {children}
    </LanguageContext.Provider>
  );
}

/**
 * useLanguage — 首页 section 内取当前语言 + 文案字典
 *
 * 必须在 <LanguageProvider> 内使用。默认兜底返回 zh，
 * 保证组件在 Provider 不存在时不崩溃（单元测试 / 预览友好）。
 */
export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (ctx) return ctx;
  return {
    lang: 'zh',
    setLang: () => {
      /* no-op fallback */
    },
    t: translations.zh,
  };
}
