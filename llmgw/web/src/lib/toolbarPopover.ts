import type { SyntheticEvent } from 'react';

/** Position native details outside the collection's scroll clipping boundary. */
export function positionToolbarPopover(event: SyntheticEvent<HTMLDetailsElement>) {
  const details = event.currentTarget;
  if (!details.open) return;
  const anchor = details.querySelector('summary')!.getBoundingClientRect();
  details.style.setProperty('--toolbar-popover-top', `${Math.max(16, Math.min(anchor.bottom + 8, window.innerHeight - 360))}px`);
  details.style.setProperty('--toolbar-popover-right', `${window.innerWidth < 680 ? 16 : Math.max(16, window.innerWidth - anchor.right)}px`);
}
