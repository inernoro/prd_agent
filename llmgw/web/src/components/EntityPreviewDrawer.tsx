import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Eye, X } from 'lucide-react';

export type EntityPreviewField = {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
};

export type EntityPreviewSection = {
  title: string;
  description?: ReactNode;
  fields?: EntityPreviewField[];
  content?: ReactNode;
};

type EntityPreviewDrawerProps = {
  buttonLabel: string;
  title: string;
  kicker: string;
  summary: ReactNode;
  sections: EntityPreviewSection[];
  status?: Array<{ label: string; tone?: 'neutral' | 'good' | 'warning' }>;
};

export function EntityPreviewDrawer({ buttonLabel, title, kicker, summary, sections, status = [] }: EntityPreviewDrawerProps) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const triggerButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = drawerRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      triggerButtonRef.current?.focus();
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerButtonRef}
        type="button"
        onClick={() => setOpen(true)}
        style={triggerStyle}
        aria-haspopup="dialog"
      >
        <Eye size={13} />
        {buttonLabel}
      </button>
      {open ? createPortal(
        <div style={portalStyle}>
          <button type="button" aria-label="关闭关联详情" onClick={() => setOpen(false)} style={backdropStyle} />
          <aside
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            style={{ ...drawerStyle, height: '100dvh', maxHeight: '100dvh' }}
          >
            <header style={headerStyle}>
              <div style={{ minWidth: 0 }}>
                <div style={kickerStyle}>{kicker}</div>
                <h2 id={titleId} style={titleStyle}>{title}</h2>
              </div>
              <button ref={closeButtonRef} type="button" aria-label="关闭" onClick={() => setOpen(false)} style={closeStyle}>
                <X size={17} />
              </button>
            </header>

            <div style={scrollStyle}>
              <section style={summaryStyle}>
                <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.7 }}>{summary}</p>
                {status.length ? (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 11 }}>
                    {status.map((item, statusIndex) => <span key={`${item.label}-${statusIndex}`} style={statusStyle(item.tone)}>{item.label}</span>)}
                  </div>
                ) : null}
              </section>

              {sections.map((section) => (
                <section key={section.title} style={sectionStyle}>
                  <h3 style={sectionTitleStyle}>{section.title}</h3>
                  {section.description ? <p style={sectionDescriptionStyle}>{section.description}</p> : null}
                  {section.fields?.length ? (
                    <dl style={fieldListStyle}>
                      {section.fields.map((field, fieldIndex) => (
                        <div key={`${field.label}-${fieldIndex}`} style={fieldStyle}>
                          <dt style={fieldLabelStyle}>{field.label}</dt>
                          <dd style={fieldValueStyle}>{field.value == null ? '未配置' : field.value}</dd>
                          {field.hint ? <dd style={fieldHintStyle}>{field.hint}</dd> : null}
                        </div>
                      ))}
                    </dl>
                  ) : null}
                  {section.content}
                </section>
              ))}

              <section style={securityStyle}>
                <strong style={{ color: 'var(--text-primary)', fontSize: 12 }}>安全边界</strong>
                <p style={{ margin: '5px 0 0', color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.6 }}>
                  密钥明文不会在预览中显示。这里读取的是当前租户已经有权查看的配置摘要，不会发起上游请求，也不会改变路由。
                </p>
              </section>
            </div>
          </aside>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

const triggerStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  width: 'fit-content',
  padding: 0,
  border: 0,
  background: 'transparent',
  color: 'var(--accent)',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 11,
  lineHeight: 1.4,
  textDecoration: 'underline',
  textDecorationColor: 'color-mix(in srgb, var(--accent) 38%, transparent)',
  textUnderlineOffset: 3,
};

const portalStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1200,
  display: 'flex',
  justifyContent: 'flex-end',
};

const backdropStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  border: 0,
  background: 'rgba(4, 8, 15, 0.64)',
  cursor: 'default',
};

const drawerStyle: React.CSSProperties = {
  position: 'relative',
  zIndex: 1,
  display: 'flex',
  flexDirection: 'column',
  width: 'min(520px, 100vw)',
  minWidth: 0,
  overflow: 'hidden',
  background: 'var(--bg-surface)',
  borderLeft: '1px solid var(--border-subtle)',
  boxShadow: 'var(--shadow-drawer)',
};

const headerStyle: React.CSSProperties = {
  flexShrink: 0,
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
  padding: '18px 18px 14px',
  borderBottom: '1px solid var(--border-subtle)',
};

const kickerStyle: React.CSSProperties = {
  color: 'var(--accent)',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
};

const titleStyle: React.CSSProperties = {
  margin: '5px 0 0',
  color: 'var(--text-primary)',
  fontSize: 19,
  overflowWrap: 'anywhere',
};

const closeStyle: React.CSSProperties = {
  display: 'grid',
  placeItems: 'center',
  width: 32,
  height: 32,
  flexShrink: 0,
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
};

const scrollStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  overscrollBehavior: 'contain',
  padding: 18,
};

const summaryStyle: React.CSSProperties = {
  padding: 14,
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius)',
  background: 'var(--bg-elevated)',
};

const sectionStyle: React.CSSProperties = {
  marginTop: 16,
};

const sectionTitleStyle: React.CSSProperties = {
  margin: 0,
  color: 'var(--text-primary)',
  fontSize: 13,
};

const sectionDescriptionStyle: React.CSSProperties = {
  margin: '5px 0 0',
  color: 'var(--text-muted)',
  fontSize: 11,
  lineHeight: 1.6,
};

const fieldListStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: 8,
  margin: '9px 0 0',
};

const fieldStyle: React.CSSProperties = {
  minWidth: 0,
  padding: 10,
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-input)',
};

const fieldLabelStyle: React.CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: 10,
};

const fieldValueStyle: React.CSSProperties = {
  margin: '5px 0 0',
  color: 'var(--text-primary)',
  fontSize: 12,
  lineHeight: 1.55,
  overflowWrap: 'anywhere',
};

const fieldHintStyle: React.CSSProperties = {
  margin: '4px 0 0',
  color: 'var(--text-muted)',
  fontSize: 10,
  lineHeight: 1.5,
};

const securityStyle: React.CSSProperties = {
  marginTop: 16,
  padding: 12,
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--accent-soft)',
};

function statusStyle(tone: 'neutral' | 'good' | 'warning' = 'neutral'): React.CSSProperties {
  const colors = tone === 'good'
    ? { color: '#3fb950', background: 'rgba(63,185,80,0.14)' }
    : tone === 'warning'
      ? { color: '#d29922', background: 'rgba(210,153,34,0.14)' }
      : { color: 'var(--text-secondary)', background: 'var(--bg-surface)' };
  return {
    ...colors,
    padding: '4px 7px',
    borderRadius: 999,
    fontSize: 10,
    fontWeight: 650,
  };
}
