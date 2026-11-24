import { useCallback, useEffect, useRef } from 'react';

/** 每份文档在侧栏尚未使用时发现批注即展开；不覆盖手动收起或已开始的提问。 */
export function useReviewAutoOpen(identity: string, onOpen: () => void, occupied = false) {
  const openedFor = useRef('');
  const open = useRef(onOpen);
  open.current = onOpen;
  useEffect(() => {
    if (occupied) openedFor.current = identity;
  }, [identity, occupied]);
  return useCallback((count: number) => {
    if (count > 0 && !occupied && openedFor.current !== identity) {
      openedFor.current = identity;
      open.current();
    }
  }, [identity, occupied]);
}
