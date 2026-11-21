import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, Clipboard, KeyRound, Search, Terminal } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AnchoredPopover } from '@/components/ui/anchored-popover';
import type { EnvAuditFact, PlanningDecisionSearch, PlanningDecision } from '../../../../src/shared/engineering-planning';
import { planningDecisionHref, planningPreviewDecisionSubject } from '../../../../src/shared/engineering-planning-links';
import { apiUrl } from '@/lib/api';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { debtLabels, decisionLabels, dateLabel, planningPath, usePlanningRead } from './planning-ui';

export const provenanceLabels = { original: '原始记录', backfilled: '补录', inferred: '推断' };
type ReadProps = { projectId: string; open: boolean; reload: number };
export function DecisionSearch({ projectId, reload, onDecision }: { projectId: string; reload: number; onDecision: (id: string) => void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const resultsId = useId();
  const [open, setOpen] = useState(false);
  const [entry, setEntry] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(entry.trim()), 170);
    return () => window.clearTimeout(timer);
  }, [entry]);
  const decision = usePlanningRead<PlanningDecisionSearch>(open ? `${planningPath(projectId)}/decisions?q=${encodeURIComponent(query)}` : null, reload);
  return <>
    <button ref={anchor} type="button" className="ep-button ep-query-trigger" aria-label="搜决策，例如预览登录"
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? resultsId : undefined} onClick={() => setOpen(value => !value)}>
      <Search aria-hidden="true" /><span>搜决策，例如「预览登录」</span></button>
    <AnchoredPopover open={open} anchorRef={anchor} onDismiss={() => setOpen(false)} autoFocus="first" role="dialog"
      aria-label="搜索决策" id={resultsId} widthRem={28} maxHeightRem={27} align="end" className="ep-dialog ep-query-popover">
      <label><span className="sr-only">决策关键词</span><input placeholder="例如 预览登录" autoComplete="off" value={entry} onChange={event => setEntry(event.target.value)} maxLength={200} /></label>
      {decision.error ? <p role="alert">{decision.error}</p> : decision.loading ? <ContentLoading label="正在搜索决策" />
        : decision.data?.items.length ? <ul className="ep-query-results">{decision.data.items.map(row => <li key={row.id}>
          <button type="button" onClick={() => { setOpen(false); onDecision(row.id); }}>
            <span><code>{row.id}</code> · {decisionLabels[row.status]}</span><strong>{row.title}</strong>
            {row.rationale && <small>{row.rationale}</small>}
          </button>
        </li>)}</ul> : <p>没有匹配的决策</p>}
    </AnchoredPopover>
  </>;
}

const dispositionLabels = { added: '新增', changed: '有变化', deleted: '删除', unchanged: '没变化', rotated: '已轮换', unknown: '未知' };
const effectLabels = { pending: '等待重新部署', effective: '已生效', inferred: '推断生效', unknown: '生效状态未知', 'not-applicable': '无需重新部署' };

export function ConfigurationTrail({ projectId, branchId, keys, reload = 0, compact = false }: {
  projectId: string; branchId?: string; keys?: string[]; reload?: number; compact?: boolean;
}) {
  const [selected, setSelected] = useState<EnvAuditFact>();
  const path = planningPath(projectId) + '/changes';
  const query = new URLSearchParams(branchId ? { branchId } : {});
  const state = usePlanningRead<{ projectId: string; facts: EnvAuditFact[] }>(path + '?' + query, reload);
  const rows = (state.data?.facts ?? []).filter(row => !keys || keys.includes(row.key)).reverse();
  const download = new URLSearchParams(query);
  download.set('archive', '1');
  return <section className="ep-surface ep-trail">
    <div className="ep-section-header"><h2>{keys ? '相关配置变更' : compact ? '最近变更' : '配置变更记录'}</h2><span className="ep-caption">键名与变更状态</span>
      {!compact && !state.error && <a className="ep-button" href={apiUrl(path + '?' + download)} download="cds-config-changes.json">导出记录</a>}
    </div>
    {state.error ? <p role="alert">{state.error}</p> : state.loading ? <ContentLoading variant={compact ? 'inline' : 'rows'} label="正在读取变更记录" />
      : !rows.length ? <p>没有可核对的变更记录。</p>
      : <div className="ep-trail-list">{(compact ? rows.slice(0, 4) : rows).map(row =>
        <button type="button" key={row.eventId} className="ep-trail-row" onClick={() => setSelected(row)}>
          <span><code>{row.eventId.slice(0, 8)}</code><strong>{row.key}</strong></span>
          <span><span className="ep-badge" data-tone={['changed','added','rotated'].includes(row.disposition) ? 'success' : undefined}>{dispositionLabels[row.disposition]}</span>
            <small>{dateLabel(row.ts)} · {row.actor || '操作者未知'} · {effectLabels[row.effect.state]}</small>
          </span>
        </button>)}</div>}
    {selected && <TrailDetail row={selected} onClose={() => setSelected(undefined)} />}
  </section>;
}

function TrailDetail({ row, onClose }: { row: EnvAuditFact; onClose: () => void }) {
  const { projectId, key } = row;
  const subject = new URLSearchParams({ subjectKind: 'config', subjectRef: key });
  const decisions = usePlanningRead<PlanningDecisionSearch>(`${planningPath(projectId)}/decisions?${subject}`, 0);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent frame className="ep-dialog ep-dialog--detail" overlayClassName="ep-dialog-overlay">
      <DialogHeader className="ep-dialog-head"><DialogTitle>配置变更 · {row.key}</DialogTitle><DialogDescription>{dateLabel(row.ts)} · {dispositionLabels[row.disposition]}</DialogDescription></DialogHeader>
      <div className="ep-dialog-content">
        {row.effect.reason && <p className="ep-trail-evidence-note"><strong>{effectLabels[row.effect.state]}</strong> · {row.effect.reason}</p>}
        <dl className="ep-trail-detail">
          <dt>环境</dt><dd>{row.branchId ? `分支 ${row.branchId}` : row.profileId ? `构建配置 ${row.profileId}` : row.branchReason || '项目级配置'}</dd>
          <dt>操作者</dt><dd>{row.actor ?? '未知'}{row.actorReason && ` · ${row.actorReason}`}</dd>
          {(row.signer || row.signerReason) && <><dt>签发人</dt><dd>{row.signer ?? `未知 · ${row.signerReason}`}</dd></>}
          <dt>会话</dt><dd>{row.sessionId ?? row.sessionReason ?? '未知'}</dd>
          {row.threadId && <><dt>线程</dt><dd>{row.threadId}</dd></>}
          {row.turnId && <><dt>回合</dt><dd>{row.turnId}</dd></>}
          {row.skillName && <><dt>技能</dt><dd>{row.skillName} {row.skillVersion}</dd></>}
          <dt>写入结果</dt><dd>{row.dispositionReason || dispositionLabels[row.disposition]}</dd>
          <dt>生效状态</dt><dd>{effectLabels[row.effect.state]}{row.effect.at ? ` · ${dateLabel(row.effect.at)}` : ''}</dd>
          {row.effect.runId && <><dt>部署证据</dt><dd><a className="ep-link" href={apiUrl(`/api/deployment-runs/${encodeURIComponent(row.effect.runId)}`)} target="_blank" rel="noreferrer">{row.effect.runId}</a></dd></>}
          {row.requestId && <><dt>请求</dt><dd>{row.requestId}</dd></>}
          {row.operationId && <><dt>操作</dt><dd>{row.operationId}</dd></>}
          {row.note && <><dt>说明</dt><dd>{row.note}</dd></>}
        </dl>
        <h3>关联决策</h3>
        {decisions.error ? <p role="alert">{decisions.error}</p> : decisions.loading ? <ContentLoading variant="inline" label="正在读取关联决策" />
          : decisions.data?.items.length ? decisions.data.items.map(decision => <DecisionEvidenceLink key={decision.id} projectId={projectId} row={decision} onClick={onClose} />)
          : <p>未关联</p>}
      </div>
    </DialogContent>
  </Dialog>;
}

function DecisionEvidenceLink({ row, projectId, onClick }: { row: PlanningDecision; projectId: string; onClick?: () => void }) {
  return <Link className="ep-link" onClick={onClick}
    to={planningDecisionHref(projectId, row.id)}>{row.id} · {row.title}</Link>;
}

export function PreviewDecision({ projectId, open, reload }: ReadProps) {
  const query = new URLSearchParams(planningPreviewDecisionSubject);
  const result = usePlanningRead<PlanningDecisionSearch>(open ? `${planningPath(projectId)}/decisions?${query}` : null, reload);
  const decision = result.data?.items.find(item => item.status === 'accepted');
  if (decision) return <div className="ep-preview-why">
    <Link className="ep-link" to={planningDecisionHref(projectId, decision.id)}>为什么要单独登录？</Link>
    <p>预览使用独立会话。通过 CDS 项目授权核对后，可用一次性票据进入预览。</p>
  </div>;
  return <details className="ep-preview-why">
    <summary>为什么要单独登录？</summary>
    <p>预览使用独立会话。通过 CDS 项目授权核对后，可用一次性票据进入预览。</p>
  </details>;
}

const cliCommands = [
  ['查看工程规划', 'planning show'],
  ['按日常说法找决策', 'decision search --q "预览登录"'],
  ['搜索项目债务', 'debt list --view unpaid'],
  ['读取接手卡', 'debt brief <债务编号>'],
  ['查看债务演进', 'debt stats'],
  ['提交结构化提案', 'planning submit --file proposal.json'],
  ['发布设计稿件', 'design publish --dir .'],
];

const debtFields = [
  ['id, projectId, version', '项目、记录编号和并发版本', '在哪个项目里操作'],
  ['source.type, source.ref, source.url', '触发类型、稳定来源编号和可选证据链接', '从哪里发现'],
  ['title, summary, impact', '问题描述及影响', '现在有什么问题'],
  ['rootCause.state, rootCause.text, rootCause.basis', '待查、推测或已确认，确认时要有依据', '根因是什么'],
  ['whyDebt, decisionId', '当时接受的取舍及关联决策', '为什么先欠债'],
  ['priority, owner, module, tags', '优先级、负责人、模块与分类', '谁处理，如何查找'],
  ['dueAt, trigger', '计划日期或开始处理的触发条件', '什么时候还债'],
  ['criteria, direction', '可观察的偿还标准、目标和尝试记录', '怎样算还清'],
  ['repayment.results, repayment.evidence', '逐项判断、实拍、测试或相关变更', '还债的证据是什么'],
  ['status, outcome, reopenCount', '处理阶段、关闭结局和重开次数', '现在还剩什么'],
] as const;

function PlanningDataSpec() {
  const states = [['open', 40, 100], ['deferred', 265, 25], ['in_progress', 265, 175], ['repaid', 530, 100], ['dropped', 690, 185]] as const;
  const transitions = [
    ['M192 111 C225 72 250 54 265 46', 187, 71, '暂缓并约定回看'],
    ['M192 130 C222 152 244 192 265 195', 194, 174, '开始处理'],
    ['M340 69 L340 175', 350, 123, '回看并开始处理'],
    ['M417 197 C457 198 502 151 530 130', 452, 178, '逐条验证并附证据'],
    ['M600 100 C570 66 233 63 132 100', 465, 58, '复发后重开'],
    ['M417 209 L690 208', 548, 229, '失效或被替代'],
  ] as const;
  return <div className="ep-spec">
    <section className="ep-surface"><h3>债务状态</h3>
      <div className="ep-spec-scroll" role="region" aria-label="债务状态图" tabIndex={0}>
        <svg className="ep-spec-states" viewBox="0 0 862 245" role="img" aria-label="待处理的债务可以暂缓或开始处理，按标准核验后偿还，复发后可重开">
          <defs><marker id="ep-state-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10Z" /></marker></defs>
          {transitions.map(([path, x, y, label]) => <g key={label}>
            <path d={path} markerEnd="url(#ep-state-arrow)" />
            <text className="ep-state-label" x={x} y={y}>{label}</text>
          </g>)}
          {states.map(([state, x, y]) => <g key={state} data-state={state}>
            <rect x={x} y={y} width="152" height="44" rx="7" />
            <text x={x + 76} y={y + 27} textAnchor="middle">{debtLabels[state]} {state}</text>
          </g>)}
        </svg>
      </div>
      <p className="ep-caption">到期回看和计划逾期由日期计算。重开保留以前的偿还和证据，失效记录保留关闭结局。</p>
    </section>
    <section className="ep-surface"><h3>债务字段</h3>
      <div className="ep-spec-scroll" role="region" aria-label="债务字段表" tabIndex={0}>
        <table><thead><tr><th scope="col">字段</th><th scope="col">说明</th><th scope="col">回答的问题</th></tr></thead>
          <tbody>{debtFields.map(([field, description, question]) => <tr key={field}><td><code>{field}</code></td><td>{description}</td><td>{question}</td></tr>)}</tbody>
        </table>
      </div>
    </section>
    <section className="ep-surface"><h3>数据来源与审批</h3>
      <dl><dt>决策</dt><dd>结论、取舍、适用对象、原始依据和证据等级。技能可提出补录，项目成员确认后进入正式记录。</dd>
        <dt>CLI 与 MCP</dt><dd>使用当前项目凭据。提交重试沿用请求编号和内容，变更携带记录版本。</dd>
        <dt>配置留痕</dt><dd>写入接口和部署事件自动记录事实。历史缺失显示未知及原因。</dd>
        <dt>设计稿件</dt><dd>发布绑定稿件与框架版本。做法验收逐格记录视口、主题、实拍与部署提交。</dd>
      </dl>
    </section>
  </div>;
}
export function PlanningUtilities({ projectId, view, onTab }: { projectId: string; view: 'cli' | 'spec'; onTab: (view: 'cli' | 'spec') => void }) {
  const [copied, setCopied] = useState('');
  return <section className="ep-surface ep-utility">
    <div className="ep-section-header"><h2><Terminal />CLI 协作</h2><div className="ep-tabs">
      <button type="button" aria-pressed={view === 'cli'} onClick={() => onTab('cli')}>常用命令</button>
      <button type="button" aria-pressed={view === 'spec'} onClick={() => onTab('spec')}>数据与 CLI 规范</button>
    </div></div>
    {view === 'cli' ? <div className="ep-cli-sheet">
      {cliCommands.map(([title, args]) => {
        const command = `cdscli ${args} --project ${projectId}`;
        return <div className="ep-trail-row" key={args}><span><strong>{title}</strong><code>{command}</code></span>
          <button className="ep-button" type="button" onClick={async () => {
            await navigator.clipboard.writeText(command);
            setCopied(args);
          }}><Clipboard />{copied === args ? '已复制' : '复制'}</button></div>;
      })}</div> : <PlanningDataSpec />}
    <Link className="ep-link" to={`/design?project=${encodeURIComponent(projectId)}`}>设计稿件 <ArrowRight /></Link>
    <Link className="ep-link" to="/preview-access"><KeyRound />预览访问申请</Link>
  </section>;
}
