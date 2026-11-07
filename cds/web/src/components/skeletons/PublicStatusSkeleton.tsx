import { useEffect, useState } from 'react';

export function PublicStatusSkeleton(): JSX.Element {
    const [slow,setSlow]=useState(false);
    useEffect(()=>{const timer=window.setTimeout(()=>setSlow(true),6000);return()=>window.clearTimeout(timer);},[]);
    return (
      <div data-public-status-skeleton role="status" aria-busy="true" aria-label="读取公开状态" className="min-h-screen bg-background px-4 py-8 sm:px-6 sm:py-12">
        <div className="mx-auto w-full max-w-2xl">
          <div className="cds-loading-skeleton-line h-6 w-40 rounded" />
          <div className="mt-4 cds-loading-skeleton-line h-14 w-full rounded-lg" />
          <div className="mt-4 space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="cds-loading-skeleton-line h-12 w-full rounded-lg" style={{ animationDelay: `${i * 90}ms` }} />
            ))}
          </div>
          <p className="mt-4 h-4 text-xs text-muted-foreground" aria-live="polite">{slow ? '仍在读取…' : null}</p>
        </div>
      </div>
    );
}
