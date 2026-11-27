/* V25 起：反馈、评论、智能体回复、系统消息都是对话，一个组件两处共用（交付右栏「评论」、记录页右侧）。
 * V26（用户：每个智能体在上面说的话我都要看得见；其实只要回答一个问题——他们之间聊了什么、约定了什么、在哪一版约定的、
 * 谁和谁约定的、最后一句说的是什么、敲定了没有。原来的信息密度够了，只是点来点去不方便）：
 * - 一条对话一张卡，不点开就能读到这六件事：标题（聊了什么）、谁和谁、约定（哪一版、谁、什么时候、结论）或「还没敲定，等谁」、最后一句。
 * - 「看经过」在卡片里原地展开，不跳页：按版本分段（「V4 · 11月18日发布」，和记录页按版本交代同一个思路），
 *   每句话写清谁、几月几日几点；约定那一句单独标出；回复和「敲定」也在卡片里。
 * - 没敲定的在前，已敲定的在后；筛选四个：全部、这一屏、没敲定、已敲定。
 * - 从画面上发起的评论在这里写正文：点「在画面上评论」→ 点画面位置 → 这里出现输入框（不再在画布上弹浮层）。 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Bot, Check, ChevronDown, MapPin, MessageSquarePlus, Send, X } from 'lucide-react';
import type { DesignAuthor, DesignComment, DesignEntry, DesignFeedbackMessage, DesignFeedbackStage, DesignVersion } from '../../../../src/shared/design-workspace';
import {
  checkFeedbackLanguage, feedbackActionLabels, feedbackHandover, feedbackMessageLabels, feedbackMessageText,
} from '../../../../src/shared/design-feedback';
import type { DesignCommand } from './design-ui';
import { designPublisherLabel } from './design-ui';

type Feedback = NonNullable<DesignEntry['feedback']>[number];
export type DesignMessage = { at: string; who: string; role: ActorKind | 'system'; authorId?: string; body: string; tag?: string; agree?: boolean };
export type DesignThread = {
  key: string; kind: 'feedback' | 'comment'; id: string; title: string; screenId?: string; version: number;
  state: 'open' | 'responded' | 'closed'; updatedAt: string; messages: DesignMessage[]; comment?: DesignComment; feedback?: Feedback;
  author: string; authorId?: string;
};
export type CommentDraft = { screenName?: string; point?: { x: number; y: number }; placing: boolean };

const agentish = /智能体|claude|codex|agent|授权密钥/i;
/* V26 提议：发言人的身份来自数据（author.kind，服务端按凭据记录）；没有这个字段的旧数据才按名字猜。
 * 真实记录里一大半消息挂在一个管理员账号下，其实是实现智能体发的——按名字猜会猜错，所以要服务端记。 */
export type ActorKind = NonNullable<DesignAuthor['kind']>;
export const actorNames: Record<ActorKind, string> = { person: '人', 'design-agent': '设计智能体', 'impl-agent': '实现智能体', agent: '智能体' };
export function actorOf(author: { label: string; kind?: string }): ActorKind {
  if (author.kind === 'person' || author.kind === 'design-agent' || author.kind === 'impl-agent' || author.kind === 'agent') return author.kind;
  return agentish.test(author.label) ? 'agent' : 'person';
}
const saidBy = (author: DesignAuthor) => ({ who: designPublisherLabel(author.label), role: actorOf(author), authorId: author.id });
const zone = 'Asia/Shanghai';
const stamp = new Intl.DateTimeFormat('zh-CN', { timeZone: zone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const dateOnly = new Intl.DateTimeFormat('zh-CN', { timeZone: zone, month: 'long', day: 'numeric' });
const safe = (format: Intl.DateTimeFormat, at: string) => { try { return format.format(new Date(at)); } catch { return ''; } };
/* 「11/19 15:10」：每句话都带日期，跨天也看得出先后 */
const when = (at: string) => safe(stamp, at).replace(/\s+/, ' ');
const date = (at: string) => safe(dateOnly, at);
const plainLine = (text: string) => {
  const lines = text.split(/\n/).map(line => line.trim()).filter(Boolean);
  return (lines.find(line => !/^#+\s/.test(line)) ?? lines[0] ?? '').replace(/^#+\s*/, '').replace(/[*_`]/g, '');
};
/* 正文：「## 诉求」这类小标题显示成加粗小标题，不露出井号；其余按段落 */
function blocks(text: string) {
  return text.split(/\n\s*\n/).map(block => block.trim()).filter(Boolean).map((block, index) => /^#+\s/.test(block)
    ? <b key={index} className="dw-cv-h">{block.replace(/^#+\s*/, '')}</b>
    : <p key={index}>{block}</p>);
}
/* 状态词和反馈的交接状态同一套（V26：待接手、处理中、待确认、退回重做、完结），评论只用得到三个 */
export const threadStateNames = { open: '待接手', responded: '待确认', closed: '完结' } as const;

/* 这份稿件的全部对话，按最近一句排在前面 */
export function designThreads(entry: DesignEntry): DesignThread[] {
  const declared = (id: string) => entry.versions.filter(row => Object.hasOwn(row.resolves ?? {}, id))
    .map((row): DesignMessage => ({ at: row.createdAt, who: '系统', role: 'system', body: `V${row.version} 发布，声明处理了这一条：${row.resolves[id]}` }));
  const feedback = (entry.feedback ?? []).map((row): DesignThread => {
    const messages: DesignMessage[] = [
      { at: row.createdAt, ...saidBy(row.author), body: row.body || row.title, tag: '提出' },
      ...row.replies.map((reply): DesignMessage => ({ at: reply.at, ...saidBy(reply.author), body: feedbackMessageText(reply.body, reply.message),
        tag: reply.supplement ? '补写诉求' : reply.message ? feedbackMessageLabels[reply.message.kind] : reply.revision ? `关联 V${reply.revision}` : undefined })),
      ...(row.transitions ?? []).map((step): DesignMessage => ({ at: step.at, ...saidBy(step.author), body: step.body,
        tag: feedbackActionLabels[step.action], agree: step.action === 'confirm' })),
      ...row.decisions.map((decision): DesignMessage => decision.decision === 'close'
        ? { at: decision.at, ...saidBy(decision.author), agree: true, body: decision.body || '确认完结。' }
        : { at: decision.at, who: '系统', role: 'system', body: `${designPublisherLabel(decision.author.label)}重新打开了这条${decision.body ? '：' + decision.body : ''}` }),
      ...declared(row.id),
    ].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
    return { key: 'f:' + row.id, kind: 'feedback', id: row.id, title: row.title, screenId: row.screenId, version: row.version,
      state: row.status, updatedAt: messages.at(-1)!.at, messages, feedback: row, author: designPublisherLabel(row.author.label), authorId: row.author.id };
  });
  const comments = entry.comments.map((row): DesignThread => {
    const messages: DesignMessage[] = [
      { at: row.createdAt, ...saidBy(row.author), body: row.body, tag: '提出' },
      ...row.replies.map((reply): DesignMessage => ({ at: reply.createdAt, ...saidBy(reply.author),
        body: feedbackMessageText(reply.body, reply.message), ...(reply.message ? { tag: feedbackMessageLabels[reply.message.kind] } : {}) })),
      ...row.reviews.map((review): DesignMessage => review.decision === 'resolved'
        ? { at: review.at, ...saidBy(review.author ?? { id: review.by, label: review.by }), agree: true, body: review.body || `V${review.version} 核对过，确认完结。` }
        : { at: review.at, who: '系统', role: 'system', body: `${review.by}退回了处理（V${review.version}）${review.body ? '：' + review.body : ''}` }),
      ...declared(row.id),
    ].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
    return { key: 'c:' + row.id, kind: 'comment', id: row.id, title: plainLine(row.body), screenId: row.screenId, version: row.version,
      state: row.closed ? 'closed' : row.replies.length ? 'responded' : 'open', updatedAt: messages.at(-1)!.at, messages, comment: row,
      author: designPublisherLabel(row.author.label), authorId: row.author.id };
  });
  return [...feedback, ...comments].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/* 某个时刻在哪一版之后：最近一个已发布的版本 */
function versionAt(entry: DesignEntry, at: string, fallback: number) {
  return entry.versions.filter(row => row.createdAt <= at).reduce((max, row) => Math.max(max, row.version), 0) || fallback;
}
/* 一条对话的六件事 */
export function threadFacts(entry: DesignEntry, thread: DesignThread) {
  const said = thread.messages.filter(message => message.role !== 'system');
  const people = [...new Map(said.map(message => [message.authorId ?? message.who, message])).entries()]
    .map(([id, { who, role }]) => ({ id, who, role }));
  const agreed = thread.state === 'closed' ? said.filter(message => message.agree).at(-1) : undefined;
  const last = said.at(-1)!;
  const waitingOn = thread.state === 'open' ? '等对方回复' : `等 ${thread.author} 复核`;
  return { people, agreed, agreedIn: agreed ? versionAt(entry, agreed.at, thread.version) : undefined, last, count: said.length, waitingOn };
}

type Filter = 'all' | 'here' | 'open' | 'closed';

function Who({ who, role }: { who: string; role: DesignMessage['role'] }) {
  return <span className="dw-cv-who" data-role={role === 'person' || role === 'system' ? role : 'agent'}>
    {role !== 'person' && role !== 'system' && <Bot aria-hidden />}{who}{role !== 'system' && <em>{actorNames[role]}</em>}
  </span>;
}

export function DesignConversation({ entry, version, threads, selected, onSelect, screenId, command, busy, canReply, canAgree, onLocate, onPin,
  draft, onDraftCancel, onDraftSubmit, title = '评论' }: {
  entry: DesignEntry; version?: DesignVersion; threads: DesignThread[]; selected?: string; onSelect: (key?: string) => void; screenId?: string;
  command?: DesignCommand; busy?: boolean; canReply?: boolean; canAgree?: (thread: DesignThread) => boolean;
  onLocate?: (thread: DesignThread) => void; onPin?: () => void;
  draft?: CommentDraft; onDraftCancel?: () => void; onDraftSubmit?: (body: string) => Promise<boolean>; title?: string;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const screenName = (id?: string) => id ? version?.screens.find(row => row.id === id)?.name ?? entry.versions.flatMap(row => row.screens).find(row => row.id === id)?.name : undefined;
  const open = threads.filter(row => row.state !== 'closed'), closed = threads.filter(row => row.state === 'closed');
  const here = screenId ? threads.filter(row => row.screenId === screenId) : [];
  const filters: [Filter, string, number][] = [['all', '全部', threads.length], ...(screenId ? [['here', '这一屏', here.length] as [Filter, string, number]] : []),
    ['open', '进行中', open.length], ['closed', '完结', closed.length]];
  const shown = filter === 'here' ? here : filter === 'open' ? open : filter === 'closed' ? closed : threads;
  const groups = [{ name: '进行中', rows: shown.filter(row => row.state !== 'closed') }, { name: '完结', rows: shown.filter(row => row.state === 'closed') }]
    .filter(group => group.rows.length);
  return <section className="dw-cv" aria-label={title} data-filter={filter}>
    <header className="dw-cv-head">
      <h3>{title}<small>{open.length ? `${open.length} 条进行中` : threads.length ? '都完结了' : ''}</small></h3>
      {onPin && <button type="button" className="ep-button" data-action="comment-pin" aria-pressed={draft?.placing || undefined}
        onClick={draft?.placing ? onDraftCancel : onPin}>{draft?.placing ? <><X />取消放置</> : <><MessageSquarePlus />在画面上评论</>}</button>}
      <nav className="dw-cv-filters" aria-label="筛选">{filters.map(([key, label, n]) =>
        <button key={key} type="button" aria-pressed={filter === key} data-filter={key} onClick={() => setFilter(key)}>{label}<small>{n}</small></button>)}</nav>
    </header>
    {draft && (draft.placing || draft.point) && <DraftBox draft={draft} busy={busy} onCancel={onDraftCancel} onSubmit={onDraftSubmit} />}
    {!shown.length && <p className="dw-ds-empty">{filter === 'closed' ? '还没有敲定的对话。' : filter === 'here' ? '这一屏还没有对话。'
      : onPin ? '还没有对话。点「在画面上评论」，再点画面上要说的位置。' : '还没有对话。'}</p>}
    {groups.map(group => <div className="dw-cv-group" key={group.name}>
      {groups.length > 1 && <h4>{group.name}<small>{group.rows.length}</small></h4>}
      <ol className="dw-cv-cards">{group.rows.map(thread => <ThreadCard key={thread.key} entry={entry} thread={thread} screenName={screenName(thread.screenId)}
        expanded={thread.key === selected} onToggle={() => onSelect(thread.key === selected ? undefined : thread.key)}
        version={version} command={command} busy={busy} canReply={canReply} canAgree={canAgree?.(thread)} onLocate={onLocate} />)}</ol>
    </div>)}
  </section>;
}

function ThreadCard({ entry, thread, screenName, expanded, onToggle, version, command, busy, canReply, canAgree, onLocate }: {
  entry: DesignEntry; thread: DesignThread; screenName?: string; expanded: boolean; onToggle: () => void;
  version?: DesignVersion; command?: DesignCommand; busy?: boolean; canReply?: boolean; canAgree?: boolean; onLocate?: (thread: DesignThread) => void;
}) {
  const facts = threadFacts(entry, thread);
  const handover = thread.feedback ? handoverOf(thread.feedback) : undefined;
  const card = useRef<HTMLLIElement>(null);
  useEffect(() => { if (expanded) card.current?.scrollIntoView({ block: 'nearest' }); }, [expanded]);
  return <li ref={card} className="dw-cv-card" data-thread={thread.key} data-state={thread.state} data-expanded={expanded || undefined}>
    <p className="dw-cv-card-top">
      <span className="dw-cv-kind" data-kind={thread.kind}>{thread.kind === 'feedback' ? '反馈' : '评论'}</span>
      <strong>{thread.title}</strong>
      <span className="dw-cv-state" data-state={thread.state}>{thread.state === 'closed' && <Check aria-hidden />}{handover ? stageNames[handover.stage] : threadStateNames[thread.state]}</span>
    </p>
    <dl className="dw-cv-facts">
      {handover && <><dt>交接</dt><dd className="dw-cv-hand"><span>{designPublisherLabel(handover.raiser.label)} 提出</span><span aria-hidden>→</span>
        <span>{handover.handler ? designPublisherLabel(handover.handler.label) : '还没指定交接方'} 处理</span></dd></>}
      <dt>谁和谁</dt>
      <dd className="dw-cv-people">{facts.people.map((person, index) => <span key={person.id}>{index > 0 && <i className="dw-cv-sep" aria-hidden>·</i>}
        <Who who={person.who} role={person.role} /></span>)}</dd>
      <dt>约定</dt>
      {facts.agreed ? <dd className="dw-cv-agreed"><span className="dw-cv-when">V{facts.agreedIn} · {facts.agreed.who} · {when(facts.agreed.at)}</span>
        <span className="dw-cv-text">{plainLine(facts.agreed.body)}</span></dd>
        : <dd className="dw-cv-pending">{handover ? <>{stageNames[handover.stage]} · 球在 {handover.holder ? designPublisherLabel(handover.holder.label) : '—'}
          {handover.owed > 0 && ` · 欠 ${handover.owed} 句`}{handover.stall && <b className="dw-cv-stall" data-stall={handover.stall}>{handover.stall === 'bad' ? `停了 ${handover.stalledDays} 天，需要人介入` : `停了 ${handover.stalledDays} 天`}</b>}</>
          : `进行中 · ${facts.waitingOn}`}</dd>}
      {!facts.last.agree && <><dt>最后一句</dt>
        <dd><span className="dw-cv-when"><Who who={facts.last.who} role={facts.last.role} /> · {when(facts.last.at)}</span>
          <span className="dw-cv-text">{plainLine(facts.last.body)}</span></dd></>}
    </dl>
    <p className="dw-cv-card-foot">
      <span>V{thread.version} 提出{screenName ? ` · ${screenName}` : ''} · {facts.count} 句</span>
      {thread.screenId && onLocate && <button type="button" className="ep-link" data-action="thread-locate" onClick={() => onLocate(thread)}><MapPin />看画面</button>}
      <button type="button" className="ep-link dw-cv-toggle" data-action="thread-toggle" aria-expanded={expanded} onClick={onToggle}>
        {expanded ? '收起经过' : '看经过'}<ChevronDown aria-hidden /></button>
    </p>
    {expanded && <Story entry={entry} thread={thread} version={version} command={command} busy={busy} canReply={canReply} canAgree={canAgree} />}
  </li>;
}

/* 经过：按版本分段，每句话谁、几点、说了什么；约定那一句单独标出 */
function Story({ entry, thread, version, command, busy, canReply, canAgree }: {
  entry: DesignEntry; thread: DesignThread; version?: DesignVersion; command?: DesignCommand; busy?: boolean; canReply?: boolean; canAgree?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [agreeing, setAgreeing] = useState(false);
  const sections: { version: number; rows: DesignMessage[] }[] = [];
  for (const message of thread.messages) {
    const v = versionAt(entry, message.at, thread.version);
    if (sections.at(-1)?.version !== v) sections.push({ version: v, rows: [] });
    sections.at(-1)!.rows.push(message);
  }
  async function confirm(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || !command) return;
    const checked = entry.versions.slice().reverse().find(row => Object.hasOwn(row.resolves, thread.id))?.version ?? version?.version ?? thread.version;
    const ok = thread.kind === 'feedback'
      ? await command('feedback.resolve', { designId: entry.id, feedbackId: thread.id, body, decision: 'close' })
      : await command('comment.review', { designId: entry.id, version: checked, commentId: thread.id, body, decision: 'resolved' });
    if (ok) { setDraft(''); setAgreeing(false); }
  }
  return <div className="dw-cv-story">
    {sections.map(section => {
      const released = entry.versions.find(row => row.version === section.version);
      return <section key={section.version} className="dw-cv-ver">
        <h5>V{section.version}{released && <small>{date(released.createdAt)}发布 · {designPublisherLabel(released.publisher.label)}</small>}</h5>
        <ol>{section.rows.map((message, index) => message.role === 'system'
          ? <li key={index} className="dw-cv-sys"><time>{when(message.at)}</time><span>{message.body}</span></li>
          : <li key={index} className="dw-cv-msg" data-role={message.role} data-agree={message.agree || undefined}>
            <p className="dw-cv-msg-head">{message.agree && <b className="dw-cv-agree-tag"><Check aria-hidden />约定</b>}
              <Who who={message.who} role={message.role} />{message.tag && <small>{message.tag}</small>}<time>{when(message.at)}</time></p>
            <div className="dw-cv-msg-body">{blocks(message.body)}</div>
          </li>)}</ol>
      </section>;
    })}
    {canReply && command && thread.state !== 'closed' ? agreeing ? <form className="dw-cv-reply" data-mode="agree" onSubmit={event => void confirm(event)}>
      <label>约定的结论<textarea value={draft} onChange={event => setDraft(event.target.value)} rows={2} maxLength={40} required /></label>
      <span className="dw-cv-reply-acts">
        <button type="button" className="ep-button" onClick={() => setAgreeing(false)}>取消</button>
        <button type="submit" className="ep-button ep-button--primary" disabled={busy || checkFeedbackLanguage(draft, '').problems.length > 0}><Check />确认约定</button>
      </span>
    </form> : <DesignMessageForm busy={busy} onConfirm={canAgree ? () => setAgreeing(true) : undefined}
      onSend={(body, message) => thread.kind === 'feedback'
        ? command('feedback.reply', { designId: entry.id, feedbackId: thread.id, body, message })
        : command('comment.reply', { designId: entry.id, commentId: thread.id, body, message })} />
      : thread.state === 'closed' && <p className="dw-cv-closed">完结</p>}
  </div>;
}

function DraftBox({ draft, busy, onCancel, onSubmit }: { draft: CommentDraft; busy?: boolean; onCancel?: () => void; onSubmit?: (body: string) => Promise<boolean> }) {
  const [body, setBody] = useState('');
  if (draft.placing) return <div className="dw-cv-draft" data-state="placing" role="status"><MapPin aria-hidden />
    <span>点画面上要说的位置{draft.screenName ? `（${draft.screenName}）` : ''}。</span></div>;
  return <form className="dw-cv-draft" data-state="writing" onSubmit={async event => {
    event.preventDefault();
    if (body.trim() && onSubmit && await onSubmit(body.trim())) setBody('');
  }}>
    <p><MapPin aria-hidden />新评论 · {draft.screenName ?? '这一屏'}<small>位置已标在画面上</small></p>
    <textarea value={body} onChange={event => setBody(event.target.value)} rows={3} maxLength={4000} placeholder="想说什么" aria-label="评论内容" autoFocus />
    <span className="dw-cv-draft-acts"><button type="button" className="ep-button" onClick={onCancel}>取消</button>
      <button type="submit" className="ep-button ep-button--primary" data-action="comment-save" disabled={busy || !body.trim()}><Send />发表</button></span>
  </form>;
}

export type Stage = DesignFeedbackStage;
export const stageNames: Record<Stage, string> = { raised: '待接手', working: '处理中', review: '待确认', returned: '退回重做', done: '完结' };
export const stageGlyph: Record<Stage, 'none' | 'warn' | 'ok' | 'bad'> = { raised: 'none', working: 'warn', review: 'warn', returned: 'bad', done: 'ok' };
export type Handover = ReturnType<typeof feedbackHandover>;
export const handoverOf = feedbackHandover;
export const plainCheck = checkFeedbackLanguage;

type ReplyKind = Exclude<DesignFeedbackMessage['kind'], 'confirm'>;
const replyKinds: ReplyKind[] = ['answer', 'propose', 'evidence'];
const replyHints: Record<ReplyKind, string> = {
  answer: '按验收项说明做法和完成时间。',
  propose: '说明约定的结论和范围。',
  evidence: '引用可在 CDS 回看的验收运行。',
};

export function DesignMessageForm({ busy, revisions = [], onSend, onConfirm }: {
  busy?: boolean; revisions?: DesignVersion[];
  onSend: (body: string, message: DesignFeedbackMessage, revision?: number) => Promise<boolean>;
  onConfirm?: () => void;
}) {
  const [kind, setKind] = useState<ReplyKind>('answer');
  const [lead, setLead] = useState('');
  const [body, setBody] = useState('');
  const [items, setItems] = useState('');
  const [conclusion, setConclusion] = useState('');
  const [scope, setScope] = useState('');
  const [runId, setRunId] = useState('');
  const [commit, setCommit] = useState('');
  const note = lead.trim();
  const ids = items.trim().split(/\s*[、,，]\s*/).filter(Boolean);
  const issue = checkFeedbackLanguage(note, kind === 'propose' ? [body, conclusion, scope].join('\n') : body).problems[0];
  const missing = kind === 'answer' && (!body.trim() || !ids.length || ids.some(id => !/^A-\d+$/.test(id)))
    ? '填写验收项编号和答复正文。'
    : kind === 'propose' && (!conclusion.trim() || !scope.trim()) ? '填写约定结论和范围。'
      : kind === 'evidence' && (!/^RUN-[\w-]+$/.test(runId.trim()) || !/^[0-9a-f]{7,40}$/i.test(commit.trim()))
        ? '填写验收运行编号和提交。' : undefined;
  const error = issue ?? missing;

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (error || busy) return;
    const form = event.currentTarget;
    const revision = Number(new FormData(form).get('revision'));
    const message: DesignFeedbackMessage = kind === 'answer' ? { kind, lead: note, items: ids }
      : kind === 'propose' ? { kind, lead: note, conclusion: conclusion.trim(), scope: scope.trim() }
        : { kind, lead: note, runId: runId.trim(), commit: commit.trim() };
    if (await onSend(body.trim() || note, message, revision || undefined)) {
      form.reset();
      setLead(''); setBody(''); setItems(''); setConclusion(''); setScope(''); setRunId(''); setCommit('');
    }
  }

  return <form className="dw-delivery-form dw-fl-compose" data-kind={kind} onSubmit={event => void send(event)}>
    <div className="dw-fl-kinds" role="radiogroup" aria-label="回复类型">
      {replyKinds.map(key => <button key={key} type="button" role="radio" aria-checked={kind === key} data-kind={key}
        onClick={() => setKind(key)}>{feedbackMessageLabels[key]}</button>)}
      {onConfirm && <button type="button" role="radio" aria-checked={false} data-kind="confirm" data-action="feedback-resolve"
        onClick={onConfirm}>确认约定</button>}
    </div>
    <p className="dw-fl-hint">{replyHints[kind]}</p>
    <label><span className="dw-fl-lab">一句话（给人看的）<small>40 字以内</small></span>
      <input value={lead} onChange={event => setLead(event.target.value)} required maxLength={80} /></label>
    {kind === 'answer' && <label>涉及的验收项<input name="items" value={items} onChange={event => setItems(event.target.value)}
      required placeholder="A-03、A-12" /></label>}
    {kind === 'propose' && <>
      <label>结论<input value={conclusion} onChange={event => setConclusion(event.target.value)} required maxLength={300} /></label>
      <label>范围<input value={scope} onChange={event => setScope(event.target.value)} required maxLength={300} /></label>
    </>}
    {kind === 'evidence' && <div className="dw-fl-fields">
      <label>运行编号<input value={runId} onChange={event => setRunId(event.target.value)} required placeholder="RUN-26" /></label>
      <label>提交<input value={commit} onChange={event => setCommit(event.target.value)} required maxLength={40} /></label>
    </div>}
    <label><span className="dw-fl-lab">{kind === 'answer' ? '正文' : '补充说明'}<small>{body.length} / 1500</small></span>
      <textarea value={body} onChange={event => setBody(event.target.value)} rows={3} required={kind === 'answer'} maxLength={1500} />
    </label>
    <div className="dw-dl-compose-row">
      {revisions.length > 0 && <label>关联本稿版本<select name="revision" defaultValue="">
        <option value="">不关联</option>{revisions.map(row => <option key={row.version} value={row.version}>V{row.version}</option>)}
      </select></label>}
      <span className="dw-dl-compose-actions">
        {error && <span className="dw-fl-plain" role="status">{error}</span>}
        <button className="ep-button ep-button--primary" type="submit" disabled={busy || Boolean(error)}>发送{feedbackMessageLabels[kind]}</button>
      </span>
    </div>
  </form>;
}
