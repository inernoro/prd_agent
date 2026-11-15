// GW 操作审计：只读展示 llm_gateway.llmgw_operation_audits，追溯控制台配置动作。
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getOperationAudits } from '@/lib/api';
import type { OperationAuditItem, OperationAuditsData } from '@/lib/types';
import { Button, Chip, SectionLoader } from '@/components/ui';
import { fmtDate } from '@/lib/logsHelpers';
import './AuditsPage.css';
import { TABLE_CELL, TABLE_HEAD_CELL, TOOLBAR_CONTROL } from '@/lib/typography';

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
  const [refresh, setRefresh] = useState(0);
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
    }).catch(() => { if (alive) setError('连接失败，请重试。'); });
    return () => {
      alive = false;
    };
  }, [page, action, targetType, actor, success, search, sinceHours, refresh]);

  const pages = useMemo(() => Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE)), [data?.total]);
  const th = TABLE_HEAD_CELL;
  const td = TABLE_CELL;


  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <header className="lg-page-heading">
        <div>
          <h1>操作审计</h1>
          <p>追溯租户配置的操作者、时间与变更结果。</p>
          <details><summary>记录与隐私范围</summary><p>请求内容和提示词正文不会出现在这里；提示词策略只记录策略 id、版本和 hash，其他配置只展示排查所需的状态差异。</p></details>
        </div>
      </header>
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <input
          aria-label="搜索审计记录"
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
        <select aria-label="执行结果" value={success} onChange={(e) => { setPage(1); setSuccess(e.target.value); }} style={selectStyle}>
          <option value="">全部结果</option>
          <option value="true">成功</option>
          <option value="false">失败</option>
        </select>
        <select aria-label="审计时间范围" value={sinceHours} onChange={(e) => { setPage(1); setSinceHours(e.target.value); }} style={selectStyle}>
          {SINCE_OPTIONS.map((x) => <option key={x.value || 'all'} value={x.value}>{x.label}</option>)}
        </select>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--fs-caption)', color: 'var(--text-muted)' }}>{data ? `共 ${data.total} 条` : error ? '读取失败' : '加载中'}</span>
      </div>

      {error ? <div role="alert">{error} <Button variant="ghost" onClick={() => setRefresh(value => value + 1)}>重新读取</Button></div> : !data ? <SectionLoader text="正在加载操作审计…" /> : data.items.length === 0 ? <Empty text="暂无操作审计" /> : (
        <div style={{ flex: data.total > PAGE_SIZE ? 1 : '0 1 auto', minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain', background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)' }}>
          <table className="lg-data-table lg-audits-desktop" style={{ width: '100%', borderCollapse: 'collapse' }}>
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
          <div className="lg-audits-mobile">
            {data.items.map(item => <article key={item.id}>
              <div className="lg-audit-mobile-heading"><strong>{actionLabel(item.action)}</strong><Chip label={item.success ? '成功' : '失败'} color={item.success ? 'var(--ok)' : 'var(--err)'} bg={item.success ? 'var(--ok-bg)' : 'var(--err-bg)'} /></div>
              <div>{item.targetName || item.targetId || '对象未记录'}</div>
              <div className="lg-audit-mobile-meta">{item.actorUsername || item.actorUserId || '操作者未记录'} · {fmtTime(item.createdAt)}</div>
              <button type="button" aria-expanded={expandedId === item.id} onClick={() => setExpandedId(value => value === item.id ? null : item.id)}>{expandedId === item.id ? '收起变更' : '查看变更'}</button>
              {expandedId === item.id ? <div className="lg-audit-mobile-detail">
                <div>动作：{item.action || '未记录'}</div><div>对象类型：{item.targetType || '未记录'}</div><div>对象编号：{item.targetId || '未记录'}</div>
                <div>来源：{item.remoteIp || '未记录'}</div><div>客户端：{item.userAgent || '未记录'}</div>
                {item.reason ? <div>原因：{item.reason}</div> : null}<pre>{item.changesJson || '{}'}</pre>
              </div> : null}
            </article>)}
          </div>
        </div>
      )}

      {pages > 1 ? <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</Button>
        <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-muted)' }}>{page} / {pages}</span>
        <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))}>下一页</Button>
      </div> : null}
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
        <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtTime(item.createdAt)}</td>
        <td style={td}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span>{actionLabel(item.action)}</span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', fontSize: 'var(--fs-micro)' }}>{item.action || '—'}</span>
          </div>
        </td>
        <td style={td}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 210 }}>
            <span>{item.targetName || item.targetId || '—'}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-micro)' }}>{targetTypeLabel(item.targetType)} <code>{item.targetType || '—'}</code></span>
          </div>
        </td>
        <td style={td}>{item.actorUsername || item.actorUserId || '—'}</td>
        <td style={td}><Chip label={result.label} color={result.color} bg={result.bg} /></td>
        <td style={td}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 130 }}>
            <span>{item.remoteIp || '—'}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-micro)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.userAgent || '—'}</span>
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
    'platform.create': '添加上游',
    'platform.update': '修改上游配置',
    'platform.set_enabled': '修改上游启停状态',
    'platform.delete': '删除上游',
    'platform.models.import': '导入上游模型',
    'platform.claim_to_gateway': '导入上游配置',
    'platform.rotate_api_key': '轮换上游密钥',
    'platform.delete_api_key': '删除上游密钥',
    'platform.bulk_rotate_api_key': '批量轮换上游密钥',
    'platform.cleanup_unused_models': '清理上游未使用模型',
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
  } as Record<string, string>)[value ?? ''] ?? value ?? '未记录操作';
}

function targetTypeLabel(value?: string | null) {
  return ({
    llmgw_platform: '上游',
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
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} style={selectStyle}>
      <option value="">{label}</option>
      {options.map((x) => <option key={x} value={x}>{x}</option>)}
    </select>
  );
}

function fmtTime(value?: string | null) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${fmtDate(value)} ${d.toLocaleTimeString('zh-CN', { hourCycle: 'h23' })}`;
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ padding: '24px 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 'var(--fs-secondary)' }}>
      {text}
    </div>
  );
}

const selectStyle: React.CSSProperties = TOOLBAR_CONTROL;
