import { useRef, type KeyboardEvent } from 'react';

/** 拼音选字的 Enter 不是提交；兼容 compositionend 先于 keydown 的浏览器。 */
export function useAskSubmitKey(submit: () => void) {
  const composing = useRef(false);
  const endedAt = useRef(-Infinity);
  return {
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: () => { composing.current = false; endedAt.current = Date.now(); },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing
        || event.nativeEvent.keyCode === 229 || composing.current || Date.now() - endedAt.current < 80) return;
      event.preventDefault();
      submit();
    },
  };
}
