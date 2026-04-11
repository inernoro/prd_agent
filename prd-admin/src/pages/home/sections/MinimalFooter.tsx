import { Github } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';

/**
 * MinimalFooter — 幕 · 极简页脚
 */
export function MinimalFooter() {
  const { t } = useLanguage();
  return (
    <footer
      className="relative border-t border-white/[0.06] py-10 px-6"
      style={{ fontFamily: 'var(--font-body)' }}
    >
      <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-5">
        {/* Brand */}
        <div className="flex items-center gap-3">
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center text-[9px] font-bold text-white"
            style={{
              background: 'linear-gradient(135deg, #00f0ff 0%, #7c3aed 50%, #f43f5e 100%)',
              fontFamily: 'var(--font-display)',
              letterSpacing: '-0.02em',
            }}
          >
            MAP
          </div>
          <div
            className="text-[12.5px] text-white/65"
            style={{ fontFamily: 'var(--font-display)', letterSpacing: '0.01em' }}
          >
            {t.footer.brand}
          </div>
        </div>

        {/* Links */}
        <div className="flex items-center gap-7 text-[11.5px] text-white/40">
          <a
            href="https://github.com/inernoro/prd_agent"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 hover:text-white/80 transition-colors"
          >
            <Github className="w-3.5 h-3.5" />
            {t.footer.github}
          </a>
          <a href="#hero" className="hover:text-white/80 transition-colors">
            {t.footer.backToTop}
          </a>
          <span
            className="text-white/30"
            style={{ fontFamily: 'var(--font-display)', letterSpacing: '0.05em' }}
          >
            {t.footer.copyright}
          </span>
        </div>
      </div>
    </footer>
  );
}
