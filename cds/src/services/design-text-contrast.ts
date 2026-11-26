import type { Page } from 'playwright';

export async function measureDesignTextContrast(page: Page) {
  return page.evaluate(() => {
    type Color = [number, number, number, number];
    const result = { measured: 0, low: 0, unknown: 0, media: 0, lowest: null as number | null };
    const pixel = document.createElement('canvas');
    pixel.width = pixel.height = 1;
    const drawing = pixel.getContext('2d', { willReadFrequently: true });
    if (!drawing) return { ...result, unknown: 1 };
    const context = drawing;

    const colors = new Map<string, Color | undefined>();
    const styles = new Map<Element, CSSStyleDeclaration>();
    const scan = {
      styleOf(node: Element) {
        const cached = styles.get(node) ?? getComputedStyle(node);
        styles.set(node, cached);
        return cached;
      },
      color(value: string): Color | undefined {
        if (colors.has(value)) return colors.get(value);
        context.fillStyle = '#010203';
        context.fillStyle = value;
        if (context.fillStyle === '#010203') {
          context.fillStyle = '#040506';
          context.fillStyle = value;
          if (context.fillStyle === '#040506') {
            colors.set(value, undefined);
            return undefined;
          }
        }
        context.clearRect(0, 0, 1, 1);
        context.fillRect(0, 0, 1, 1);
        const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
        const paint: Color = [red / 255, green / 255, blue / 255, alpha / 255];
        colors.set(value, paint);
        return paint;
      },
      over(top: Color, bottom: Color): Color {
        const behind = bottom[3] * (1 - top[3]);
        const alpha = top[3] + behind;
        if (!alpha) return [0, 0, 0, 0];
        return [(top[0] * top[3] + bottom[0] * behind) / alpha,
          (top[1] * top[3] + bottom[1] * behind) / alpha,
          (top[2] * top[3] + bottom[2] * behind) / alpha, alpha];
      },
      linear(channel: number) {
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      },
      luminance(paint: Color) {
        return 0.2126 * this.linear(paint[0]) + 0.7152 * this.linear(paint[1]) + 0.0722 * this.linear(paint[2]);
      },
      paintsSurface(style: CSSStyleDeclaration) {
        const background = this.color(style.backgroundColor);
        return style.backgroundImage !== 'none' || style.boxShadow !== 'none' || !background || background[3] > 0;
      },
      paintsPseudo(node: Element) {
        return ['::before', '::after'].some(part => {
          const style = getComputedStyle(node, part);
          return style.content !== 'none' && style.content !== 'normal' && style.display !== 'none'
            && style.visibility === 'visible' && this.paintsSurface(style);
        });
      },
      backdrop(host: Element) {
        const layers: Color[] = [];
        let opaque = false;
        for (let node: Element | null = host; node; node = node.parentElement) {
          const style = this.styleOf(node);
          if (style.filter !== 'none' || style.backdropFilter !== 'none' || style.mixBlendMode !== 'normal'
            || Number(style.opacity) !== 1 || style.maskImage !== 'none') return undefined;
          if (style.display === 'contents') continue;
          if (this.paintsPseudo(node)) return undefined;
          if (opaque) continue;
          if (style.backgroundImage !== 'none' || style.backgroundClip === 'text') return undefined;
          const paint = this.color(style.backgroundColor);
          if (!paint) return undefined;
          layers.unshift(paint);
          opaque = paint[3] === 1;
        }
        return opaque ? layers.reduce((bottom, top) => this.over(top, bottom)) : undefined;
      },
      inViewport(rect: DOMRect) {
        return rect.width > 1 && rect.height > 1
          && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
      },
      visible(node: Element) {
        const style = this.styleOf(node);
        return style.visibility === 'visible' && !node.closest('.sr-only, [hidden]')
          && (style.display === 'contents' || !node.checkVisibility || node.checkVisibility({ opacityProperty: true, visibilityProperty: true }));
      },
      unrelated(left: Element, right: Element) {
        return !left.contains(right) && !right.contains(left);
      },
    };
    const modal = [...document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="dialog"][data-state="open"]')]
      .filter(node => scan.visible(node)).at(-1);
    const scope = modal ?? document.querySelector('.dw-workspace, main') ?? document.body;
    const mediaSelector = 'img, iframe, video, canvas, svg[role="img"]';
    // Hit testing omits pointer-transparent decoration. Keep its layout bounds for contrast decisions.
    const transparentLayers = Array.from(document.querySelectorAll('*')).flatMap(node => {
      const style = scan.styleOf(node);
      if (style.pointerEvents !== 'none' || !scan.visible(node)
        || !scan.paintsSurface(style) && !scan.paintsPseudo(node) && !node.matches(mediaSelector)) return [];
      const bounds = node.getBoundingClientRect();
      return scan.inViewport(bounds) ? [{ node, bounds }] : [];
    });
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let examined = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const host = node.parentElement;
      if (!node.textContent?.trim() || !host || host.closest('script, style, template, option, svg') || !scan.visible(host)) continue;
      range.selectNodeContents(node);
      const rect = [...range.getClientRects()].find(box => scan.inViewport(box));
      if (!rect) continue;
      if (++examined > 1000) {
        result.unknown++;
        break;
      }
      const x = (Math.max(rect.left, 0) + Math.min(rect.right, innerWidth)) / 2;
      const y = (Math.max(rect.top, 0) + Math.min(rect.bottom, innerHeight)) / 2;
      const hits = document.elementsFromPoint(x, y);
      const hit = hits[0];
      const overlapping = hits.some(other => scan.unrelated(host, other)
        && (scan.paintsSurface(scan.styleOf(other)) || scan.paintsPseudo(other) || other.matches(mediaSelector)))
        || transparentLayers.some(({ node: other, bounds }) => scan.unrelated(host, other)
          && x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom);
      const style = scan.styleOf(host);
      const background = hit && !scan.unrelated(host, hit) && !overlapping && scan.backdrop(host);
      const textColor = scan.color(style.getPropertyValue('-webkit-text-fill-color') || style.color);
      if (!background || !textColor || style.textShadow !== 'none' || parseFloat(style.getPropertyValue('-webkit-text-stroke-width')) > 0) {
        result.unknown++;
        continue;
      }
      const text = scan.luminance(scan.over(textColor, background)), surface = scan.luminance(background);
      const ratio = (Math.max(text, surface) + 0.05) / (Math.min(text, surface) + 0.05);
      result.measured++;
      if (ratio < 4.5) result.low++;
      result.lowest = result.lowest === null ? ratio : Math.min(result.lowest, ratio);
    }
    result.media = [...scope.querySelectorAll(mediaSelector)]
      .filter(node => scan.visible(node) && scan.inViewport(node.getBoundingClientRect())).length;
    return result;
  });
}
