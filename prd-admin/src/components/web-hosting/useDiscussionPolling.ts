import { useEffect } from 'react';

export function useDiscussionPolling(active: boolean, refresh: () => Promise<boolean>, interval = 30_000) {
  useEffect(() => {
    if (!active) return;
    let timer: number | undefined;
    let busy = false;
    let stopped = false;
    let failures = 0;
    function schedule() {
      window.clearTimeout(timer);
      if (!stopped && !document.hidden) {
        timer = window.setTimeout(run, interval * 2 ** failures);
      }
    }
    async function run() {
      if (stopped || busy || document.hidden) return;
      window.clearTimeout(timer);
      busy = true;
      try {
        failures = await refresh() ? 0 : Math.min(failures + 1, 2);
      } finally {
        busy = false;
        schedule();
      }
    }
    function visibility() {
      if (document.hidden) window.clearTimeout(timer);
      else void run();
    }
    schedule();
    window.addEventListener('focus', run);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.removeEventListener('focus', run);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [active, refresh, interval]);
}
