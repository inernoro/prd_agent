/* V26 记录页（从零重新设计，替换原来的「按版本因果 / 时间线」和右侧对话）。
 * 用户：这个页面要回答每个版本大家讨论了什么、敲定了什么范围、提了什么问题；不要加工，原始信息放上来，加工只是多一些标签，像对稿一样。
 * 选了「三栏对稿」版式，调性用监控中心：一版一块面板，面板里三栏「提的问题 · 讨论 · 敲定」，全部是原话；
 * 右边一栏「还没敲定」像监控的「需要处理」；顶部按话题现在的状态筛（○ 待回复 · ◐ 待复核 · ● 已敲定），不符合的变淡，不隐藏。
 * 状态符号形状 + 颜色两层表达，和监控中心同一套：● 好了、◐ 一半、○ 还没有。
 * 用户第二轮：最新的评论在哪看？按版本切换即可，不用一页摊开所有版本；真实记录很长，要保证显示良好。
 *   - 一次只看一个版本：上面一条版本条（每版有几句、几条敲定，没对话的版本变灰，◀ ▶ 跳过空版本）；
 *   - 右栏两页：「最新」——整份稿件最新的话，新的在上，上次来过之后的标一个点，点了切到那一版并标出；「还没敲定」；
 *   - 长内容：Markdown 照常排版（列表、表格横向滚动、长链接换行），超过 6 行收起，写明「展开全文（共 N 字）」；
 *     讨论里每个话题只列这一版说的话，之前的收成「此前 N 句（V2–V3）」，可以原地展开。
 * 不提新字段：只读 versions（note、resolves、publisher）、feedback、comments、runs；身份读 author.kind（V26 提议），没有时按名字猜。
 * 「上次来过」需要服务端按人记一个阅读位置（提议），原型里固定在 11 月 21 日。
 * 用户第三轮：反馈和资料搬到记录（记录页两个视图：按版本 · 反馈和资料）；每块都有「打开」进到真正的反馈；
 *   提的问题有提出方和交接方、有状态变更，不能停在「还没敲定」：状态用交接状态（待接手 → 处理中 → 待确认 → 完结，可退回），
 *   右栏「进行中」按球在谁手里分组，标欠几句、停了几天；完结的不在进行中面板，只留截图为证（「完结」一栏显示截图）。 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Bot, ChevronLeft, ChevronRight, ExternalLink, MessageSquareReply, Search } from 'lucide-react';
import type { DesignEntry, DesignVersion } from '../../../../src/shared/design-workspace';
import { feedbackActionLabels, feedbackMessageText } from '../../../../src/shared/design-feedback';
import { designArtifact, designPublisherLabel } from './design-ui';
import { ReadableNotes } from './DesignMarkdown';
import { actorNames, actorOf, handoverOf, stageGlyph, stageNames, type Handover, type Stage } from './DesignConversation';

type State = Stage;
type Act = '提问' | '回复' | '补写诉求' | '接手' | '交付，请确认' | '完结' | '重开' | '退回' | '声明处理';
type Proof = { id: string; title: string };
type Topic = { key: string; id: string; kind: '反馈' | '评论'; cat?: string; title: string; screen?: string; state: State; raisedIn: number; author: string;
  authorId: string; hand?: Handover; proof: Proof[] };
type Who = { label: string; kind?: string };
type Said = { topic: Topic; act: Act; who: string; author: Who; at: string; body: string; extra?: string; v: number };

const catNames: Record<string, string> = { reuse: '复用建议', implementation: '实施做法', gap: '需求缺漏', constraint: '落地约束', acceptance: '验收建议' };
const stateNames = stageNames;
const glyph = stageGlyph;
const stamp = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const when = (at: string) => { try { return stamp.format(new Date(at)).replace(/\s+/, ' '); } catch { return ''; } };
const verdicts: Record<string, string> = { passed: '通过', failed: '不通过', pending: '进行中' };

/* 原始数据 → 话题和一句一句的话；只加标签，原文不动 */
function collect(entry: DesignEntry) {
  const versions = entry.versions.slice().sort((a, b) => a.version - b.version);
  const versionAt = (at: string, fallback: number) => versions.filter(row => row.createdAt <= at).reduce((max, row) => Math.max(max, row.version), 0) || fallback;
  const screenName = (id?: string) => id ? versions.flatMap(row => row.screens).find(row => row.id === id)?.name : undefined;
  const topics: Topic[] = [], said: Omit<Said, 'v'>[] = [];
  for (const row of entry.feedback ?? []) {
    const hand = handoverOf(row);
    const program = (row.transitions ?? []).flatMap(({ proof }) => proof ? [{ id: proof.imageId, title: '程序截图' }] : []);
    const historic = row.stage ? [] : row.attachments ?? [];
    const topic: Topic = { key: 'f:' + row.id, id: row.id, kind: '反馈', cat: catNames[row.category], title: row.title, screen: screenName(row.screenId), state: hand.stage,
      raisedIn: row.version, author: designPublisherLabel(row.author.label), authorId: row.author.id, hand,
      proof: [...new Map([...historic, ...program].map(({ id, title }) => [id, { id, title }])).values()] };
    topics.push(topic);
    said.push({ topic, act: '提问', who: topic.author, author: row.author, at: row.createdAt, body: row.body || row.title });
    for (const reply of row.replies) said.push({ topic, act: reply.supplement ? '补写诉求' : '回复', who: designPublisherLabel(reply.author.label), author: reply.author, at: reply.at, body: feedbackMessageText(reply.body, reply.message),
      extra: reply.revision ? `关联 V${reply.revision}` : undefined });
    for (const step of row.transitions ?? []) said.push({ topic, act: feedbackActionLabels[step.action],
      who: designPublisherLabel(step.author.label), author: step.author, at: step.at, body: step.body });
    for (const decision of row.decisions) said.push({ topic, act: decision.decision === 'close' ? '完结' : '重开', who: designPublisherLabel(decision.author.label), author: decision.author, at: decision.at,
      body: decision.body || (decision.decision === 'close' ? '（确认关闭，没有写结论）' : '（重新打开，没有写原因）') });
  }
  for (const row of entry.comments) {
    const title = row.body.split(/\n/)[0].trim();
    const topic: Topic = { key: 'c:' + row.id, id: row.id, kind: '评论', title, screen: screenName(row.screenId),
      state: row.closed ? 'done' : row.replies.length ? 'review' : 'raised', raisedIn: row.version, author: designPublisherLabel(row.author.label), authorId: row.author.id, proof: [] };
    topics.push(topic);
    said.push({ topic, act: '提问', who: topic.author, author: row.author, at: row.createdAt, body: row.body });
    for (const reply of row.replies) said.push({ topic, act: '回复', who: designPublisherLabel(reply.author.label), author: reply.author, at: reply.createdAt, body: feedbackMessageText(reply.body, reply.message) });
    for (const review of row.reviews) said.push({ topic, act: review.decision === 'resolved' ? '完结' : '退回',
      who: designPublisherLabel(review.author?.label ?? review.by), author: review.author ?? { label: review.by }, at: review.at, body: review.body || '（没有写结论）',
      extra: `核对 V${review.version}` });
  }
  for (const row of versions) for (const [id, text] of Object.entries(row.resolves ?? {})) {
    const topic = topics.find(item => item.id === id);
    if (topic) said.push({ topic, act: '声明处理', who: designPublisherLabel(row.publisher.label), author: row.publisher, at: row.createdAt, body: text, extra: `V${row.version} 发布时写的` });
  }
  const all: Said[] = said.map(item => {
    const at = item.at || versions.find(version => version.version === item.topic.raisedIn)?.createdAt || '';
    return { ...item, at, v: versionAt(at, item.topic.raisedIn) };
  }).sort((a, b) => a.at.localeCompare(b.at));
  return { versions, topics, said: all };
}

/* 原文：「## 小标题」显示成小标题，其余逐段照抄 */
/* 原文照常按 Markdown 排版（列表、表格、代码、链接）；超过 6 行收起，写明全文多少字 */
function Raw({ text }: { text: string }) {
  const long = text.length > 180 || text.split('\n').length > 6;
  const [open, setOpen] = useState(false);
  return <div className="dr-rawbox">
    <div className="dr-raw" data-clamp={long && !open ? true : undefined}><ReadableNotes source={text} /></div>
    {long && <button type="button" className="dr-more" onClick={() => setOpen(value => !value)}>{open ? '收起' : `展开全文（共 ${text.length.toLocaleString('zh-CN')} 字）`}</button>}
  </div>;
}
function Who({ name, author }: { name: string; author?: Who }) {
  const kind = actorOf(author ?? { label: name });
  return <span className="dr-who" data-agent={kind !== 'person' || undefined}>{kind !== 'person' && <Bot aria-hidden />}{name}<em>{actorNames[kind]}</em></span>;
}
const ago = (at: string) => {
  const minutes = Math.max(0, (Date.now() - Date.parse(at)) / 60000);
  return minutes < 60 ? `${Math.round(minutes)} 分钟前` : minutes < 60 * 24 ? `${Math.round(minutes / 60)} 小时前` : `${Math.round(minutes / 60 / 24)} 天前`;
};
const Gl = ({ state, large }: { state: State; large?: boolean }) => <i className={`dr-gl ${glyph[state]}${large ? ' lg' : ''}`} aria-label={stateNames[state]} />;
function TopicTags({ topic }: { topic: Topic }) {
  return <span className="dr-tags"><span>{topic.kind}{topic.cat ? ` · ${topic.cat}` : ''}</span>{topic.screen && <span>{topic.screen}</span>}
    <span className="dr-now" data-state={topic.state}>现在 {stateNames[topic.state]}</span></span>;
}

export function DesignRecord({ entry, version: viewing, readAt, thread, onThread, onReply, onPick, onOpen, lead }: {
  entry: DesignEntry; version: DesignVersion; readAt?: string; thread?: string; onThread: (key?: string) => void;
  onReply: (key: string) => void; onPick: (version: number, thread?: string) => void; onOpen: (key: string) => void; lead?: ReactNode;
}) {
  const { versions, topics, said } = useMemo(() => collect(entry), [entry]);
  const [lastSeen] = useState(() => readAt ? Date.parse(readAt) : -Infinity);
  const [query, setQuery] = useState('');
  const [only, setOnly] = useState<State>();
  const [railTab, setRailTab] = useState<'latest' | 'waiting'>('latest');
  const [context, setContext] = useState<Record<string, boolean>>({});
  const main = useRef<HTMLDivElement>(null);
  const text = query.trim().toLowerCase();
  const matches = (item: Said) => (!only || item.topic.state === only)
    && (!text || [item.body, item.who, item.topic.title, item.topic.screen ?? ''].some(value => value.toLowerCase().includes(text)));
  const dim = (item: Said) => (Boolean(only) || Boolean(text)) && !matches(item);
  const stages: State[] = ['raised', 'working', 'review', 'returned', 'done'];
  const counts = Object.fromEntries(stages.map(stage => [stage, topics.filter(t => t.state === stage).length])) as Record<State, number>;
  const waiting = topics.filter(t => t.state !== 'done').map(t => ({ topic: t, last: said.filter(s => s.topic === t).at(-1)! }))
    .sort((a, b) => (b.topic.hand?.stalledDays ?? 0) - (a.topic.hand?.stalledDays ?? 0) || b.last.at.localeCompare(a.last.at));
  const holderId = (topic: Topic) => topic.hand ? topic.hand.holder?.id ?? '' : topic.authorId;
  const holders = [...new Map(waiting.map(({ topic }) =>
    [holderId(topic), topic.hand ? topic.hand.holder && designPublisherLabel(topic.hand.holder.label) : topic.author])).entries()];
  const latest = said.slice().reverse().slice(0, 30);
  const unread = said.filter(item => Date.parse(item.at) > lastSeen).length;
  const perVersion = new Map(versions.map(row => [row.version, said.filter(item => item.v === row.version)]));
  const nonEmpty = versions.filter(row => perVersion.get(row.version)!.length).map(row => row.version);
  const row = versions.find(item => item.version === viewing.version) ?? versions.at(-1)!;
  const step = (direction: 1 | -1) => {
    const list = direction === 1 ? nonEmpty.filter(v => v > row.version) : nonEmpty.filter(v => v < row.version).reverse();
    if (list.length) onPick(list[0]);
  };
  /* 带着 thread 打开：把这条对话在这一版的每一块标出来，滚到第一块 */
  useEffect(() => {
    if (!thread) return;
    main.current?.querySelector<HTMLElement>(`[data-topic="${CSS.escape(thread)}"]`)?.scrollIntoView({ block: 'center' });
  }, [thread, row.version]);
  const tile = (item: Said, index: number) => <article key={index} className="dr-it" data-act={item.act} data-topic={item.topic.key}
    data-dim={dim(item) || undefined} data-loc={thread === item.topic.key || undefined} data-hit={Boolean(text) && matches(item) || undefined}>
    <header><Gl state={item.topic.state} /><button type="button" className="dr-topic" onClick={() => onThread(thread === item.topic.key ? undefined : item.topic.key)}
      title="标出这条对话在这一版的每一块">{item.topic.title}</button></header>
    <p className="dr-line"><span className="dr-act" data-act={item.act}>{item.act}</span><Who name={item.who} author={item.author} /><time className="dr-mono font-mono">{when(item.at)}</time>
      {item.extra && <span className="dr-extra">{item.extra}</span>}</p>
    {!(item.act === '提问' && item.body.trim() === item.topic.title) && <Raw text={item.body} />}
    {item.act === '完结' && (item.topic.proof.length ? <span className="dr-proof">{item.topic.proof.slice(0, 4).map(shot =>
      <img key={shot.id} loading="lazy" src={designArtifact(entry.projectId, shot.id)} alt={shot.title} title={shot.title} />)}</span>
      : item.topic.kind === '反馈' && <span className="dr-extra">没有截图（旧数据；新规则下完结必须附截图）</span>)}
    <div className="dr-foot"><TopicTags topic={item.topic} />
      <button type="button" className="dr-open" data-action="record-open" onClick={() => onOpen(item.topic.key)}>{item.topic.kind === '反馈' ? '打开' : '看画面'}<ExternalLink aria-hidden /></button></div>
  </article>;

  const here = perVersion.get(row.version)!;
  const asked = here.filter(item => item.act === '提问');
  const agreed = here.filter(item => item.act === '完结');
  const talk = here.filter(item => item.act !== '提问' && item.act !== '完结');
  const groups = [...new Set(talk.map(item => item.topic))];
  const runs = entry.runs.filter(run => run.version === row.version);
  const range = (items: Said[]) => { const a = items[0]?.v, b = items.at(-1)?.v; return a === b ? `V${a}` : `V${a}–V${b}`; };

  return <div className="dr">
    {/* V26 第四轮（用户：顶部有点乱，精致一些）：四行收成两行——
      * 第一行：左边「按版本 | 反馈和资料」，右边搜索和状态筛选（一个胶囊里的分段），不再放「几个版本 · 几条对话」的汇总；
      * 第二行是版本面板的页头：版本切换（◀ V4 V3 V2 V1 ▶ 紧挨着）+ 谁、什么时候发布；数量只在三栏的栏头写一次。 */}
    <div className="dr-top">
      {lead}
      <div className="dr-tools">
        <label className="dr-search"><Search aria-hidden /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜原话、话题、人" aria-label="搜索记录" /></label>
        <div className="dr-tokens" role="group" aria-label="按话题现在的状态筛">
          {stages.filter(state => counts[state] > 0).map(state => <button key={state} type="button" className="dr-tok" data-state={state} aria-pressed={only === state}
            title={`只看${stateNames[state]}的话题`} onClick={() => setOnly(value => value === state ? undefined : state)}>
            <Gl state={state} /><b className="dr-mono font-mono">{counts[state]}</b><span>{stateNames[state]}</span></button>)}
        </div>
      </div>
    </div>
    <div className="dr-body">
      <div className="dr-main" ref={main}>
        <section className="dr-card" id={`dr-v${row.version}`} aria-labelledby={`dr-v${row.version}-h`}>
          <header className="dr-card-h">
            <h3 className="sr-only" id={`dr-v${row.version}-h`}>V{row.version}</h3>
            {/* 版本切换：新的在左；每版写这一版期间说了几句，有完结的带绿点；没对话的变灰；◀ ▶ 只在有对话的版本之间跳 */}
            <nav className="dr-vbar" aria-label="切换版本">
              <button type="button" className="dr-vstep" aria-label="上一个有对话的版本（更新）" disabled={!nonEmpty.some(v => v > row.version)} onClick={() => step(1)}><ChevronLeft /></button>
              <ol>{versions.slice().reverse().map(item => {
                const list = perVersion.get(item.version)!;
                const ok = list.filter(s => s.act === '完结').length;
                return <li key={item.version}><button type="button" className="dr-vchip" aria-current={item.version === row.version || undefined} data-empty={!list.length || undefined}
                  title={list.length ? `V${item.version}：这一版期间 ${list.length} 句，完结 ${ok} 条` : `V${item.version}：这一版期间没有对话`} onClick={() => onPick(item.version)}>
                  <b className="dr-mono font-mono">V{item.version}</b><small className="dr-mono font-mono">{list.length || '–'}</small>{ok ? <i className="dr-gl ok" aria-label={`完结 ${ok}`} /> : null}</button></li>;
              })}</ol>
              <button type="button" className="dr-vstep" aria-label="下一个有对话的版本（更早）" disabled={!nonEmpty.some(v => v < row.version)} onClick={() => step(-1)}><ChevronRight /></button>
            </nav>
            <span className="dr-pub" title={`从 ${when(row.createdAt)} 到 ${versions.find(item => item.version > row.version) ? when(versions.find(item => item.version > row.version)!.createdAt) + ' 下一版发布' : '现在'}`}>
              <Who name={designPublisherLabel(row.publisher.label)} author={row.publisher} /><span>发布于</span><time className="dr-mono font-mono">{when(row.createdAt)}</time>
              {entry.frozen === row.version && <span className="dr-badge">实施基线</span>}{row.version === versions.at(-1)!.version && <span className="dr-badge" data-here>最新</span>}</span>
          </header>
          <blockquote className="dr-note"><Raw text={row.note || row.title} /></blockquote>
          {(Object.keys(row.resolves ?? {}).length > 0 || runs.length > 0) && <div className="dr-facts">
            {Object.entries(row.resolves ?? {}).map(([id, value]) => <span key={id} className="dr-fact"><span className="dr-act" data-act="声明处理">声明处理</span>
              <b>{topics.find(topic => topic.id === id)?.title ?? id}</b>{value}</span>)}
          {runs.map(run => <span key={run.id} className="dr-fact"><span className="dr-act" data-act={run.verdict === 'failed' ? '退回' : '完结'}>验收</span>
              <span className="dr-mono font-mono">{run.id}</span>{run.target === 'installed' ? '主用构建' : `PR #${run.pullRequest}`} · {verdicts[run.verdict] ?? run.verdict}</span>)}
          </div>}
          {!here.length ? <p className="dr-empty dr-empty--version">V{row.version} 期间没有人说话。用上面的 ◀ ▶ 跳到有对话的版本。</p> : <div className="dr-cols">
            <div className="dr-col" data-col="asked"><h4>提的问题<small className="dr-mono font-mono">{asked.length}</small></h4>
              {asked.length ? asked.map(tile) : <p className="dr-empty">这一版没有新提的问题</p>}</div>
            <div className="dr-col" data-col="talk"><h4>讨论<small className="dr-mono font-mono">{talk.length}</small></h4>
              {groups.length ? groups.map(topic => {
                const before = said.filter(item => item.topic === topic && item.v < row.version);
                const open = context[topic.key];
                return <article key={topic.key} className="dr-thread" data-topic={topic.key} data-loc={thread === topic.key || undefined}
                  data-dim={talk.filter(item => item.topic === topic).every(dim) || undefined}>
                  <header><Gl state={topic.state} /><button type="button" className="dr-topic" onClick={() => onThread(thread === topic.key ? undefined : topic.key)}>{topic.title}</button></header>
                  <div className="dr-foot"><TopicTags topic={topic} />
                    <button type="button" className="dr-open" data-action="record-open" onClick={() => onOpen(topic.key)}>{topic.kind === '反馈' ? '打开' : '看画面'}<ExternalLink aria-hidden /></button></div>
                  {before.length > 0 && <button type="button" className="dr-more dr-before" aria-expanded={open || false}
                    onClick={() => setContext(value => ({ ...value, [topic.key]: !open }))}>{open ? '收起之前的' : `此前 ${before.length} 句（${range(before)}）`}</button>}
                  <ol>{[...(open ? before : []), ...talk.filter(item => item.topic === topic)].map((item, index) => <li key={index} data-dim={dim(item) || undefined}
                    data-before={item.v < row.version || undefined}>
                    <p className="dr-line"><span className="dr-act" data-act={item.act}>{item.act}</span><Who name={item.who} author={item.author} /><time className="dr-mono font-mono">{when(item.at)}</time>
                      {item.v < row.version && <span className="dr-extra">V{item.v}</span>}{item.extra && <span className="dr-extra">{item.extra}</span>}</p>
                    <Raw text={item.body} /></li>)}</ol>
                </article>;
              }) : <p className="dr-empty">这一版没有讨论</p>}</div>
            <div className="dr-col" data-col="agreed"><h4>完结<small className="dr-mono font-mono">{agreed.length}</small><span>只留截图为证</span></h4>
              {agreed.length ? agreed.map(tile) : <p className="dr-empty">这一版没有完结的</p>}</div>
          </div>}
        </section>
      </div>
      <aside className="dr-rail" aria-label="最新和进行中">
        <div className="dr-rail-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={railTab === 'latest'} onClick={() => setRailTab('latest')}>最新{unread ? <small className="dr-mono font-mono">{unread} 条新</small> : null}</button>
          <button type="button" role="tab" aria-selected={railTab === 'waiting'} onClick={() => setRailTab('waiting')}>进行中<small className="dr-mono font-mono">{waiting.length}</small></button>
        </div>
        {railTab === 'latest' ? <ol className="dr-feed">{latest.map((item, index) => <li key={index} className="dr-feed-it" data-new={Date.parse(item.at) > lastSeen || undefined}
          data-loc={thread === item.topic.key && item.v === row.version || undefined}>
          <button type="button" onClick={() => onPick(item.v, item.topic.key)}>
            <span className="dr-feed-top"><span className="dr-act" data-act={item.act}>{item.act}</span><Who name={item.who} author={item.author} />
              <span className="dr-feed-ago" title={when(item.at)}>{ago(item.at)}</span></span>
            <span className="dr-feed-t"><Gl state={item.topic.state} />{item.topic.title}<small className="dr-mono font-mono">V{item.v}</small></span>
            <span className="dr-feed-say">{item.body.split('\n').map(line => line.trim()).find(line => line && !/^#+\s/.test(line) && !/^\|/.test(line))?.replace(/[*_`]/g, '')}</span>
          </button></li>)}</ol>
        : <div className="dr-holders">{holders.map(([id, name]) => <section key={id}><h4 className="dr-hold">{name ? `球在 ${name}` : '交接方未指定'}</h4><ol>{waiting
          .filter(({ topic }) => holderId(topic) === id).map(({ topic, last }) =>
          <li key={topic.key} className="dr-ai" data-state={topic.state} data-loc={thread === topic.key || undefined}>
          <button type="button" className="dr-ai-main" onClick={() => onPick(last.v, topic.key)}>
            <span className="dr-ai-t"><Gl state={topic.state} />{topic.title}</span>
            <span className="dr-ai-why"><span className="dr-stage" data-stage={topic.state}>{stateNames[topic.state]}</span>
              {topic.hand ? `${designPublisherLabel(topic.hand.raiser.label)} → ${topic.hand.handler ? designPublisherLabel(topic.hand.handler.label) : '未指定'}` : `${topic.author} 提出`}
              {topic.hand && topic.hand.owed > 0 && ` · 欠 ${topic.hand.owed} 句`}
              {topic.hand?.stall && <span className="dr-stall" data-stall={topic.hand.stall}>{topic.hand.stall === 'bad' ? `停了 ${topic.hand.stalledDays} 天，需要人介入` : `停了 ${topic.hand.stalledDays} 天`}</span>}</span>
            <span className="dr-ai-last"><Who name={last.who} author={last.author} /><time className="dr-mono font-mono">{when(last.at)}</time><small className="dr-mono font-mono">V{last.v}</small></span>
            <span className="dr-ai-say">{last.body.split('\n').map(line => line.trim()).find(line => line && !/^#+\s/.test(line) && !/^\|/.test(line))?.replace(/[*_`]/g, '')}</span>
          </button>
          <span className="dr-ai-acts"><button type="button" className="ep-link dr-open" data-action="record-open" onClick={() => onOpen(topic.key)}><ExternalLink aria-hidden />打开</button>
            {topic.kind === '评论' && <button type="button" className="ep-link dr-ai-reply" onClick={() => onReply(topic.key)}><MessageSquareReply aria-hidden />去交付回复</button>}</span>
        </li>)}</ol></section>)}</div>}
        {railTab === 'waiting' && !waiting.length && <p className="dr-empty">都完结了。</p>}
      </aside>
    </div>
  </div>;
}
