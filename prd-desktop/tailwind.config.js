/** @type {import('tailwindcss').Config} */
import typography from '@tailwindcss/typography';

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      typography: {
        DEFAULT: {
          css: {
            '--tw-prose-body': 'var(--md-text)',
            '--tw-prose-headings': 'var(--md-text)',
            '--tw-prose-lead': 'var(--md-text)',
            '--tw-prose-links': 'var(--md-link)',
            '--tw-prose-bold': 'var(--md-text)',
            '--tw-prose-counters': 'var(--md-muted)',
            '--tw-prose-bullets': 'var(--md-muted)',
            '--tw-prose-hr': 'var(--md-border)',
            '--tw-prose-quotes': 'var(--md-text)',
            '--tw-prose-quote-borders': 'var(--md-quote-border)',
            '--tw-prose-captions': 'var(--md-muted)',
            '--tw-prose-code': 'var(--md-inline-code-text)',
            '--tw-prose-pre-code': 'var(--md-code-text)',
            '--tw-prose-pre-bg': 'var(--md-code-bg)',
            '--tw-prose-th-borders': 'var(--md-border)',
            '--tw-prose-td-borders': 'var(--md-border)',
            code: {
              backgroundColor: 'var(--md-inline-code-bg)',
              borderRadius: '0.375rem',
              padding: '0.15em 0.35em',
              fontWeight: '500',
            },
            'code::before': { content: '""' },
            'code::after': { content: '""' },
            pre: {
              border: '1px solid var(--md-border)',
              borderRadius: '0.75rem',
            },
            a: {
              textDecoration: 'underline',
              textUnderlineOffset: '2px',
            },
          },
        },
        invert: {
          css: {
            // 我们使用 CSS tokens 控制深色配色，因此这里不做额外 hardcode，避免反复打架
            '--tw-prose-body': 'var(--md-text)',
            '--tw-prose-headings': 'var(--md-text)',
            '--tw-prose-lead': 'var(--md-text)',
            '--tw-prose-links': 'var(--md-link)',
            '--tw-prose-bold': 'var(--md-text)',
            '--tw-prose-counters': 'var(--md-muted)',
            '--tw-prose-bullets': 'var(--md-muted)',
            '--tw-prose-hr': 'var(--md-border)',
            '--tw-prose-quotes': 'var(--md-text)',
            '--tw-prose-quote-borders': 'var(--md-quote-border)',
            '--tw-prose-captions': 'var(--md-muted)',
            '--tw-prose-code': 'var(--md-inline-code-text)',
            '--tw-prose-pre-code': 'var(--md-code-text)',
            '--tw-prose-pre-bg': 'var(--md-code-bg)',
            '--tw-prose-th-borders': 'var(--md-border)',
            '--tw-prose-td-borders': 'var(--md-border)',
          },
        },
      },
      colors: {
        primary: {
          50: '#f0f9ff',
          100: '#e0f2fe',
          200: '#bae6fd',
          300: '#7dd3fc',
          400: '#38bdf8',
          500: '#0ea5e9',
          600: '#0284c7',
          700: '#0369a1',
          800: '#075985',
          900: '#0c4a6e',
          950: '#082f49',
        },
        // 语义色：由 CSS tokens 驱动，避免浅色/深色反复打补丁
        text: {
          primary: 'var(--color-text)',
          secondary: 'var(--color-text-secondary)',
        },
        border: 'var(--color-border)',
        surface: {
          light: '#ffffff',
          dark: '#1a1a2e',
        },
        background: {
          light: '#f8fafc',
          dark: '#0f0f1a',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [typography],
};
