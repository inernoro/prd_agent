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

        // 状态语义色（照抄设计稿的 ok / warn / bad，另按同配方补 info）。
        //
        // 为什么必须有这一组：站里此前有 1600+ 处直接写 emerald-600 / amber-500 /
        // red-500 / sky-500。它们**不跟主题走**——换调色板时整站的状态色会留在
        // 原地，与新底色打架；而且每处都得写成 `text-emerald-600 dark:text-emerald-400`
        // 这种双主题对，漏一半就在某个主题下看不清。
        //
        // token 自己会翻主题，所以组件里写 `text-ok` 一个类就够，不用再挂 dark:。
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
        // ink 是「主色文字」——白天那抹亮绿配白底对比度不够，必须用深橄榄。
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
      // bg-primary 用的是那抹亮绿（#c8f04a），配深底的按钮很好看；但同一个颜色
      // 当文字用、落在白天的浅绿底上就几乎读不出来（实测「全环境矩阵」「严重度」
      // 「主目标」三处全糊）。模板为此专门分了 --accent / --accent-ink 两个值，
      // 这里照做：text-primary → ink（白天是深橄榄，黑夜与 primary 同值，
      // 所以黑夜零变化），bg-primary / border-primary 仍用亮绿。
      textColor: {
        primary: 'hsl(var(--primary-ink) / <alpha-value>)',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      // 全站只有一套英文字形，定义在 index.css 的 --cds-font-latin。
      //
      // 这两个键此前各自写了一份栈，而且两份都点名了**仓库从没打包过的字体**
      // （Inter / JetBrains Mono）：装了它们的机器和没装的机器看到的是两种字形，
      // `font-sans` 与 `font-mono` 之间也对不齐。现在都指回同一个 token，
      // 想换字体只改 index.css 那一处（predicate-and-wiring-discipline 形状 3）。
      fontFamily: {
        sans: ['var(--cds-font-latin)', 'var(--cds-font-cjk)'],
        mono: ['var(--cds-font-latin)'],
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
