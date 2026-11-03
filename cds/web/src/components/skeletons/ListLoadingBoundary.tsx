import { type ReactNode, useEffect, useRef, useState } from 'react';

const PENDING = '[aria-busy="true"] .cds-card-grid, [aria-busy="true"] .cds-branch-card-grid';

/** Keep a truthful long-wait status across route-chunk and data skeletons. */
export function ListLoadingBoundary({ enabled, children }: { enabled: boolean; children: ReactNode }): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const host = root.current;
    setSlow(false);
    if (!host || !enabled) return;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const synchronize = () => {
      const next = Boolean(host.querySelector(PENDING));
      if (next === pending) return;
      pending = next;
      clearTimeout(timer);
      setSlow(false);
      if (pending) timer = setTimeout(() => setSlow(true), 6000);
    };
    const observer = new MutationObserver(synchronize);
    observer.observe(host, { childList: true, subtree: true });
    synchronize();
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [enabled]);

  return <div ref={root} className="contents" data-list-loading-boundary>
    {children}
    {slow ? <p role="status" className="col-span-full px-6 pb-4 text-sm text-muted-foreground">
      正在等待服务器返回列表数据。
      <button type="button" className="ml-2 underline underline-offset-4" onClick={() => window.location.reload()}>重新加载</button>
    </p> : null}
  </div>;
}
