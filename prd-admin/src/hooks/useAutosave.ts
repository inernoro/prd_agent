import { useCallback, useEffect, useRef, useState } from 'react';

export type AutosaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface AutosaveResult {
  success: boolean;
  message?: string;
}

export interface UseAutosaveOptions<T> {
  value: T;
  enabled: boolean;
  onSave: (value: T) => Promise<AutosaveResult>;
  delayMs?: number;
  fingerprint?: (value: T) => string;
  warnBeforeUnload?: boolean;
}

export interface UseAutosaveReturn {
  status: AutosaveStatus;
  lastSavedAt: Date | null;
  lastError: string | null;
  hasPendingChanges: boolean;
  flush: () => Promise<AutosaveResult>;
  markSaved: () => void;
}

const defaultFingerprint = <T,>(value: T): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export function useAutosave<T>({
  value,
  enabled,
  onSave,
  delayMs = 1500,
  fingerprint = defaultFingerprint,
  warnBeforeUnload = false,
}: UseAutosaveOptions<T>): UseAutosaveReturn {
  const [status, setStatus] = useState<AutosaveStatus>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [hasPendingChanges, setHasPendingChanges] = useState(false);

  const valueRef = useRef(value);
  const fingerprintRef = useRef(fingerprint);
  const onSaveRef = useRef(onSave);
  const enabledRef = useRef(enabled);
  const lastSavedFingerprintRef = useRef<string | null>(null);
  const inFlightRef = useRef<Promise<AutosaveResult> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposedRef = useRef(false);

  useEffect(() => { valueRef.current = value; }, [value]);
  useEffect(() => { fingerprintRef.current = fingerprint; }, [fingerprint]);
  useEffect(() => { onSaveRef.current = onSave; }, [onSave]);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  const runOneSave = useCallback(async (): Promise<AutosaveResult> => {
    const snapshot = valueRef.current;
    const snapshotFp = fingerprintRef.current(snapshot);
    if (snapshotFp === lastSavedFingerprintRef.current) {
      if (!disposedRef.current) setHasPendingChanges(false);
      return { success: true };
    }

    if (!disposedRef.current) setStatus('saving');

    try {
      const res = await onSaveRef.current(snapshot);
      if (disposedRef.current) return res;
      if (res.success) {
        lastSavedFingerprintRef.current = snapshotFp;
        setLastSavedAt(new Date());
        setLastError(null);
        setStatus('saved');
        const currentFp = fingerprintRef.current(valueRef.current);
        setHasPendingChanges(currentFp !== snapshotFp);
        return { success: true };
      }
      setLastError(res.message || '保存失败');
      setStatus('error');
      return { success: false, message: res.message };
    } catch (err) {
      const message = err instanceof Error ? err.message : '保存失败';
      if (!disposedRef.current) {
        setLastError(message);
        setStatus('error');
      }
      return { success: false, message };
    }
  }, []);

  const performSave = useCallback(async (): Promise<AutosaveResult> => {
    if (!enabledRef.current) return { success: true };

    if (inFlightRef.current) {
      try { await inFlightRef.current; } catch { /* swallow — we'll re-check */ }
      if (fingerprintRef.current(valueRef.current) === lastSavedFingerprintRef.current) {
        return { success: true };
      }
    }

    const tracked: Promise<AutosaveResult> = runOneSave().finally(() => {
      if (inFlightRef.current === tracked) inFlightRef.current = null;
    });
    inFlightRef.current = tracked;
    return await tracked;
  }, [runOneSave]);

  useEffect(() => {
    if (!enabled) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    const currentFp = fingerprint(value);

    if (lastSavedFingerprintRef.current === null) {
      lastSavedFingerprintRef.current = currentFp;
      setHasPendingChanges(false);
      return;
    }

    if (currentFp === lastSavedFingerprintRef.current) {
      setHasPendingChanges(false);
      return;
    }

    setHasPendingChanges(true);

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void performSave();
    }, delayMs);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [value, enabled, delayMs, fingerprint, performSave]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!warnBeforeUnload || !hasPendingChanges) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [warnBeforeUnload, hasPendingChanges]);

  const flush = useCallback(async (): Promise<AutosaveResult> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    return await performSave();
  }, [performSave]);

  const markSaved = useCallback(() => {
    lastSavedFingerprintRef.current = fingerprintRef.current(valueRef.current);
    setLastSavedAt(new Date());
    setLastError(null);
    setStatus('saved');
    setHasPendingChanges(false);
  }, []);

  return {
    status,
    lastSavedAt,
    lastError,
    hasPendingChanges,
    flush,
    markSaved,
  };
}
