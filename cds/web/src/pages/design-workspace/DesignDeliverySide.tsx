import { useState } from 'react';
import { ArrowRight, Check, PanelRightClose, RotateCcw } from 'lucide-react';
import type { DesignEntry, DesignRequirement, DesignTheme, DesignVersion, DesignWorkspace } from '../../../../src/shared/design-workspace';
import { designVisualKey } from '../../../../src/shared/design-visual';
import { isDesignPhoneViewport, type DesignCommand } from './design-ui';
import { DesignThumbnail, useDesignThumbnails } from './DesignGallery';
import { rationaleOrder } from './DesignRationale';
import { DesignConversation, designThreads, type CommentDraft, type DesignThread } from './DesignConversation';
export type DesignFullView = 'need' | 'notes' | 'delivery';

/* V25 把右栏合成「这一版 · 对话」两页。V26（用户：两个页签把画面和要点挤在一起，不好看；按三个按钮来：画面、要点、评论，评论就是原来的对话）：
 *   画面 —— 演示流程：当前这一步、下一步、按区域分组的缩略图；
 *   要点 —— 这一版解决什么（放最上面）→ 这一屏要做到什么，和验收、交付说明、源码差异、交接清单的链接；
 *   评论 —— 这份稿件的全部对话（不再只看这一版），时间线、已商定的结论、在画面上评论都在这里。
 * 地址：pane 不写是「画面」，pane=points 是「要点」，pane=comments 是「评论」；旧地址 pane=deliver 打开「要点」。 */
export type SideTab = 'demo' | 'points' | 'comments' | 'deliver';
type Open = (view: DesignFullView, extra?: Record<string, string>) => void;
type Permissions = NonNullable<DesignWorkspace['permissions']>;

const plain = (text: string) => text.replace(/[*_`]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
/* 思路里的要点：顶层列表项（缩进的「原因」接在后面，「放弃」不列），或表格的「选了什么」一列；没有列表时取第一段。
 * V26：以前把缩进的「原因：」「放弃：」也当成要点，和「这一版解决什么」混在一起 */
function points(body: string) {
  const raw = body.split(/\r?\n/);
  const items: string[] = [];
  for (const line of raw) {
    const top = /^([-*]|\d+[.、])\s+/.test(line);
    const sub = /^\s+([-*]|\d+[.、])\s+/.test(line);
    if (top) items.push(plain(line.replace(/^([-*]|\d+[.、])\s+/, '')));
    else if (sub && items.length) {
      const text = plain(line.trim().replace(/^([-*]|\d+[.、])\s+/, ''));
      if (/^原因[：:]/.test(text)) items[items.length - 1] += `（${text.replace(/^原因[：:]\s*/, '')}）`;
    }
  }
  const lines = raw.map(line => line.trim());
  const table = lines.filter(line => line.startsWith('|') && !/^\|\s*-/.test(line)).slice(1).map(line => line.split('|').map(cell => plain(cell)).filter(Boolean))
    .filter(cells => cells.length >= 2).map(cells => `${cells[0]}：${cells[1]}`);
  const first = lines.find(line => line && !/^[#>|]/.test(line));
  return items.length ? items : table.length ? table : first ? [plain(first)] : [];
}

export function DesignDeliverySide({ entry, version, screenId, permissions, tab, theme, onTab, open, onCollapse, onScreen, onAccept,
  command, busy, thread, onThread, onPin, draft, onDraftCancel, onDraftSubmit }: {
  entry: DesignEntry; version: DesignVersion; screenId?: string; requirement?: DesignRequirement; permissions?: Permissions;
  tab: SideTab; theme: DesignTheme; onTab: (tab: SideTab) => void; open: Open; onCollapse: () => void;
  onScreen: (id: string) => void; onAccept: () => void;
  command?: DesignCommand; busy?: boolean; thread?: string; onThread: (key?: string) => void; onPin?: () => void;
  draft?: CommentDraft; onDraftCancel?: () => void; onDraftSubmit?: (body: string) => Promise<boolean>;
}) {
  const threads = designThreads(entry);
  const waiting = threads.filter(row => row.state !== 'closed').length;
  const pane: SideTab = tab === 'comments' ? 'comments' : tab === 'points' || tab === 'deliver' ? 'points' : 'demo';
  const tabs: [SideTab, string, number?][] = [['demo', '画面'], ['points', '要点'], ['comments', '评论', waiting || undefined]];
  /* 谁能确认商定：反馈是发起人或管理员（和「反馈和资料」页的关闭权限一样），评论是能核对的人 */
  const canAgree = (row: DesignThread) => row.kind === 'feedback'
    ? Boolean(!row.feedback?.stage && permissions?.feedback && (permissions.human ?? permissions.review)
      && (permissions.steward || row.authorId === permissions.actorId))
    : Boolean(permissions?.review && (permissions.steward || row.authorId === permissions.actorId)
      && entry.versions.some(version => Object.hasOwn(version.resolves, row.id)));
  return <aside className="dw-sp dw-sp25 dw-sp26" aria-label="画面、要点和评论" data-pane={pane}>
    <header className="dw-sp-head">
      <nav className="dw-sp-tabs" role="tablist" aria-label="右侧面板">{tabs.map(([key, label, n]) =>
        <button key={key} type="button" role="tab" aria-label={label} aria-selected={pane === key} data-pane={key} onClick={() => onTab(key)}>{label}{n ? <small>{n}</small> : null}</button>)}</nav>
      <button type="button" className="ep-button ep-icon-button" aria-label="收起右栏" data-action="side-collapse" onClick={onCollapse}><PanelRightClose /></button>
    </header>
    <div className="dw-sp-body">
      {pane === 'demo' && <Flow entry={entry} version={version} screenId={screenId} theme={theme} onScreen={onScreen} />}
      {pane === 'points' && <Points entry={entry} version={version} screenId={screenId} open={open} onAccept={onAccept} />}
      {pane === 'comments' && <DesignConversation entry={entry} version={version} threads={threads} selected={thread} onSelect={onThread} permissions={permissions}
        screenId={screenId} command={command} busy={busy} canReply={Boolean(permissions?.feedback || permissions?.write)} canAgree={canAgree}
        onLocate={row => row.screenId && onScreen(row.screenId)} onPin={permissions?.review ? onPin : undefined}
        draft={draft} onDraftCancel={onDraftCancel} onDraftSubmit={onDraftSubmit} />}
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

function Flow({ entry, version, screenId, theme, onScreen }: {
  entry: DesignEntry; version: DesignVersion; screenId?: string; theme: DesignTheme; onScreen: (id: string) => void;
}) {
  const { renders, running, status } = useDesignThumbnails(entry.projectId, version, entry.id);
  const [all, setAll] = useState(false);
  const every = version.screens.map(screen => ({ screen, title: screen.name, tip: version.acceptance.find(rule => rule.screenId === screen.id)?.rule }));
  const declared = version.demo?.flatMap(row => {
    const screen = version.screens.find(screen => screen.id === row.screen);
    return screen ? [{ screen, title: row.title || screen.name, tip: row.tip }] : [];
  }) ?? [];
  const listed = declared.length && !all && (!screenId || declared.some(step => step.screen.id === screenId)) ? declared : every;
  const phone = isDesignPhoneViewport();
  const phones = phone ? listed.filter(step => step.screen.viewport === 'phone') : [];
  const desktop = phone ? listed.filter(step => step.screen.viewport !== 'phone') : listed;
  const steps = [...phones, ...desktop];
  const groups = [
    ...(phones.length ? [{ name: '手机画面', steps: phones }] : []),
    ...demoGroups.map(name => ({ name, steps: desktop.filter(step => demoGroup(step.screen.route) === name) })),
  ].filter(group => group.steps.length);
  const index = steps.findIndex(step => step.screen.id === screenId);
  const current = steps[Math.max(index, 0)], next = steps[Math.max(index, 0) + 1];
  const thumb = (screen: DesignVersion['screens'][number]) => {
    const color = screen.themes.includes(theme) ? theme : screen.themes[0];
    const captured = entry.runs.slice().reverse().find(run => run.version === version.version)
      ?.visual?.[designVisualKey(screen.id, `${screen.viewport}-${color}`)]?.referenceImageId;
    return renders?.[screen.id]?.[color]?.id ?? captured;
  };
  return <section className="dw-sp-sec" data-sec="flow">
      <h3>演示流程<small>{steps.length ? `${Math.max(index, 0) + 1} / ${steps.length}` : ''}</small></h3>
      {running && status && <p className="dw-muted" role="status">缩略图生成中 {status.completed}/{status.total}</p>}
      {/* V26（用户：这一块要稳定，不要按钮一上一下）：说明固定两行高（多的省略，悬停看全文），
        * 按钮一行不换行，「下一步」的画面名太长就省略；「从头开始」一直在，第一步时不可点 */}
      {current && <div className="dw-sp-tip">
        <p title={`${current.title}${current.tip ? ` · ${current.tip}` : ''}`}><strong>{current.title}</strong>{current.tip ? ` · ${current.tip}` : ''}</p>
        <div className="dw-sp-acts">
          {next ? <button type="button" className="ep-button ep-button--primary" data-action="demo-next" onClick={() => onScreen(next.screen.id)} title={`下一步：${next.title}`}>
            <span className="dw-sp-next-t">下一步：{next.title}</span><ArrowRight /></button>
            : <span className="dw-sp-done"><Check />走完了，也可以直接在画面里点</span>}
          <button type="button" className="ep-button" data-action="demo-restart" disabled={index <= 0} onClick={() => onScreen(steps[0].screen.id)}><RotateCcw />从头开始</button>
        </div>
      </div>}
      {!steps.length && <p className="dw-ds-empty">这一版没有画面清单，只能整页查看原型。</p>}
      {groups.map(({ name, steps: visible }) => <div className="dw-sp-group" key={name}>
          <h4>{name}<small>{visible.length}</small></h4>
          <ol className="dw-sp-thumbs">{visible.map(step => {
            const image = thumb(step.screen);
            return <li key={step.screen.id}><button type="button" data-screen={step.screen.id} aria-current={step.screen.id === screenId ? 'step' : undefined}
              onClick={() => onScreen(step.screen.id)} title={step.title}>
              <span className="dw-sp-thumb"><DesignThumbnail projectId={entry.projectId} artifactId={image} />
                <b aria-hidden>{steps.indexOf(step) + 1}</b></span>
              <span className="dw-sp-ttitle">{step.title}</span>
            </button></li>;
          })}</ol>
        </div>)}
      {declared.length > 0 && declared.length < every.length && <button type="button" className="ep-link dw-ds-more" data-action="demo-all"
        aria-expanded={all} onClick={() => setAll(value => !value)}>{all ? `只看演示流程（${declared.length} 步）` : `看全部 ${every.length} 个画面`}</button>}
    </section>;
}

function Points({ entry, version, screenId, open, onAccept }: {
  entry: DesignEntry; version: DesignVersion; screenId?: string; open: Open; onAccept: () => void;
}) {
  const { ordered, authorVersion } = rationaleOrder(entry, version);
  const why = ordered.filter(item => item.key === 'goal' || item.key === 'choices')
    .flatMap(item => item.parts.flatMap(part => points(part.body))).slice(0, 8);
  const screen = version.screens.find(row => row.id === screenId);
  const rules = version.acceptance.filter(rule => rule.screenId === screenId);
  const files = version.delivery?.files ?? [];
  const inputs = [files.find(file => file.kind === 'guide'),
    files.find(file => file.path.endsWith('/源码差异.diff')) ?? files.find(file => file.path.endsWith('.diff')),
    files.find(file => file.path.endsWith('交接清单.md'))].filter(file => file !== undefined);
  return <>
    <section className="dw-sp-sec dw-sp25-why" data-sec="why">
      <h3>这一版解决什么{authorVersion && authorVersion.version !== version.version && <small>沿用 V{authorVersion.version}</small>}</h3>
      {why.length ? <ul className="dw-sp-why">{why.map((text, i) => <li key={i}>{text}</li>)}</ul> : <p className="dw-ds-empty">这一版没有写目标和取舍。</p>}
      {authorVersion && <button type="button" className="ep-link dw-ds-more" data-action="side-notes" onClick={() => open('notes')}>完整思路：取舍、依据和待定</button>}
    </section>
    {screen && <section className="dw-sp-sec dw-sp25-screen" data-sec="screen">
      <h3>这一屏要做到<small>{screen.viewport === 'phone' ? '手机 375' : '桌面 1280'} · 浅色{screen.themes.includes('dark') ? '和深色' : ''}</small></h3>
      <p className="dw-sp25-name"><strong>{screen.name}</strong><code>{screen.route.replace(/^#/, '')}</code></p>
      {rules.length ? <ul>{rules.map(rule => <li key={rule.id} className="dw-ds-rule"><code>{rule.id}</code><span>{rule.rule}{rule.expected && <small>{rule.expected}</small>}</span></li>)}</ul>
        : <p className="dw-ds-empty">这一屏没有单独的验收项，按画面实现即可。</p>}
      <p className="dw-sp25-links">
        <button type="button" className="ep-link" data-action="side-accept" onClick={onAccept}>全部 {version.acceptance.length} 项验收</button>
        {inputs.map(file => <button key={file.id} type="button" className="ep-link" onClick={() => open('delivery', { part: 'files', file: file.id })}>
          {file.kind === 'guide' ? '交付说明' : /\.diff$/.test(file.path) ? '源码差异' : '交接清单'}</button>)}
      </p>
    </section>}
  </>;
}
