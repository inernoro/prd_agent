import { useEffect, useState } from 'react';
import { listDesignModelOptions, type DesignModelOption } from '@/services/real/webPages';

export function useWorkbenchModelPicker(operation: 'generate' | 'edit') {
  const [items, setItems] = useState<DesignModelOption[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [value, setValue] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    void listDesignModelOptions(operation).then((result) => {
      if (!active) return;
      if (result.success) {
        setItems(result.data.items);
        setStatus('ready');
      } else {
        setStatus('failed');
      }
    }).catch(() => { if (active) setStatus('failed'); });
    return () => { active = false; };
  }, [operation, attempt]);

  return {
    items, status, value, setValue,
    selectionUnavailable: Boolean(value) && status === 'ready' && !items.some((item) => item.id === value),
    retry: () => {
      setStatus('loading');
      setAttempt((current) => current + 1);
    },
  };
}

export type WorkbenchModelPickerState = ReturnType<typeof useWorkbenchModelPicker>;
