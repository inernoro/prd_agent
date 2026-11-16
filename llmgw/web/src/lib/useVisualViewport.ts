import { useEffect, useState } from "react";

/** fixed 浮层跟随键盘和浏览器可视区域，保留 layout viewport 的页面滚动。 */
export function useVisualViewport() {
  const read = () => {
    if (typeof window === "undefined")
      return { height: 0, width: 0, top: 0, left: 0 };
    const viewport = window.visualViewport;
    return {
      height: viewport?.height ?? window.innerHeight,
      width: viewport?.width ?? window.innerWidth,
      top: viewport?.offsetTop ?? 0,
      left: viewport?.offsetLeft ?? 0,
    };
  };
  const [viewport, setViewport] = useState(read);
  useEffect(() => {
    const update = () => setViewport(read());
    update();
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, []);
  return viewport;
}
