import { useCallback, useRef } from 'react';

/** 每份文档首次发现批注时展开；后续计数刷新不覆盖用户的手动收起。 */
export function useReviewAutoOpen(identity: string, onOpen: () => void) {
  const openedFor = useRef('');
  const open = useRef(onOpen);
  open.current = onOpen;
  return useCallback((count: number) => {
    if (count > 0 && openedFor.current !== identity) {
      openedFor.current = identity;
      open.current();
    }
  }, [identity]);
}
