import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Returns a ref + whether that element has entered (or come near) the viewport.
 * Once true it stays true (observer disconnects), so a card's cover image is
 * only requested when the card is about to be seen — off-screen cards make
 * zero network requests until the user scrolls toward them.
 */
export function useInViewport<T extends Element>(
  rootMargin = '600px',
): [RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    if (inView) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [inView, rootMargin]);

  return [ref, inView];
}
