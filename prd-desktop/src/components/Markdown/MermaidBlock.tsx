import { useEffect, useMemo, useRef, useState } from 'react';

type MermaidModule = typeof import('mermaid');
let mermaidModulePromise: Promise<MermaidModule> | null = null;

async function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import('mermaid');
  }
  return mermaidModulePromise;
}

function stripMermaidInitDirective(source: string) {
  // 默认覆盖文档内 init（尤其是 theme/background），保证和应用主题一致
  return source.replace(/^\s*%%\{init:[\s\S]*?\}%%\s*/m, '');
}

function useIsDarkMode() {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));

  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => {
      setIsDark(el.classList.contains('dark'));
    });
    obs.observe(el, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  return isDark;
}

export default function MermaidBlock({ chart }: { chart: string }) {
  const isDark = useIsDarkMode();
  const [error, setError] = useState<string>('');
  const [svg, setSvg] = useState<string>('');
  const renderId = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  const normalized = useMemo(() => (chart || '').trim(), [chart]);
  const cleaned = useMemo(() => stripMermaidInitDirective(normalized), [normalized]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    // 可见时才渲染，避免打开弹窗时一次性渲染所有图表导致卡顿
    const obs = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        setIsVisible(!!entry?.isIntersecting);
      },
      { root: null, rootMargin: '200px', threshold: 0.01 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const id = ++renderId.current;

    const run = async () => {
      setError('');
      // 已渲染过则保持缓存，避免滚动/重新可见时反复渲染
      if (svg) return;

      if (!isVisible) return;
      if (!cleaned) return;

      try {
        const mod = await loadMermaid();
        const mermaid = (mod as any).default ?? (mod as any);

        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: isDark ? 'dark' : 'default',
          themeVariables: {
            background: 'transparent',
          },
        });

        const uniqueId = `mermaid-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const { svg: renderedSvg } = await mermaid.render(uniqueId, cleaned);

        if (cancelled || id !== renderId.current) return;
        setSvg(renderedSvg);
      } catch (e: any) {
        if (cancelled || id !== renderId.current) return;
        setError(e?.message || 'Mermaid 渲染失败');
      }
    };

    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleaned, isDark, isVisible]);

  if (error) {
    return (
      <div ref={rootRef} className="not-prose">
        <div className="text-sm text-red-600 dark:text-red-400 mb-2">{error}</div>
        <pre className="overflow-x-auto rounded-md border border-border bg-gray-50 dark:bg-gray-900 p-3">
          <code className="whitespace-pre">{cleaned}</code>
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div ref={rootRef} className="not-prose text-sm text-text-secondary">
        {isVisible ? '渲染图表中...' : '图表加载中...'}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="not-prose overflow-x-auto"
      // Mermaid 输出为 SVG 字符串
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
