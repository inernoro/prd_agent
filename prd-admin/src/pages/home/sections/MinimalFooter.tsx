import { Github } from 'lucide-react';

/**
 * MinimalFooter — 幕 9 · 极简页脚
 *
 * 一行：左边 logo + 品牌名，右边 GitHub 链接 + 版权。
 * 一条顶部分割线，除此之外什么都没有。
 */
export function MinimalFooter() {
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
            米多 Agent 平台
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
            GitHub
          </a>
          <a href="#hero" className="hover:text-white/80 transition-colors">
            回到顶部
          </a>
          <span
            className="text-white/30"
            style={{ fontFamily: 'var(--font-display)', letterSpacing: '0.05em' }}
          >
            © 2026 MAP
          </span>
        </div>
      </div>
    </footer>
  );
}
