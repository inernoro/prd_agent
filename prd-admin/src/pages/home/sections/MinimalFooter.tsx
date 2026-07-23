import { Github } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';

/**
 * MinimalFooter — 幕 · 极简页脚
 */
export function MinimalFooter() {
  const { t } = useLanguage();
  return (
    <footer
      className="relative border-t border-token-subtle/[0.06] py-10 px-6"
      style={{ fontFamily: 'var(--font-body)' }}
    >
      <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-5">
        {/* Brand */}
        <div className="flex items-center gap-3">
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center text-[9px] font-bold text-token-primary"
            style={{
              background: 'linear-gradient(135deg, #5B8DEF 0%, #7C6CF0 48%, #A78BFA 100%)',
              fontFamily: 'var(--font-display)',
              letterSpacing: '-0.02em',
            }}
          >
            MAP
          </div>
          <div
            className="text-[12.5px] text-token-secondary"
            style={{ fontFamily: 'var(--font-display)', letterSpacing: '0.01em' }}
          >
            {t.footer.brand}
          </div>
        </div>

        {/* Links */}
        <div className="flex items-center gap-7 text-[11.5px] text-token-muted">
          <a
            href="https://github.com/inernoro/prd_agent"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 hover:text-token-primary transition-colors"
          >
            <Github className="w-3.5 h-3.5" />
            {t.footer.github}
          </a>
          <a href="#hero" className="hover:text-token-primary transition-colors">
            {t.footer.backToTop}
          </a>
          <span
            className="text-token-muted"
            style={{ fontFamily: 'var(--font-display)', letterSpacing: '0.05em' }}
          >
            {t.footer.copyright}
          </span>
        </div>
      </div>
    </footer>
  );
}
