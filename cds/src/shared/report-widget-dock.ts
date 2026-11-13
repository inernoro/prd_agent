/** Report hosts reserve their own toolbar space; the parent preview widget stays usable. */
export const REPORT_WIDGET_DOCK_STYLE = `
[data-report-widget-slot]:empty{display:none}
[data-report-widget-slot]:not(:empty){display:flex;align-items:center;flex:0 1 auto;min-width:44px;min-height:44px;max-width:100%}
[data-report-widget-slot]>#cds-widget:not(:has(.cds-panel)){position:relative!important;inset:auto!important;max-width:100%}
`;

/** Self-contained so the anonymous server shell can run this same helper without a bundle. */
export function dockReportWidget(slot: HTMLElement): () => void {
  const doc = slot.ownerDocument;
  let record: { widget: HTMLElement; marker: Comment; parent: Node; style: string | null; placement: string | null } | undefined;
  let stopped = false;
  // An anonymous callback avoids bundler-injected name helpers in the serialized public shell.
  const callbacks = [(): void => {
    if (stopped || !slot.isConnected) return;
    const widget = doc.getElementById('cds-widget');
    if (!widget || record?.widget === widget) return;
    const parent = widget.parentNode;
    if (!parent) return;
    record?.marker.remove();
    const marker = doc.createComment('report-widget-origin');
    parent.insertBefore(marker, widget);
    record = { widget, marker, parent, style: widget.getAttribute('style'), placement: widget.getAttribute('data-cds-placement') };
    slot.append(widget);
  }];
  const observer = new MutationObserver(callbacks[0]);
  observer.observe(doc.body, { childList: true, subtree: true });
  callbacks[0]();
  return () => {
    stopped = true;
    observer.disconnect();
    if (!record) return;
    const { widget, marker, parent, style, placement } = record;
    // A user-dismissed widget has no parent. A React-detached slot still owns its widget.
    if (widget.parentNode === slot) {
      if (style === null) widget.removeAttribute('style'); else widget.setAttribute('style', style);
      if (placement === null) widget.removeAttribute('data-cds-placement'); else widget.setAttribute('data-cds-placement', placement);
      if (marker.parentNode) marker.parentNode.insertBefore(widget, marker);
      else if (parent.isConnected) parent.appendChild(widget);
    }
    marker.remove();
  };
}
