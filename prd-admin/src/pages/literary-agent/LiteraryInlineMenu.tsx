import * as React from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import './LiterarySettings.css';

const GroupContext = React.createContext<{
  openId: string | null;
  setOpenId: React.Dispatch<React.SetStateAction<string | null>>;
} | null>(null);

export const InlineMenuContext = React.createContext<{ close: () => void } | null>(null);

/** 同一配置卡内只展开一个选择器。 */
export function LiteraryInlineMenuGroup({ children }: { children: React.ReactNode }) {
  const [openId, setOpenId] = React.useState<string | null>(null);
  const value = React.useMemo(() => ({ openId, setOpenId }), [openId]);
  return <GroupContext.Provider value={value}>{children}</GroupContext.Provider>;
}

export function LiteraryInlineMenu({ trigger, title, note, open, onOpenChange, search, children }: {
  trigger: React.ReactElement;
  title?: string;
  note?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  search?: { value: string; onChange: (value: string) => void; placeholder: string };
  children: React.ReactNode;
}) {
  const id = React.useId();
  const group = React.useContext(GroupContext);
  const setGroupOpenId = group?.setOpenId;
  const [localOpen, setLocalOpen] = React.useState(false);
  const expanded = group ? group.openId === id : open ?? localOpen;
  const triggerRef = React.useRef<HTMLElement | null>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const wasExpanded = React.useRef(false);
  const lastNotified = React.useRef(open ?? false);
  const notifyOpenChange = React.useCallback((next: boolean) => {
    if (lastNotified.current === next) return;
    lastNotified.current = next;
    onOpenChange?.(next);
  }, [onOpenChange]);

  React.useEffect(() => {
    if (open === undefined || !setGroupOpenId) return;
    setGroupOpenId(current => open ? id : current === id ? null : current);
  }, [open, id, setGroupOpenId]);

  React.useEffect(() => {
    if (wasExpanded.current && !expanded) notifyOpenChange(false);
    if (expanded) lastNotified.current = true;
    wasExpanded.current = expanded;
  }, [expanded, notifyOpenChange]);

  const hasSearch = !!search;
  React.useEffect(() => {
    if (expanded && hasSearch) searchRef.current?.focus({ preventScroll: true });
  }, [expanded, hasSearch]);

  const changeOpen = (next: boolean) => {
    if (setGroupOpenId) setGroupOpenId(current => next ? id : current === id ? null : current);
    else if (open === undefined) setLocalOpen(next);
    notifyOpenChange(next);
  };
  const close = () => {
    changeOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };
  const focusOption = (key: string) => {
    const items = [...(panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled), [role="menuitem"]:not(:disabled)') ?? [])];
    if (!items.length) return;
    const index = items.findIndex(item => item === document.activeElement);
    const next = key === 'Home' ? 0 : key === 'End' ? items.length - 1
      : key === 'ArrowUp' ? (index <= 0 ? items.length - 1 : index - 1) : (index + 1) % items.length;
    items[next].focus();
  };
  const props = trigger.props as React.HTMLAttributes<HTMLElement>;

  return (
    <div className="lit-inline-menu" data-open={expanded}>
      {React.cloneElement(trigger as React.ReactElement<Record<string, unknown>>, {
        ref: (element: HTMLElement | null) => { triggerRef.current = element; },
        id: `${id}-trigger`,
        'aria-expanded': expanded,
        'aria-controls': expanded ? `${id}-panel` : undefined,
        'data-state': expanded ? 'open' : 'closed',
        onClick: (event: React.MouseEvent<HTMLElement>) => { props.onClick?.(event); if (!event.defaultPrevented) changeOpen(!expanded); },
        onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
          props.onKeyDown?.(event);
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!expanded) changeOpen(true);
            requestAnimationFrame(() => focusOption(event.key));
          } else if (event.key === 'Escape' && expanded) { event.preventDefault(); close(); }
        },
      })}
      {expanded && (
        <div
          id={`${id}-panel`}
          ref={panelRef}
          className="lit-inline-panel"
          role="region"
          aria-labelledby={`${id}-trigger`}
          onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
            else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
              && (!(event.target instanceof HTMLInputElement) || event.key.startsWith('Arrow'))) {
              event.preventDefault();
              focusOption(event.key);
            }
          }}
        >
          {note && <div className="lit-inline-note">{note}</div>}
          {search && (
            <div className="lit-model-search">
              <Search size={15} aria-hidden />
              <input ref={searchRef} value={search.value} onChange={event => search.onChange(event.target.value)}
                placeholder={search.placeholder} aria-label={search.placeholder} />
              {search.value && <button type="button" aria-label="清除搜索" onClick={() => { search.onChange(''); searchRef.current?.focus(); }}><X size={13} /></button>}
            </div>
          )}
          <div role="menu" aria-label={`${title || '设置'}选项`} className="lit-inline-options"
            style={{ minHeight: 0, maxHeight: 'min(280px, 40vh)', overflowY: 'auto', overscrollBehavior: 'contain' }}>
            <InlineMenuContext.Provider value={{ close }}>{children}</InlineMenuContext.Provider>
          </div>
        </div>
      )}
    </div>
  );
}

export const LiterarySettingsRow = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: React.ReactNode;
  label: string;
  value: string;
  warning?: boolean;
}>(function LiterarySettingsRow({ icon, label, value, warning, ...rest }, ref) {
  return (
    <button ref={ref} type="button" className="lit-settings-row" data-warning={warning || undefined} {...rest}>
      <span className="lit-settings-label">{icon}<span>{label}</span></span>
      <span className="lit-settings-value" title={value}>{value}</span>
      <ChevronDown size={15} className="lit-settings-chevron" aria-hidden />
    </button>
  );
});
