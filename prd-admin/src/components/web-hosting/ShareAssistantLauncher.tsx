import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MessageCircle, WandSparkles, X } from 'lucide-react';
import { MapMarkGlyph } from '@/components/ui/MapBrandMark';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { ShareAssistantContext, type ShareAssistantAction, type ShareAssistantActionId } from './shareAssistantContext';
import './share-assistant.css';

const labels = { ask: '向我提问', edit: '帮我修改' };

export default function ShareAssistantLauncher({ children, hidden = false, isMobile = false }: {
  children: ReactNode;
  hidden?: boolean;
  isMobile?: boolean;
}) {
  const [actions, setActions] = useState<Partial<Record<ShareAssistantActionId, ShareAssistantAction>>>({});
  const [expanded, setExpanded] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const register = useCallback((id: ShareAssistantActionId, action: ShareAssistantAction) => {
    setActions((current) => ({ ...current, [id]: action }));
    return () => setActions((current) => {
      if (current[id] !== action) return current;
      const next = { ...current }; delete next[id]; return next;
    });
  }, []);
  const entries = (['ask', 'edit'] as const).flatMap((id) => actions[id] ? [{ id, action: actions[id]! }] : []);
  const activeId = entries.find(({ action }) => action.active)?.id;
  const context = useMemo(() => ({ register, activeId }), [register, activeId]);
  const visible = !hidden && !activeId && entries.length > 0;
  const rounds = actions.ask?.rounds ?? 0;

  useEffect(() => { if (!visible) setExpanded(false); }, [visible]);
  useEffect(() => {
    if (!expanded || !visible) return;
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setExpanded(false); };
    // iframe 内点击不会冒泡到父文档；窗口失焦时也收起菜单。
    const blur = () => setExpanded(false);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('blur', blur);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('blur', blur); };
  }, [expanded, visible]);

  const activate = (action: ShareAssistantAction) => {
    if (action.disabled) return;
    setExpanded(false);
    action.activate();
  };

  return <ShareAssistantContext.Provider value={context}>
    {children}
    {typeof document !== 'undefined' && createPortal(<div ref={root} className="share-assistant" style={{
      position: 'fixed', right: isMobile ? 14 : 18, bottom: 'calc(18px + env(safe-area-inset-bottom, 0px))',
      zIndex: 60, display: visible ? 'flex' : 'none',
    }} onKeyDown={(event) => {
      if (event.key === 'Escape' && expanded) { event.stopPropagation(); setExpanded(false); trigger.current?.focus(); }
      if (!expanded || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }}>
      {expanded && <div role="menu" aria-label="网页助手操作" className="share-assistant-menu" style={{ maxHeight: 'calc(100dvh - 100px)', overflowY: 'auto' }}>
        {entries.map(({ id, action }) => <button key={id} type="button" role="menuitem" disabled={action.disabled}
          onClick={() => activate(action)}>
          {action.busy ? <MapSpinner size={15} /> : id === 'ask' ? <MessageCircle size={15} /> : <WandSparkles size={15} />}
          <span>{labels[id]}</span>
          {id === 'ask' && rounds > 0 && <span className="share-assistant-rounds">{rounds}</span>}
        </button>)}
      </div>}
      <button ref={trigger} type="button" className="share-assistant-trigger"
        aria-label={entries.length === 1 ? labels[entries[0].id] : '网页助手'}
        title={entries.length === 1 ? labels[entries[0].id] : '提问或修改网页'}
        aria-expanded={entries.length > 1 ? expanded : undefined} aria-haspopup={entries.length > 1 ? 'menu' : undefined}
        disabled={entries.length === 1 && entries[0].action.disabled}
        onClick={() => entries.length === 1 ? activate(entries[0].action) : setExpanded((value) => !value)}>
        {expanded ? <X size={18} /> : actions.ask?.busy ? <MapSpinner size={19} /> : <MapMarkGlyph size={20} tone="var(--text-primary)" nodes={false} />}
        {!expanded && rounds > 0 && <span className="share-assistant-badge" aria-label={`${rounds} 轮对话`}>{rounds > 99 ? '99+' : rounds}</span>}
      </button>
    </div>, document.body)}
  </ShareAssistantContext.Provider>;
}
