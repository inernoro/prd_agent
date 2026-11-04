import { useCallback, useRef, useState } from 'react';

/** 名称输入只有一份：来源兜底不能覆盖粘贴/人工输入，旧请求不能覆盖后续编辑。 */
export function useVersionPlanName(initial = '') {
  const [value, setValue] = useState(initial);
  const origin = useRef<'source' | 'paste' | 'manual'>(initial ? 'manual' : 'source');
  const editVersion = useRef(0);
  const getEditVersion = useCallback(() => editVersion.current, []);
  const isCurrentEdit = useCallback((version?: number) => version == null || version === editVersion.current, []);
  const setManual = useCallback((next: string) => {
    origin.current = 'manual';
    editVersion.current += 1;
    setValue(next);
  }, []);
  const setSource = useCallback((next: string) => {
    if (origin.current === 'source') setValue(next);
  }, []);
  const setPasted = useCallback((next: string, version?: number) => {
    if (!isCurrentEdit(version)) return;
    origin.current = 'paste';
    setValue(next);
  }, [isCurrentEdit]);
  return { value, setManual, setSource, setPasted, getEditVersion, isCurrentEdit };
}
