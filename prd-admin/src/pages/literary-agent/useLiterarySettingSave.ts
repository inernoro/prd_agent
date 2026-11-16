import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '@/lib/toast';

/** 设置仅在服务端确认成功后生效；失败保留原值，并允许重试同一次选择。 */
export function useLiterarySettingSave<T>({ scopeKey, save, onSaved, errorMessage }: {
  scopeKey: string;
  save: (value: T) => Promise<{ success: boolean }>;
  onSaved: (value: T) => void;
  errorMessage: string;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeScope = useRef<{ key: string; inFlight: boolean; failed?: { value: T } } | null>(null);

  useEffect(() => {
    const scope = { key: scopeKey, inFlight: false };
    activeScope.current = scope;
    setSaving(false);
    setError(null);
    return () => { if (activeScope.current === scope) activeScope.current = null; };
  }, [scopeKey]);

  const run = useCallback(async (value: T): Promise<boolean> => {
    const scope = activeScope.current;
    if (!scope || scope.key !== scopeKey || scope.inFlight) return false;
    scope.inFlight = true;
    scope.failed = undefined;
    setSaving(true);
    setError(null);
    const fail = () => {
      scope.failed = { value };
      setError(errorMessage);
      toast.error(errorMessage, '当前设置保持不变，请重试');
    };
    try {
      const result = await save(value);
      if (activeScope.current !== scope) return false;
      if (!result.success) { fail(); return false; }
      onSaved(value);
      return true;
    } catch {
      if (activeScope.current === scope) fail();
      return false;
    } finally {
      scope.inFlight = false;
      if (activeScope.current === scope) setSaving(false);
    }
  }, [scopeKey, save, onSaved, errorMessage]);

  const retry = useCallback(() => {
    const failed = activeScope.current?.failed;
    return failed ? run(failed.value) : Promise.resolve(false);
  }, [run]);

  return { run, retry, saving, error };
}
