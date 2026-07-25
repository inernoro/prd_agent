import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, AppWindow, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getGatewayAppCallers } from '@/lib/api';
import type { GatewayAppCaller, LlmLogListItem } from '@/lib/types';
import { SectionLoader } from './ui';

type Props = {
  log: LlmLogListItem;
  onClose: () => void;
};

function displayCode(log: LlmLogListItem) {
  const code = log.appCallerCode?.trim();
  if (code) return code.startsWith('G-') ? code : `G-${code}`;
  return log.appCallerCodeDisplayName || log.appCallerTitle || '未标注 App';
}

function value(value?: string | number | null) {
  return value == null || value === '' ? '—' : String(value);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="lg-app-drawer-field"><dt>{label}</dt><dd>{children}</dd></div>;
}

export function AppCallerDetailsDrawer({ log, onClose }: Props) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [app, setApp] = useState<GatewayAppCaller | null>(null);
  const [loading, setLoading] = useState(Boolean(log.appCallerCode));
  const [error, setError] = useState<string | null>(null);
  const code = log.appCallerCode?.replace(/^G-/, '').trim() ?? '';

  useEffect(() => {
    closeRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  useEffect(() => {
    if (!code) {
      setLoading(false);
      return undefined;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    getGatewayAppCallers({ page: 1, pageSize: 20, search: code }).then((result) => {
      if (!alive) return;
      if (result.success) {
        setApp(result.data.items.find((item) => item.appCallerCode.replace(/^G-/, '') === code) ?? result.data.items[0] ?? null);
      } else {
        setError(result.error?.message || '无法读取 App 配置');
      }
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [code]);

  const fullHref = code
    ? `/app-callers?search=${encodeURIComponent(code)}&focus=${encodeURIComponent(code)}`
    : '/app-callers';

  return createPortal(
    <div className="lg-side-drawer-portal">
      <button className="lg-side-drawer-backdrop" type="button" aria-label="关闭 App 详情" onClick={onClose} />
      <aside className="lg-side-drawer lg-app-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="lg-side-drawer-header">
          <div className="lg-side-drawer-title">
            <span className="lg-side-drawer-icon"><AppWindow size={17} /></span>
            <div><small>App 详情</small><h2 id={titleId}>{displayCode(log)}</h2></div>
          </div>
          <button ref={closeRef} type="button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="lg-side-drawer-body">
          <p className="lg-app-drawer-summary">先在当前日志上下文中确认调用身份与治理摘要，再决定是否进入完整配置页。打开此抽屉不会修改路由或调用上游。</p>
          {loading ? <SectionLoader text="正在读取 App 配置…" /> : null}
          {error ? <div className="lg-app-drawer-error" role="alert">{error}</div> : null}
          <section>
            <h3>本次请求身份</h3>
            <dl className="lg-app-drawer-grid">
              <Field label="App">{displayCode(log)}</Field>
              <Field label="调用方">{value(log.clientCode)}</Field>
              <Field label="环境">{value(log.environment)}</Field>
              <Field label="来源系统">{value(log.sourceSystem)}</Field>
              <Field label="入口协议">{value(log.ingressProtocol || log.protocol)}</Field>
              <Field label="请求类型">{value(log.requestType)}</Field>
            </dl>
          </section>
          {app ? (
            <>
              <section>
                <h3>注册与路由</h3>
                <dl className="lg-app-drawer-grid">
                  <Field label="状态">{value(app.status)}</Field>
                  <Field label="业务标题">{value(app.title)}</Field>
                  <Field label="模型策略">{value(app.modelPolicy || 'auto')}</Field>
                  <Field label="模型池">{value(app.modelPoolId)}</Field>
                  <Field label="参数策略">{value(app.parameterPolicy || 'default-drop')}</Field>
                  <Field label="负责人">{value(app.owner)}</Field>
                </dl>
              </section>
              <section>
                <h3>治理摘要</h3>
                <dl className="lg-app-drawer-grid">
                  <Field label="月预算">{app.monthlyBudgetUsd == null ? '未限制' : `USD ${app.monthlyBudgetUsd}`}</Field>
                  <Field label="单次预占">{app.budgetReservationUsd == null ? '未设置' : `USD ${app.budgetReservationUsd}`}</Field>
                  <Field label="每分钟请求">{app.rateLimitPerMinute == null ? '未限制' : app.rateLimitPerMinute}</Field>
                  <Field label="累计请求">{app.totalSeen}</Field>
                </dl>
              </section>
            </>
          ) : null}
        </div>
        <footer className="lg-side-drawer-footer">
          <Link to={fullHref} onClick={onClose}>打开完整治理页<ArrowUpRight size={14} /></Link>
        </footer>
      </aside>
    </div>,
    document.body,
  );
}
