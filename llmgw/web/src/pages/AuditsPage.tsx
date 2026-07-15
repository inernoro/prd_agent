// GW 操作审计：只读展示 llm_gateway.llmgw_operation_audits，追溯控制台配置动作。
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getOperationAudits } from '@/lib/api';
import type { OperationAuditItem, OperationAuditsData } from '@/lib/types';
import { Button, Chip, SectionLoader } from '@/components/ui';

const PAGE_SIZE = 50;
const SINCE_OPTIONS = [
  { label: '全部时间', value: '' },
  { label: '最近 1 小时', value: '1' },
  { label: '最近 24 小时', value: '24' },
  { label: '最近 7 天', value: '168' },
];

export function AuditsPage() {
  const [searchParams] = useSearchParams();
  const [data, setData] = useState<OperationAuditsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(() => Math.max(1, Number(searchParams.get('page') || '1') || 1));
  const [action, setAction] = useState(() => searchParams.get('action') || '');
  const [targetType, setTargetType] = useState(() => searchParams.get('targetType') || '');
  const [actor, setActor] = useState(() => searchParams.get('actor') || '');
  const [success, setSuccess] = useState(() => searchParams.get('success') || '');
  const [search, setSearch] = useState(() => searchParams.get('search') || '');
  const [sinceHours, setSinceHours] = useState(() => searchParams.get('sinceHours') || '');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    getOperationAudits({
      page,
      pageSize: PAGE_SIZE,
      action: action || undefined,
      targetType: targetType || undefined,
      actor: actor || undefined,
      success: success === '' ? undefined : success === 'true',
      search: search || undefined,
      sinceHours: sinceHours ? Number(sinceHours) : undefined,
    }).then((res) => {
      if (!alive) return;
      if (res.success) setData(res.data);
      else setError(res.error?.message || '加载失败');
    });
    return () => {
      alive = false;
    };
  }, [page, action, targetType, actor, success, search, sinceHours]);

  const pages = useMemo(() => Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE)), [data?.total]);
  const th: React.CSSProperties = { textAlign: 'left', padding: '8px 12px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '8px 12px', fontSize: 12, color: 'var(--text-primary)', borderTop: '1px solid var(--border-subtle)', verticalAlign: 'middle' };

  if (error) return <Empty text={error} />;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ flexShrink: 0, padding: '10px 12px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)', background: 'var(--bg-surface)' }}>
        <strong style={{ fontSize: 14 }}>操作审计</strong>
        <p style={{ margin: '5px 0 0', color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.55 }}>这里记录谁在什么时间修改了租户配置，以及改的是哪个对象。请求内容和提示词正文不会出现在这里；提示词策略只记录策略 id、版本和 hash，其他配置只展示排查所需的状态差异。</p>
      </div>
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <input
          value={search}
          onChange={(e) => {
            setPage(1);
            setSearch(e.target.value);
          }}
          placeholder="搜索 action / target / actor"
          style={{ ...selectStyle, width: 260 }}
        />
        <FilterSelect label="全部动作" value={action} options={data?.actions ?? []} onChange={(v) => { setPage(1); setAction(v); }} />
        <FilterSelect label="全部对象" value={targetType} options={data?.targetTypes ?? []} onChange={(v) => { setPage(1); setTargetType(v); }} />
        <FilterSelect label="全部操作者" value={actor} options={data?.actors ?? []} onChange={(v) => { setPage(1); setActor(v); }} />
        <select value={success} onChange={(e) => { setPage(1); setSuccess(e.target.value); }} style={selectStyle}>
          <option value="">全部结果</option>
          <option value="true">成功</option>
          <option value="false">失败</option>
        </select>
        <select value={sinceHours} onChange={(e) => { setPage(1); setSinceHours(e.target.value); }} style={selectStyle}>
          {SINCE_OPTIONS.map((x) => <option key={x.value || 'all'} value={x.value}>{x.label}</option>)}
        </select>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>{data ? `共 ${data.total} 条` : '加载中'}</span>
      </div>

      {!data ? <SectionLoader text="正在加载操作审计…" /> : data.items.length === 0 ? <Empty text="暂无操作审计" /> : (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain', background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-surface)' }}>
              <tr>
                <th style={th}>时间</th>
                <th style={th}>动作</th>
                <th style={th}>对象</th>
                <th style={th}>操作者</th>
                <th style={th}>结果</th>
                <th style={th}>来源</th>
                <th style={th}>变更</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <AuditRow
                  key={item.id}
                  item={item}
                  td={td}
                  expanded={expandedId === item.id}
                  onToggle={() => setExpandedId((prev) => (prev === item.id ? null : item.id))}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</Button>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{page} / {pages}</span>
        <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))}>下一页</Button>
      </div>
    </div>
  );
}

function AuditRow({ item, td, expanded, onToggle }: { item: OperationAuditItem; td: React.CSSProperties; expanded: boolean; onToggle: () => void }) {
  const result = item.success
    ? { label: '成功', color: '#3fb950', bg: 'rgba(63,185,80,0.14)' }
    : { label: '失败', color: '#f85149', bg: 'rgba(248,81,73,0.14)' };
  return (
    <>
      <tr>
        <td style={td}>{fmtTime(item.createdAt)}</td>
        <td style={td}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span>{actionLabel(item.action)}</span>
            <span style={{ fontFamily: 'ui-monospace, monospace', color: 'var(--text-muted)', fontSize: 10 }}>{item.action || '—'}</span>
          </div>
        </td>
        <td style={td}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 210 }}>
            <span>{item.targetName || item.targetId || '—'}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{targetTypeLabel(item.targetType)} <code>{item.targetType || '—'}</code></span>
          </div>
        </td>
        <td style={td}>{item.actorUsername || item.actorUserId || '—'}</td>
        <td style={td}><Chip label={result.label} color={result.color} bg={result.bg} /></td>
        <td style={td}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 130 }}>
            <span>{item.remoteIp || '—'}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 11, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.userAgent || '—'}</span>
          </div>
        </td>
        <td style={td}>
          <Button size="sm" variant="ghost" onClick={onToggle}>{expanded ? '收起' : '查看'}</Button>
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td style={{ ...td, paddingTop: 0 }} colSpan={7}>
            <pre style={{ margin: 0, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text-secondary)', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', padding: 10 }}>
              {item.reason ? `reason: ${item.reason}\n` : ''}{item.changesJson || '{}'}
            </pre>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function actionLabel(value?: string | null) {
  return ({
    'tenant.create': '创建租户',
    'team.create': '创建团队',
    'team.update': '修改团队',
    'membership.create': '添加成员',
    'membership.update': '修改成员权限',
    'membership.invalidate_sessions': '使成员会话失效',
    'service_key.create': '创建接入密钥',
    'service_key.create_wildcard': '创建通配密钥',
    'service_key.rotation_client_cutover': '完成密钥轮换切换',
    'service_key.rotation_abort': '中止密钥轮换',
    'service_key.revoke': '撤销接入密钥',
    'prompt_policy.update': '保存提示词策略版本',
    'prompt_policy.rollback': '回滚提示词策略',
    'model.create': '创建模型',
    'model.set_enabled': '修改模型启停状态',
    'model.rotate_api_key': '轮换模型密钥',
    'model.delete_api_key': '删除模型密钥',
    'exchange.create': '创建 Exchange',
    'exchange.update': '修改 Exchange 映射',
    'exchange.rotate_api_key': '轮换 Exchange 密钥',
    'exchange.delete_api_key': '删除 Exchange 密钥',
    'exchange.claim_to_gateway': '导入旧 Exchange',
    'pool.model.add': '向模型池增加模型',
    'pool.model.update': '修改模型池成员',
    'pool.model.remove': '移除模型池成员',
    'cost.reconciliation.import': '导入供应商账单',
  } as Record<string, string>)[value ?? ''] ?? '其他配置操作';
}

function targetTypeLabel(value?: string | null) {
  return ({
    llmgw_tenant: '租户',
    llmgw_team: '团队',
    llmgw_membership: '成员关系',
    llmgw_service_key: '接入密钥',
    llmgw_prompt_policy: '提示词策略',
    llmgw_model: '模型',
    llmgw_model_exchange: 'Exchange',
    llmgw_pool: '模型池',
    llmgw_cost_reconciliation: '费用对账记录',
  } as Record<string, string>)[value ?? ''] ?? '配置对象';
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={selectStyle}>
      <option value="">{label}</option>
      {options.map((x) => <option key={x} value={x}>{x}</option>)}
    </select>
  );
}

function fmtTime(value?: string | null) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
      {text}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  height: 32,
  background: 'var(--bg-input)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  padding: '0 9px',
  fontSize: 12,
};
