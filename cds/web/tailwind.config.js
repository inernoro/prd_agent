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
