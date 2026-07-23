import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight } from 'lucide-react';
import { Link } from 'react-router-dom';

type Props = {
  href: string;
  label: string;
  subtitle: string;
  description?: string;
  actionLabel: string;
  icon: ReactNode;
  children: ReactNode;
};

type Position = {
  left: number;
  top: number;
  placement: 'top' | 'bottom';
};

const CARD_WIDTH = 360;
const VIEWPORT_GAP = 12;
const ANCHOR_GAP = 10;

export function LogEntityHoverCard({
  href,
  label,
  subtitle,
  description,
  actionLabel,
  icon,
  children,
}: Props) {
  const cardId = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const show = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);

  const hideSoon = useCallback(() => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      setPosition(null);
    }, 140);
  }, [cancelClose]);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const card = cardRef.current;
    if (!anchor || !card) return;
    const anchorRect = anchor.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const width = Math.min(CARD_WIDTH, window.innerWidth - VIEWPORT_GAP * 2);
    const left = Math.min(
      window.innerWidth - width - VIEWPORT_GAP,
      Math.max(VIEWPORT_GAP, anchorRect.left + anchorRect.width / 2 - width / 2),
    );
    const fitsAbove = anchorRect.top >= cardRect.height + ANCHOR_GAP + VIEWPORT_GAP;
    const top = fitsAbove
      ? anchorRect.top - cardRect.height - ANCHOR_GAP
      : Math.min(window.innerHeight - cardRect.height - VIEWPORT_GAP, anchorRect.bottom + ANCHOR_GAP);
    setPosition({ left, top: Math.max(VIEWPORT_GAP, top), placement: fitsAbove ? 'top' : 'bottom' });
  }, []);

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return undefined;
    const reposition = () => updatePosition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => () => cancelClose(), [cancelClose]);

  const stopRowKeyboard = (event: KeyboardEvent<HTMLElement>) => {
    event.stopPropagation();
  };

  const handleBlur = (event: FocusEvent<HTMLSpanElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && (anchorRef.current?.contains(next) || cardRef.current?.contains(next))) return;
    hideSoon();
  };

  return (
    <span
      ref={anchorRef}
      className="lg-log-entity-hover-root"
      onMouseEnter={show}
      onMouseLeave={hideSoon}
      onFocus={show}
      onBlur={handleBlur}
    >
      <Link
        className="lg-log-entity-link"
        to={href}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={stopRowKeyboard}
      >
        {children}
      </Link>
      {open ? createPortal(
        <div
          ref={cardRef}
          id={cardId}
          role="dialog"
          aria-label={`${label}详情预览`}
          className="lg-log-entity-hover-card"
          data-placement={position?.placement}
          style={{
            left: position?.left ?? VIEWPORT_GAP,
            top: position?.top ?? VIEWPORT_GAP,
            width: `min(${CARD_WIDTH}px, calc(100vw - ${VIEWPORT_GAP * 2}px))`,
            visibility: position ? 'visible' : 'hidden',
          }}
          onMouseEnter={show}
          onMouseLeave={hideSoon}
          onFocus={show}
          onBlur={(event) => {
            const next = event.relatedTarget as Node | null;
            if (next && (cardRef.current?.contains(next) || anchorRef.current?.contains(next))) return;
            hideSoon();
          }}
        >
          <div className="lg-log-entity-hover-heading">
            <span className="lg-log-entity-hover-icon">{icon}</span>
            <div>
              <strong>{label}</strong>
              <span>{subtitle}</span>
            </div>
          </div>
          {description ? <p>{description}</p> : null}
          <Link
            className="lg-log-entity-hover-action"
            to={href}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={stopRowKeyboard}
          >
            {actionLabel}
            <ArrowUpRight size={16} />
          </Link>
        </div>,
        document.body,
      ) : null}
    </span>
  );
}
