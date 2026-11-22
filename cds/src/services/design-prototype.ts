export const designPrototypeCsp = [
  "sandbox allow-scripts", "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
  "img-src data: blob:", "font-src data:", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'",
].join('; ');

const prototypeBridge = `<script>
  (() => {
    const theme = new URLSearchParams(location.search).get('theme');
    if (theme === 'dark' || theme === 'light') {
      const keepTheme = () => {
        const root = document.documentElement;
        if (root?.dataset.theme !== theme) root.dataset.theme = theme;
        if (root?.style.colorScheme !== theme) root.style.colorScheme = theme;
      };
      keepTheme();
      addEventListener('DOMContentLoaded', keepTheme, { once: true });
      new MutationObserver(keepTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
    const elementBoxes = () => {
      const occurrences = new Map(), boxes = [];
      const nodes = document.querySelectorAll('[data-diff-id], h1, h2, h3, label, button, input, tr, [role=tab], [role=button]');
      for (const node of nodes) {
        const bounds = node.getBoundingClientRect();
        if (bounds.width < 4 || bounds.height < 4 || bounds.right <= 0 || bounds.bottom <= 0
          || bounds.left >= innerWidth || bounds.top >= innerHeight) continue;
        const style = getComputedStyle(node);
        if (style.visibility === 'hidden' || style.opacity === '0') continue;
        const base = node.getAttribute('data-diff-id') || node.id || node.tagName;
        const count = occurrences.get(base) || 0;
        occurrences.set(base, count + 1);
        const content = (node.textContent || node.getAttribute('placeholder') || '').slice(0, 300)
          + [style.color, style.backgroundColor, style.fontSize, style.fontWeight, style.borderColor].join('/');
        let digest = 5381;
        for (let i = 0; i < content.length; i += 1) digest = (digest * 33 ^ content.charCodeAt(i)) | 0;
        const left = Math.max(0, bounds.left), top = Math.max(0, bounds.top);
        boxes.push({ id: base.slice(0, 80) + ':' + count, stamp: digest,
          x: left / innerWidth, y: top / innerHeight,
          width: (Math.min(bounds.right, innerWidth) - left) / innerWidth, height: (Math.min(bounds.bottom, innerHeight) - top) / innerHeight });
        if (boxes.length >= 350) break;
      }
      return boxes;
    };
    let pending = 0;
    const sendLayout = () => {
      clearTimeout(pending);
      pending = setTimeout(() => parent.postMessage({ type: 'cds-design-layout', boxes: elementBoxes() }, '*'), 180);
    };
    addEventListener('load', () => {
      sendLayout();
      new MutationObserver(sendLayout).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    });
    addEventListener('scroll', sendLayout, { capture: true, passive: true });
    addEventListener('message', (event) => {
      if (event.source !== parent || event.data?.type !== 'cds-design-scroll') return;
      const { left, top } = event.data;
      if (Number.isFinite(left) && Number.isFinite(top)) scrollTo(left, top);
    });
    const controls = 'button:not([type=submit]), a[href^="#"], [role=tab], [role=button]';
    const visibleControl = node => node instanceof HTMLElement && node.matches(controls)
      && !node.matches(':disabled,[aria-disabled=true]') && (!node.matches('a') || node.getAttribute('href')?.startsWith('#'))
      && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
    const normalizeLabel = value => String(value || '').toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, '');
    const waitFor = async find => {
      for (let step = 0; step < 25; step++) {
        const result = find();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      return null;
    };
    const bySelector = (selector, test = node => node.getClientRects().length > 0) => {
      try {
        const found = [...document.querySelectorAll(selector)].filter(test);
        return found.length === 1 ? found[0] : null;
      } catch { return null; }
    };
    const byLabel = name => {
      const target = normalizeLabel(name);
      let longest = 0;
      const best = new Set();
      for (const node of document.querySelectorAll(controls)) {
        if (!visibleControl(node)) continue;
        for (const value of [node.getAttribute('aria-label'), node.getAttribute('title'), node.textContent]) {
          const label = normalizeLabel(value);
          if (label.length < 2 || label.length < longest || !target.endsWith(label)) continue;
          if (label.length > longest) { longest = label.length; best.clear(); }
          best.add(node);
        }
      }
      return best.size === 1 ? best.values().next().value : null;
    };
    let currentEntry = 0;
    addEventListener('message', async event => {
      if (event.source !== parent || event.data?.type !== 'cds-design-entry') return;
      const marker = ++currentEntry;
      const { actions, ready, legacyLabel } = event.data;
      const steps = Array.isArray(actions) ? actions.slice(0, 6).filter(selector => typeof selector === 'string' && selector.length <= 300) : [];
      const hasLegacy = !steps.length && typeof legacyLabel === 'string' && legacyLabel.length <= 120;
      const paths = steps.map(selector => () => bySelector(selector, visibleControl));
      if (hasLegacy) paths.push(() => byLabel(legacyLabel));
      let reached = true;
      for (const find of paths) {
        const control = await waitFor(find);
        if (marker !== currentEntry) return;
        if (!control) { reached = false; break; }
        const active = ['aria-pressed', 'aria-current', 'aria-selected'].some(attribute => control.getAttribute(attribute) === 'true');
        if (!active) control.click();
      }
      if (reached && typeof ready === 'string' && ready.length <= 300) reached = !!await waitFor(() => bySelector(ready));
      if (marker === currentEntry) parent.postMessage({ type: 'cds-design-entry-result', reached }, '*');
    });
    addEventListener('scroll', () => parent.postMessage({ type: 'cds-design-scroll', left: scrollX, top: scrollY }, '*'), { passive: true });
    addEventListener('keydown', (event) => {
      if (event.defaultPrevented || (event.key !== 'Escape' && event.target instanceof Element && event.target.closest('input, select, textarea, [contenteditable]'))) return;
      if (['ArrowLeft', 'ArrowRight', 'c', 'C', 'Escape'].includes(event.key)) {
        parent.postMessage({ type: 'cds-design-key', key: event.key }, '*');
      }
    });
  })();
</script>`;

export function decorateDesignPrototype(html: string): string {
  const head = html.match(/<head(?:\s[^>]*)?>/i);
  const index = head ? head.index! + head[0].length : 0;
  return index > 0 ? html.slice(0, index) + prototypeBridge + html.slice(index)
    : html.replace(/^(<!doctype[^>]+>\s*)?/i, start => start + prototypeBridge);
}
