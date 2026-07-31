import type { Page } from '@playwright/test';

export type ContinuityProbeSnapshot = {
  documentBootCount: number;
  beforeUnloadCount: number;
  pushStateCount: number;
  replaceStateCount: number;
  historyWriteCount: number;
  routeChangeCount: number;
  contentLoaderAppearances: number;
  currentUrl: string;
};

type ContinuityProbeOptions = {
  loaderText: string;
  maxHistoryWrites?: number;
};

export async function installContinuityProbe(
  page: Page,
  { loaderText, maxHistoryWrites = 40 }: ContinuityProbeOptions,
) {
  await page.addInitScript(({ observedLoaderText, historyWriteLimit }) => {
    type ProbeState = Omit<ContinuityProbeSnapshot, 'historyWriteCount'> & {
      armed: boolean;
      loaderVisible: boolean;
      loaderText: string;
    };
    type ProbeWindow = typeof window & {
      __mapContinuityProbe?: ProbeState;
    };

    const storageKey = '__map_continuity_probe__';
    const readPersisted = (): ProbeState => {
      try {
        const stored = sessionStorage.getItem(storageKey);
        if (stored) return JSON.parse(stored) as ProbeState;
      } catch {
        // A failed diagnostic store must not alter the product path under test.
      }
      return {
        documentBootCount: 0,
        beforeUnloadCount: 0,
        pushStateCount: 0,
        replaceStateCount: 0,
        routeChangeCount: 0,
        contentLoaderAppearances: 0,
        currentUrl: location.href,
        armed: false,
        loaderVisible: false,
        loaderText: observedLoaderText,
      };
    };

    const probeWindow = window as ProbeWindow;
    const state = readPersisted();
    state.documentBootCount += 1;
    state.currentUrl = location.href;
    probeWindow.__mapContinuityProbe = state;

    const persist = () => {
      state.currentUrl = location.href;
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(state));
      } catch {
        // Keep in-memory metrics when sessionStorage is unavailable.
      }
    };
    const recordRouteChange = () => {
      state.routeChangeCount += 1;
      persist();
    };
    const assertHistoryLimit = () => {
      if (state.pushStateCount + state.replaceStateCount > historyWriteLimit) {
        throw new Error(`连续任务发生 history 写入循环，已超过 ${historyWriteLimit} 次`);
      }
    };

    const originalPushState = history.pushState.bind(history);
    history.pushState = (...args: Parameters<History['pushState']>) => {
      state.pushStateCount += 1;
      assertHistoryLimit();
      const result = originalPushState(...args);
      recordRouteChange();
      return result;
    };

    const originalReplaceState = history.replaceState.bind(history);
    history.replaceState = (...args: Parameters<History['replaceState']>) => {
      state.replaceStateCount += 1;
      assertHistoryLimit();
      const result = originalReplaceState(...args);
      recordRouteChange();
      return result;
    };

    addEventListener('popstate', recordRouteChange);
    addEventListener('beforeunload', () => {
      state.beforeUnloadCount += 1;
      persist();
    });

    const loaderIsVisible = () => document.body?.innerText.includes(observedLoaderText) ?? false;
    const startObserver = () => {
      state.loaderVisible = loaderIsVisible();
      persist();
      new MutationObserver(() => {
        const nextVisible = loaderIsVisible();
        if (state.armed && nextVisible && !state.loaderVisible) {
          state.contentLoaderAppearances += 1;
        }
        state.loaderVisible = nextVisible;
        persist();
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    };

    if (document.body) startObserver();
    else addEventListener('DOMContentLoaded', startObserver, { once: true });
    persist();
  }, { observedLoaderText: loaderText, historyWriteLimit: maxHistoryWrites });
}

export async function armContinuityProbe(page: Page) {
  await page.evaluate(() => {
    type ProbeWindow = typeof window & {
      __mapContinuityProbe?: {
        armed: boolean;
        loaderVisible: boolean;
        loaderText: string;
        currentUrl: string;
      };
    };
    const state = (window as ProbeWindow).__mapContinuityProbe;
    if (!state) throw new Error('连续性探针未安装');
    state.armed = true;
    state.loaderVisible = document.body.innerText.includes(state.loaderText);
    state.currentUrl = location.href;
    sessionStorage.setItem('__map_continuity_probe__', JSON.stringify(state));
  });
}

export async function readContinuityProbe(page: Page): Promise<ContinuityProbeSnapshot> {
  return page.evaluate(() => {
    type ProbeWindow = typeof window & {
      __mapContinuityProbe?: Omit<ContinuityProbeSnapshot, 'historyWriteCount'>;
    };
    const state = (window as ProbeWindow).__mapContinuityProbe;
    if (!state) throw new Error('连续性探针未安装');
    return {
      documentBootCount: state.documentBootCount,
      beforeUnloadCount: state.beforeUnloadCount,
      pushStateCount: state.pushStateCount,
      replaceStateCount: state.replaceStateCount,
      historyWriteCount: state.pushStateCount + state.replaceStateCount,
      routeChangeCount: state.routeChangeCount,
      contentLoaderAppearances: state.contentLoaderAppearances,
      currentUrl: location.href,
    };
  });
}
