import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react';

const PENDING = '[aria-busy="true"] .cds-card-grid, [aria-busy="true"] .cds-branch-card-grid';
const IDLE = { pending: false, slow: false };
const ListLoadingContext = createContext(IDLE);

/** Lives inside the workspace, never as another app-shell grid row. */
export function ListLoadingFeedback(): JSX.Element | null {
  const { pending, slow } = useContext(ListLoadingContext);
  if (!pending) return null;
  return <div data-list-loading-feedback className="mt-3 h-12 text-sm leading-5 text-muted-foreground">
    {slow ? <p role="status">
      正在等待服务器返回列表数据。
      <button type="button" className="ml-2 underline underline-offset-4" onClick={() => window.location.reload()}>重新加载</button>
    </p> : null}
  </div>;
}

/** Keep a truthful long-wait status across route-chunk and data skeletons. */
export function ListLoadingBoundary({ enabled, children }: { enabled: boolean; children: ReactNode }): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const [feedback, setFeedback] = useState(IDLE);

  useEffect(() => {
    const host = root.current;
    setFeedback(IDLE);
    if (!host || !enabled) return;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const synchronize = () => {
      const next = Boolean(host.querySelector(PENDING));
      if (next === pending) return;
      pending = next;
      clearTimeout(timer);
      setFeedback({ pending, slow: false });
      if (pending) timer = setTimeout(() => setFeedback({ pending: true, slow: true }), 6000);
    };
    const observer = new MutationObserver(synchronize);
    observer.observe(host, { childList: true, subtree: true });
    synchronize();
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [enabled]);

  return <ListLoadingContext.Provider value={enabled ? feedback : IDLE}>
    <div ref={root} className="contents" data-list-loading-boundary>{children}</div>
  </ListLoadingContext.Provider>;
}
