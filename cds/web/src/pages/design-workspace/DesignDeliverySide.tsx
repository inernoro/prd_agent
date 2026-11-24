import { useState } from 'react';
import { ArrowRight, Check, MessageSquare, PanelRightClose, RotateCcw } from 'lucide-react';
import type { DesignComment, DesignEntry, DesignRequirement, DesignTheme, DesignVersion, DesignWorkspace } from '../../../../src/shared/design-workspace';
import { designVisualKey } from '../../../../src/shared/design-visual';
import { designArtifact, designFeedbackAwaitsViewer } from './design-ui';
import { rationaleOrder } from './DesignRationale';
import { needTrace } from './DesignNeed';
export type DesignFullView = 'need' | 'notes' | 'delivery';

export type SideTab = 'demo' | 'comments' | 'deliver';
type Open = (view: DesignFullView, extra?: Record<string, string>) => void;
type Permissions = NonNullable<DesignWorkspace['permissions']>;

const plain = (text: string) => text.replace(/[*_`]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
/* 思路里的要点：列表项和表格的「选了什么」一列；没有列表时取第一段 */
function points(body: string) {
  const lines = body.split(/\r?\n/).map(line => line.trim());
  const items = lines.filter(line => /^([-*]|\d+[.、])\s+/.test(line)).map(line => plain(line.replace(/^([-*]|\d+[.、])\s+/, '')));
  const table = lines.filter(line => line.startsWith('|') && !/^\|\s*-/.test(line)).slice(1).map(line => line.split('|').map(cell => plain(cell)).filter(Boolean))
    .filter(cells => cells.length >= 2).map(cells => `${cells[0]}：${cells[1]}`);
  const first = lines.find(line => line && !/^[#>|]/.test(line));
  return items.length ? items : table.length ? table : first ? [plain(first)] : [];
}

export function DesignDeliverySide({ entry, version, screenId, requirement, permissions, tab, theme, onTab, open, onCollapse, onScreen, onReview, onAccept }: {
  entry: DesignEntry; version: DesignVersion; screenId?: string; requirement?: DesignRequirement; permissions?: Permissions;
  tab: SideTab; theme: DesignTheme; onTab: (tab: SideTab) => void; open: Open; onCollapse: () => void;
  onScreen: (id: string) => void; onReview: (comment: DesignComment) => void; onAccept: () => void;
}) {
  const comments = entry.comments.filter(row => row.version === version.version);
  const openComments = comments.filter(row => !row.closed).length;
  const tabs: [SideTab, string, number?][] = [['demo', '演示'], ['comments', '评论', openComments || undefined], ['deliver', '交付']];
  return <aside className="dw-sp" aria-label="演示、评论和交付">
    <header className="dw-sp-head">
      <nav className="dw-sp-tabs" role="tablist" aria-label="右侧面板">{tabs.map(([key, label, n]) =>
        <button key={key} type="button" role="tab" aria-selected={tab === key} data-pane={key} onClick={() => onTab(key)}>{label}{n ? <small>{n}</small> : null}</button>)}</nav>
      <button type="button" className="ep-button ep-icon-button" aria-label="收起右栏" data-action="side-collapse" onClick={onCollapse}><PanelRightClose /></button>
    </header>
    <div className="dw-sp-body">
      {tab === 'demo' && <Demo entry={entry} version={version} screenId={screenId} theme={theme} open={open} onScreen={onScreen} />}
      {tab === 'comments' && <Comments version={version} comments={comments} screenId={screenId} onReview={onReview} />}
      {tab === 'deliver' && <Deliver entry={entry} version={version} screenId={screenId} requirement={requirement} permissions={permissions} open={open} onAccept={onAccept} />}
    </div>
  </aside>;
}

const demoGroups = ['画面', '设计库', '交付', '说明', '验收', '记录', '框架'] as const;
function demoGroup(route: string) {
  if (!route.startsWith('#/design?')) return '画面';
  const query = new URLSearchParams(route.slice('#/design?'.length));
  const tab = query.get('tab');
  if (tab === 'accept') return '验收';
  if (tab === 'log') return '记录';
  if (tab && ['need', 'notes', 'rationale', 'spec'].includes(tab)) return '说明';
  if (query.has('framework') || query.get('view') === 'frameworks') return '框架';
  return query.has('design') ? '交付' : '设计库';
}

function Demo({ entry, version, screenId, theme, open, onScreen }: { entry: DesignEntry; version: DesignVersion; screenId?: string; theme: DesignTheme; open: Open; onScreen: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const every = version.screens.map(screen => ({ screen, title: screen.name, tip: version.acceptance.find(rule => rule.screenId === screen.id)?.rule }));
  const declared = version.demo?.flatMap(row => {
    const screen = version.screens.find(screen => screen.id === row.screen);
    return screen ? [{ screen, title: row.title || screen.name, tip: row.tip }] : [];
  }) ?? [];
  const steps = declared.length && !all ? declared : every;
  const index = steps.findIndex(step => step.screen.id === screenId);
  const current = steps[Math.max(index, 0)], next = steps[Math.max(index, 0) + 1];
  const thumb = (screen: DesignVersion['screens'][number]) => {
    const color = screen.themes.includes(theme) ? theme : screen.themes[0];
    const captured = entry.runs.slice().reverse().find(run => run.version === version.version)
      ?.visual?.[designVisualKey(screen.id, `${screen.viewport}-${color}`)]?.referenceImageId;
    return version.renders?.[screen.id]?.[color]?.id ?? captured ?? version.renders?.[screen.id]?.light?.id;
  };
  const { ordered, authorVersion } = rationaleOrder(entry, version);
  const why = ordered.filter(item => item.key === 'goal' || item.key === 'choices')
    .flatMap(item => item.parts.flatMap(part => points(part.body))).slice(0, 6);
  return <>
    <section className="dw-sp-sec" data-sec="flow">
      <h3>演示流程<small>{steps.length ? `${Math.max(index, 0) + 1} / ${steps.length}` : ''}</small></h3>
      {current && <div className="dw-sp-tip">
        <p><strong>{current.title}</strong>{current.tip ? ` · ${current.tip}` : ''}</p>
        <div className="dw-sp-acts">
          {next ? <button type="button" className="ep-button ep-button--primary" data-action="demo-next" onClick={() => onScreen(next.screen.id)}>下一步：{next.title}<ArrowRight /></button>
            : <span className="dw-sp-done"><Check />走完了，也可以直接在画面里点</span>}
          {index > 0 && <button type="button" className="ep-button" data-action="demo-restart" onClick={() => onScreen(steps[0].screen.id)}><RotateCcw />从头开始</button>}
        </div>
      </div>}
      {!steps.length && <p className="dw-ds-empty">这一版没有画面清单，只能整页查看原型。</p>}
      {demoGroups.map(group => {
        const visible = steps.filter(step => demoGroup(step.screen.route) === group);
        return visible.length > 0 && <div className="dw-sp-group" key={group}>
          <h4>{group}<small>{visible.length}</small></h4>
          <ol className="dw-sp-thumbs">{visible.map(step => {
            const image = thumb(step.screen);
            return <li key={step.screen.id}><button type="button" aria-current={step.screen.id === screenId ? 'step' : undefined}
              onClick={() => onScreen(step.screen.id)} title={step.title}>
              <span className="dw-sp-thumb">{image ? <img src={designArtifact(entry.projectId, image)} alt="" loading="lazy" />
                : <small>{step.screen.viewport === 'phone' ? '手机' : '桌面'}</small>}</span>
              <span className="dw-sp-ttitle">{step.title}</span>
            </button></li>;
          })}</ol>
        </div>;
      })}
      {declared.length > 0 && declared.length < every.length && <button type="button" className="ep-link dw-ds-more" data-action="demo-all"
        aria-expanded={all} onClick={() => setAll(value => !value)}>{all ? `只看演示流程（${declared.length} 步）` : `看全部 ${every.length} 个画面`}</button>}
    </section>
    <section className="dw-sp-sec" data-sec="why">
      <h3>这一版解决什么{authorVersion && authorVersion.version !== version.version && <small>沿用 V{authorVersion.version}</small>}</h3>
      {why.length ? <ul className="dw-sp-why">{why.map((text, i) => <li key={i}>{text}</li>)}</ul> : <p className="dw-ds-empty">这一版没有写目标和取舍。</p>}
      {authorVersion && <button type="button" className="ep-link dw-ds-more" data-action="side-notes" onClick={() => open('notes')}>完整思路：取舍、依据和待定</button>}
    </section>
  </>;
}

function Comments({ version, comments, screenId, onReview }: { version: DesignVersion; comments: DesignComment[]; screenId?: string; onReview: (comment: DesignComment) => void }) {
  const name = (id: string) => version.screens.find(screen => screen.id === id)?.name ?? '整页';
  const rows = [...comments].sort((a, b) => Number(b.screenId === screenId) - Number(a.screenId === screenId)
    || Number(a.closed) - Number(b.closed) || b.createdAt.localeCompare(a.createdAt));
  return <section className="dw-sp-sec" data-sec="comments">
    <h3>评论<small>{comments.length ? `${comments.filter(row => !row.closed).length} 条待处理` : ''}</small></h3>
    {rows.length ? <ul className="dw-sp-comments">{rows.map(row => <li key={row.id}>
      <button type="button" data-closed={row.closed || undefined} data-here={row.screenId === screenId || undefined} onClick={() => onReview(row)}>
        <span className="dw-sp-cmeta"><b>{row.author.label}</b><span>{name(row.screenId)}</span><em>{row.closed ? '已解决' : row.replies.length ? `${row.replies.length} 条回复` : '待处理'}</em></span>
        <span className="dw-sp-cbody">{row.body}</span>
      </button></li>)}</ul>
      : <p className="dw-ds-empty">这一版还没有评论。</p>}
    <p className="dw-sp-hint"><MessageSquare />在画面右上角点「评论」，再点画面上要说的位置。</p>
  </section>;
}

function Deliver({ entry, version, screenId, requirement, permissions, open, onAccept }: {
  entry: DesignEntry; version: DesignVersion; screenId?: string; requirement?: DesignRequirement; permissions?: Permissions; open: Open; onAccept: () => void;
}) {
  const screen = version.screens.find(row => row.id === screenId);
  const rules = version.acceptance.filter(rule => rule.screenId === screenId);
  const trace = needTrace(entry, version, requirement);
  const clauses = trace.rows.filter(row => row.covers.some(cover => cover.rule.screenId === screenId));
  const files = version.delivery?.files ?? [];
  const inputs = [...files.filter(file => file.kind === 'guide'), ...files.filter(file => /\.diff$/.test(file.path)), ...files.filter(file => file.kind === 'document' && !/\.diff$/.test(file.path))].slice(0, 3);
  const feedback = (entry.feedback ?? []).filter(row => row.screenId === screenId && row.status !== 'closed')
    .map(row => ({ row, mine: permissions ? designFeedbackAwaitsViewer(entry, row, permissions.actorId) : false }));
  if (!screen) return <p className="dw-ds-empty dw-sp-sec">先在画面里选一屏。</p>;
  return <>
    <p className="dw-sp-lead">实现「{screen.name}」要交付的是下面五样。</p>
    <section className="dw-sp-sec dw-sp-num" data-sec="build"><h3><b>1</b>做出什么</h3>
      <p>{screen.name} · {screen.viewport === 'phone' ? '手机 375' : '桌面 1280'} · 浅色{screen.themes.includes('dark') ? '和深色' : ''}</p>
      <code className="dw-sp-route">{screen.route.replace(/^#/, '')}</code>
    </section>
    <section className="dw-sp-sec dw-sp-num" data-sec="done"><h3><b>2</b>做到什么算完成<small>{rules.length} 项验收</small></h3>
      {rules.length ? <ul>{rules.slice(0, 4).map(rule => <li key={rule.id} className="dw-ds-rule"><code>{rule.id}</code><span>{rule.rule}{rule.expected && <small>{rule.expected.replace(/。?检查：.*$/, '')}</small>}</span></li>)}</ul>
        : <p className="dw-ds-empty">这一屏没有验收项，按画面实现即可。</p>}
      <button type="button" className="ep-link dw-ds-more" data-action="side-accept" onClick={onAccept}>全部 {version.acceptance.length} 项验收和检查方法</button>
    </section>
    <section className="dw-sp-sec dw-sp-num" data-sec="why"><h3><b>3</b>为什么要这样<small>{requirement ? `${clauses.length} 条需求` : ''}</small></h3>
      {!requirement ? <p className="dw-ds-empty">这份稿件没有关联需求。</p>
        : clauses.length ? <ul>{clauses.slice(0, 3).map(row => <li key={row.n}><button type="button" className="dw-ds-row" onClick={() => open('need')}>
          <b className="dw-need-n">{row.n}</b><span>{plain(row.text)}</span><span className="dw-status" data-state={row.verdict.state}>{row.verdict.label}</span></button></li>)}</ul>
        : <p className="dw-ds-empty">这一屏没有对应的需求条款。</p>}
    </section>
    <section className="dw-sp-sec dw-sp-num" data-sec="inputs"><h3><b>4</b>拿什么做</h3>
      {inputs.length ? <ul>{inputs.map(file => <li key={file.id}><button type="button" className="dw-ds-row dw-ds-file" onClick={() => open('delivery', { part: 'files', file: file.id })}>
        <span>{file.kind === 'guide' ? '交付说明' : /\.diff$/.test(file.path) ? '源码差异' : file.path.split('/').at(-1)}</span></button></li>)}</ul>
        : <p className="dw-ds-empty">这一版没有附交付文件。</p>}
    </section>
    <section className="dw-sp-sec dw-sp-num" data-sec="open"><h3><b>5</b>还没定的<small>{feedback.length ? `${feedback.length} 条` : ''}</small></h3>
      {feedback.length ? <ul>{feedback.slice(0, 3).map(({ row, mine }) => <li key={row.id}><button type="button" className="dw-ds-row" onClick={() => open('delivery', { part: 'feedback', fb: row.id })}>
        <span className="dw-ds-dot" data-mine={mine || undefined} aria-hidden="true" /><span>{row.title}</span><small>{mine ? '等你' : row.status === 'responded' ? '已回复' : '等对方'}</small></button></li>)}</ul>
        : <p className="dw-ds-empty">这一屏没有未关闭的反馈。</p>}
      {permissions?.feedback && <button type="button" className="ep-link dw-ds-more" onClick={() => open('delivery', { part: 'feedback', fb: 'new', ...(screenId ? { screen: screenId } : {}) })}>有问题就提反馈</button>}
    </section>
  </>;
}
