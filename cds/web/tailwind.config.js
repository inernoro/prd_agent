/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '1rem' },
    extend: {
      // Tailwind 默认档只有 xl(1280) 和 2xl(1536)，中间空了 256px。
      // 三栏这类「宽了才成立」的布局卡在这段里：1280 勉强、1536 才舒服，
      // 中间的 1440（最常见的笔记本外接屏）无处安放。补一档。
      screens: { wide: '1440px' },
      colors: {
        // CDS design tokens — single source of truth.
        // Resolves to CSS custom properties in src/index.css. Both dark and
        // light themes define every token, no fallbacks. See
        // .claude/rules/cds-theme-tokens.md for the rationale: writing a hex
        // color anywhere outside index.css is forbidden.
        border: 'hsl(var(--border) / <alpha-value>)',
        input: 'hsl(var(--input) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
        background: 'hsl(var(--background) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        primary: {
          DEFAULT: 'hsl(var(--primary) / <alpha-value>)',
          foreground: 'hsl(var(--primary-foreground) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary) / <alpha-value>)',
          foreground: 'hsl(var(--secondary-foreground) / <alpha-value>)',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive) / <alpha-value>)',
          foreground: 'hsl(var(--destructive-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted) / <alpha-value>)',
          foreground: 'hsl(var(--muted-foreground) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent) / <alpha-value>)',
          foreground: 'hsl(var(--accent-foreground) / <alpha-value>)',
        },
        card: {
          DEFAULT: 'hsl(var(--card) / <alpha-value>)',
          foreground: 'hsl(var(--card-foreground) / <alpha-value>)',
        },

        // 状态语义色。**颜色本身已回归改动前那套**（emerald / amber / red / sky），
        // 这一层保留的是「组件不再硬编码调色板」这个结构收益：
        //
        // 硬编码的 emerald-600 不跟主题走，每处都得写成
        // `text-emerald-600 dark:text-emerald-400` 双主题对，漏一半就在某个主题
        // 下看不清；换配色时它们也全部留在原地。收成 token 之后组件里写
        // `text-ok` 一个类就够，以后要微调某一档只改 index.css 一处。
        //
        // 每档两个值：DEFAULT 是实色（圆点 / 图标 / 进度条 / 文字），
        // soft 是整块底色（行底、提示条底、徽章底）。
        ok: {
          DEFAULT: 'hsl(var(--ok) / <alpha-value>)',
          soft: 'hsl(var(--ok-soft) / <alpha-value>)',
        },
        warn: {
          DEFAULT: 'hsl(var(--warn) / <alpha-value>)',
          soft: 'hsl(var(--warn-soft) / <alpha-value>)',
        },
        bad: {
          DEFAULT: 'hsl(var(--bad) / <alpha-value>)',
          soft: 'hsl(var(--bad-soft) / <alpha-value>)',
        },
        info: {
          DEFAULT: 'hsl(var(--info) / <alpha-value>)',
          soft: 'hsl(var(--info-soft) / <alpha-value>)',
        },

        // 主色的两个补充档：soft 是低饱和底（选中态/徽章底），
        // ink 是「主色文字」——见下方 textColor 的说明。
        'primary-soft': 'hsl(var(--primary-soft) / <alpha-value>)',
        'primary-ink': 'hsl(var(--primary-ink) / <alpha-value>)',
        'foreground-muted': 'hsl(var(--foreground-muted) / <alpha-value>)',
        code: {
          DEFAULT: 'hsl(var(--code-bg) / <alpha-value>)',
          foreground: 'hsl(var(--code-fg) / <alpha-value>)',
        },
      },
      // 主色**文字**单独走 --primary-ink。
      //
      // 填充色（bg-primary）和文字色对对比度的要求不一样：白天的橙色
      // 24 90% 50% 当按钮底很好看，当文字落在浅底上只有约 3:1，偏弱——
      // 「有些按钮都看不清了」就是这么来的。所以文字单独压深两档；
      // 暗色下两者同值，零变化。bg-primary / border-primary 不受影响。
      textColor: {
        primary: 'hsl(var(--primary-ink) / <alpha-value>)',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      // 字体两档，定义在 index.css：sans 管正文（自托管 Inter），
      // mono 管标识符（自托管 JetBrains Mono）。两个键都指回 token，
      // 不在这里再写一份栈——此前它们各写一份、且都点名了仓库没打包的字体。
      fontFamily: {
        sans: ['var(--cds-font-sans)', 'var(--cds-font-cjk)'],
        mono: ['var(--cds-font-mono)'],
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
