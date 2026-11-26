import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { marked, type Tokens } from 'marked';
import { useLocation, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Download, FileCode, FileImage, FileText, MessageSquare, Plus } from 'lucide-react';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import {
  designFeedbackCategories, designSlots, type DesignFeedbackAttachment, type DesignSlot, type DesignDeliveryFile, type DesignEntry, type DesignFeedback, type DesignVersion, type DesignWorkspace,
} from '../../../../src/shared/design-workspace';
import { designHandoffStatusNames } from '../../../../src/shared/design-handoff';
import { feedbackSummary } from '../../../../src/shared/design-feedback';
import { usePlanningRead } from '../engineering-planning/planning-ui';
import { ReadableNotes } from './DesignMarkdown';
import { designArtifact, designDate, designFeedbackAwaitsViewer, designPath, designPublisherLabel, designSourceNames, slotNames, type DesignCommand } from './design-ui';

const fileNames: Record<DesignDeliveryFile['kind'], string> = {
  manifest: '稿件清单', guide: '交付说明', rationale: '设计思路', document: '设计与开发文档', framework: '框架材料',
  checks: '原型自检', prototype: '交互原型', render: '稿件截图', source: '原型源码', attachment: '其他附件',
};
const feedbackNames: Record<DesignFeedback['category'], string> = {
  reuse: '复用建议', implementation: '实施做法', gap: '需求缺漏', constraint: '落地约束', acceptance: '验收建议',
};
const feedbackStates: Record<DesignFeedback['status'], string> = { open: '待回复', responded: '待复核', closed: '已确认' };
type FileChunk = { artifactId: string; path: string; sha256: string; offset: number; nextOffset: number | null; text: string };
type OpenScreen = (version: number, screenId: string, from: string) => void;
type Permissions = DesignWorkspace['permissions'];
type Part = 'feedback' | 'files' | 'handoff';
type Go = (fields: Record<string, string>) => void;

const figuresOf = (row: DesignFeedback) => row.attachments ?? [];
const size = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`;
const isImage = (file: DesignDeliveryFile) => /\.png$/i.test(file.path);
const lastActivity = (row: DesignFeedback) => [row.createdAt, ...row.replies.map(reply => reply.at), ...row.decisions.map(item => item.at)].sort().at(-1)!;
/* 先看的文件排在前面；截图和源码数量多，默认收起 */
/* V5 第三轮（用户反馈：资料不够结构化）：分组按「为什么要看」排，编号、大标题、一句用途。
 * 先读 → 设计依据 → 对照证据 → 画面截图 → 可运行 → 源码；截图和源码数量多，默认收起 */
const groupOrder: { key: string; label: string; purpose: string; open: boolean; match: (file: DesignDeliveryFile) => boolean }[] = [
  { key: 'read', label: '先读', purpose: '怎么看这份稿、这一版改了什么', open: true, match: file => ['guide', 'rationale'].includes(file.kind) },
  { key: 'docs', label: '设计依据', purpose: '每个决定的理由、细节和验收对照', open: true, match: file => file.kind === 'document' && !isImage(file) },
  { key: 'images', label: '对照证据', purpose: '版本对照图和附件，直接在页面里看', open: false, match: file => (file.kind === 'document' || file.kind === 'attachment') && isImage(file) },
  { key: 'renders', label: '画面截图', purpose: '每个画面的浅色、深色截图', open: false, match: file => file.kind === 'render' },
  { key: 'proto', label: '可运行', purpose: '交互原型、自检结果和稿件清单', open: true, match: file => ['prototype', 'checks', 'manifest'].includes(file.kind) },
  { key: 'source', label: '源码', purpose: '原型源码；交给实现方的改动在「设计依据」的源码差异里', open: false, match: file => file.kind === 'source' },
  { key: 'other', label: '其他', purpose: '其他附件', open: false, match: () => true },
];
const groupOf = (file: DesignDeliveryFile) => groupOrder.find(group => group.key !== 'other' && group.match(file)) ?? groupOrder.at(-1)!;
function groupFiles(files: DesignDeliveryFile[]) {
  const taken = new Set<string>();
  return groupOrder.map(group => {
    const own = files.filter(file => !taken.has(file.id) && group.match(file));
    own.forEach(file => taken.add(file.id));
    return { ...group, files: own };
  }).filter(group => group.files.length);
}

/* ── 摘要条 ─────────────────────────── */
/* V5 第三轮（用户反馈：顶部很乱）：版本、基线已经在稿件页头，交付里不再重复。
 * 交付顶部只有两行：
 *   第一行：分区切换（反馈 / 资料 / 验收）｜发布人和日期、文件数｜下载原包；
 *   第二行：本版说明（一行，超出省略，「全文」展开）、来源提交、归档摘要，小字。 */
function DeliveryFacts({ entry, version }: { entry: DesignEntry; version: DesignVersion }) {
  const delivery = version.delivery;
  return <div className="dw-dl-facts-main">
    <span>{designPublisherLabel(version.publisher.label)} · {designDate(version.createdAt)}</span>
    {delivery && <span>{delivery.files.length} 个文件</span>}
    {delivery && <a className="ep-button ep-button--primary" href={designArtifact(entry.projectId, delivery.archiveId)} download><Download />下载原包</a>}
  </div>;
}
function DeliveryNote({ version }: { version: DesignVersion }) {
  const delivery = version.delivery;
  const [more, setMore] = useState(false);
  const extra = delivery?.notes && delivery.notes !== version.note ? delivery.notes : '';
  const note = version.note || delivery?.notes || '本版未附变更说明。';
  return <div className="dw-dl-noteline" data-more={more}>
    <p><span className="dw-dl-note" title={note}><b>本版</b>{note}</span>
      <button type="button" className="ep-link dw-dl-more" aria-expanded={more} onClick={() => setMore(!more)}>{more ? '收起' : '全文'}</button>
      <span className="dw-dl-src" title={designSourceNames[version.sourceVerification ?? 'declared']}>提交 <code>{version.sourceCommit.slice(0, 8)}</code></span>
      <span className="dw-dl-src">归档 <code>{version.sha256.slice(0, 12)}</code></span>
      {delivery?.prototypeVersion ? <span className="dw-dl-src">原型第 {delivery.prototypeVersion} 版</span> : null}</p>
    {more && <div className="dw-dl-fulltext"><ReadableNotes source={note} />{extra && <ReadableNotes source={extra} />}
      <p className="dw-dl-factline"><span>提交 <code>{version.sourceCommit}</code></span><span>归档 <code>{version.sha256}</code></span>
        {version.sourcePath && <span>目录 <code>{version.sourcePath}</code></span>}
        {delivery?.date && <span>稿件日期 {delivery.date}</span>}
        {delivery?.source && <span>重建源码 <code>{delivery.source}</code></span>}
        {delivery?.frameworkDraft && <span>框架草案 <code>{delivery.frameworkDraft}</code></span>}</p>
    </div>}
    {delivery?.warnings.length ? <ul className="dw-dl-warnings" role="status">{delivery.warnings.map(message => <li key={message}>{message}</li>)}</ul> : null}
  </div>;
}

/* ── 反馈 ─────────────────────────── */
function FeedbackList({ rows, selected, filter, setFilter, onSelect, onCreate, entry, permissions }: {
  rows: DesignFeedback[]; selected?: string; filter: 'pending' | 'all'; setFilter: (value: 'pending' | 'all') => void;
  onSelect: (id: string) => void; onCreate: () => void; entry: DesignEntry; permissions: Permissions;
}) {
  const pending = rows.filter(row => row.status !== 'closed');
  const shown = filter === 'pending' ? rows.filter(row => row.status !== 'closed' || row.id === selected) : rows;
  const screens = new Map(entry.versions.flatMap(version => version.screens.map(screen => [screen.id, screen.name] as const)));
  return <div className="dw-dl-list" aria-label="反馈列表">
    <div className="dw-dl-list-tools">
      <div className="dw-dl-seg" role="group" aria-label="筛选反馈">
        <button type="button" aria-pressed={filter === 'pending'} onClick={() => setFilter('pending')}>待处理 {pending.length}</button>
        <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部 {rows.length}</button>
      </div>
      {permissions.feedback && <button type="button" className="ep-button" data-action="feedback-new" onClick={onCreate}><Plus />登记反馈</button>}
    </div>
    <ul>
      {shown.map(row => {
        const mine = permissions.feedback && designFeedbackAwaitsViewer(entry, row, permissions.actorId);
        const figures = figuresOf(row).length;
        return <li key={row.id}>
          <button type="button" className="dw-dl-row" data-fb={row.id} aria-current={row.id === selected || undefined} onClick={() => onSelect(row.id)}>
            <span className="dw-dl-row-top"><span className={`dw-dl-state dw-dl-state--${row.status}`}>{feedbackStates[row.status]}</span>
              {mine && <span className="dw-dl-mine">等你</span>}<small>{designDate(lastActivity(row))}</small></span>
            <strong>{row.title}</strong>
            <small>{feedbackNames[row.category]} · V{row.version}{row.screenId && screens.get(row.screenId) ? ` · ${screens.get(row.screenId)}` : ''}
              {row.replies.length ? ` · ${row.replies.length} 条回复` : ''}{figures ? ` · ${figures} 张图` : ''}</small>
          </button>
        </li>;
      })}
      {!shown.length && <li className="dw-muted dw-dl-empty">{rows.length ? '没有待处理的反馈。' : '还没有实施反馈。'}</li>}
    </ul>
  </div>;
}

function FeedbackAttachmentForm({ entry, row, viewedVersion, submit, busy }: {
  entry: DesignEntry; row: DesignFeedback; viewedVersion: number; busy: boolean;
  submit: (fields: { title: string; image: string; version: number; screenId?: string; slot?: DesignSlot }) => Promise<boolean>;
}) {
  const [version, setVersion] = useState(viewedVersion);
  const [screenId, setScreenId] = useState(viewedVersion === row.version ? row.screenId : undefined);
  const screens = entry.versions.find(item => item.version === version)?.screens ?? [];
  const screen = screens.find(item => item.id === screenId);
  const slots = designSlots.filter(slot => screen?.themes.some(theme => slot === screen.viewport + '-' + theme));
  const [issue, setIssue] = useState('');
  const [reading, setReading] = useState(false);
  return <details className="dw-delivery-resolution"><summary>添加对照图</summary>
    <form className="dw-delivery-form" onSubmit={async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const inputs = new FormData(form);
      const file = inputs.get('image');
      if (!(file instanceof File) || file.type !== 'image/png' || file.size === 0 || file.size > 1.5 * 1024 * 1024) {
        setIssue('请选择 1.5 MiB 以内的 PNG 截图');
        return;
      }
      setReading(true);
      setIssue('');
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        const slot = slots.find(value => value === inputs.get('slot'));
        if (await submit({ title: String(inputs.get('title')), image: dataUrl, version, screenId, slot })) form.reset();
      } catch {
        setIssue('读取截图失败，请重新选择');
      } finally {
        setReading(false);
      }
    }}>
      <div className="dw-delivery-fields">
        <label>证据版本<select value={version} onChange={event => {
          const next = Number(event.target.value);
          setVersion(next);
          setScreenId(next === row.version ? row.screenId : undefined);
        }}>{[...entry.versions].reverse().map(item => <option key={item.version} value={item.version}>V{item.version}</option>)}</select></label>
        <label>证据画面<select value={screenId ?? ''} onChange={event => setScreenId(event.target.value || undefined)}>
          <option value="">{version === row.version && row.screenId ? '使用反馈画面' : '整版'}</option>
          {screens.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
        </select></label>
        {!!slots.length && <label>视口与主题<select name="slot" key={version + '/' + screenId}>
          <option value="">不指定</option>
          {slots.map(slot => <option value={slot} key={slot}>{slotNames[slot]}</option>)}
        </select></label>}
      </div>
      <label>图片说明<input name="title" required maxLength={180} /></label>
      <label>对照图<input name="image" type="file" accept="image/png" required /></label>
      {issue && <p role="alert">{issue}</p>}
      <button className="ep-button" type="submit" disabled={busy || reading}>保存私有对照图</button>
    </form>
  </details>;
}

function attachmentCaption(entry: DesignEntry, thread: DesignFeedback, shot: DesignFeedbackAttachment) {
  const revision = shot.version ?? thread.version;
  const screenId = shot.screenId ?? (revision === thread.version ? thread.screenId : undefined);
  const screen = entry.versions.find(item => item.version === revision)?.screens.find(item => item.id === screenId);
  return [shot.title, 'V' + revision, screen?.name, shot.slot && slotNames[shot.slot]].filter(Boolean).join(' · ');
}

function FeedbackDetail({ row, entry, version, permissions, busy, command, openScreen, openVersion, onBack }: {
  row: DesignFeedback; entry: DesignEntry; version: DesignVersion; permissions: Permissions; busy: boolean; command: DesignCommand;
  openScreen: OpenScreen; openVersion: (version: number) => void; onBack: () => void;
}) {
  const [earlier, setEarlier] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [supplementing, setSupplementing] = useState(false);
  const revisions = entry.versions.filter(item => item.version >= row.version && (permissions.steward || item.publisher.id === permissions.actorId));
  const canResolve = permissions.feedback && (permissions.steward || row.author.id === permissions.actorId);
  const canSupplement = canResolve || permissions.feedback && permissions.feedbackSupplement;
  const screens = new Map(entry.versions.flatMap(item => item.screens.map(screen => [screen.id, screen.name] as const)));
  const history = [
    ...row.replies.map(reply => ({ ...reply, label: reply.supplement ? '补写诉求和完成标准' : '回复' })),
    ...row.decisions.map(decision => ({ ...decision, revision: undefined, label: decision.decision === 'close' ? '确认关闭' : '重新打开' })),
  ].sort((first, second) => first.at.localeCompare(second.at));
  const hidden = earlier ? 0 : Math.max(0, history.length - 2);
  const figures = figuresOf(row);
  const { parts, legacy, supplemented } = feedbackSummary(row);
  const hasBasis = Boolean(row.evidence.length || figures.length || parts.basis);
  const leadCount = supplemented ? 2 : 0;
  async function submit(event: FormEvent<HTMLFormElement>, type: 'feedback.reply' | 'feedback.resolve', supplement = false) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const revision = Number(data.get('revision'));
    if (await command(type, { designId: entry.id, feedbackId: row.id, body: String(data.get('body')),
      ...(revision ? { revision } : {}), ...(supplement ? { supplement: true } : {}),
      ...(type === 'feedback.resolve' ? { decision: row.status === 'closed' ? 'reopen' : 'close' } : {}) })) {
      form.reset();
      setResolving(false);
      setSupplementing(false);
    }
  }
  return <article className="dw-dl-detail" id={`dw-feedback-${row.id}`} aria-labelledby={`fb-title-${row.id}`}>
    <button type="button" className="ep-link dw-dl-back" onClick={onBack}><ArrowLeft />全部反馈</button>
    <header className="dw-dl-detail-head">
      <h3 id={`fb-title-${row.id}`} tabIndex={-1}>{row.title}</h3>
      <p><span className={`dw-dl-state dw-dl-state--${row.status}`}>{feedbackStates[row.status]}</span>
        <span>{feedbackNames[row.category]}</span><span>{designPublisherLabel(row.author.label)} · {designDate(row.createdAt)}</span>
        <button className="ep-link" type="button" onClick={() => openVersion(row.version)}>V{row.version} 资料</button>
        {row.screenId && <button id={`delivery-feedback-${row.id}`} className="ep-link" type="button"
          onClick={() => openScreen(row.version, row.screenId!, `delivery-feedback-${row.id}`)}>定位画面{screens.get(row.screenId) ? `「${screens.get(row.screenId)}」` : ''}</button>}</p>
    </header>
    {row.filePath && <p className="dw-feedback-path">交付文件 <code>{row.filePath}</code></p>}
    {legacy && !supplemented && <div className="dw-dl-legacy">
      <p>这条反馈登记于诉求格式之前</p>
      {canSupplement && !supplementing && <button type="button" className="ep-link" onClick={() => setSupplementing(true)}>补写诉求和完成标准</button>}
    </div>}
    {supplementing && <form className="dw-delivery-form dw-dl-supplement" onSubmit={event => void submit(event, 'feedback.reply', true)}>
      <label>补写诉求和完成标准<textarea name="body" rows={6} required maxLength={4000}
        defaultValue={`## 诉求\n\n${parts.ask}\n\n## 怎么算解决\n\n${parts.done}`} /></label>
      <div className="dw-dl-compose-actions">
        <button className="ep-button" type="button" onClick={() => setSupplementing(false)} disabled={busy}>取消</button>
        <button className="ep-button ep-button--primary" type="submit" disabled={busy}>保存补写</button>
      </div>
    </form>}
    <ol className="dw-dl-items">
      {supplemented && <>
        <li data-item="ask"><h4><b>1</b>诉求<small>希望设计方做什么</small></h4>
          <div className="dw-dl-lead-text"><ReadableNotes source={parts.ask} /></div>
          {legacy && canResolve && !supplementing && <button type="button" className="ep-link dw-dl-edit-supplement" onClick={() => setSupplementing(true)}>更新补写</button>}
        </li>
        <li data-item="done"><h4><b>2</b>怎么算解决<small>关闭时对照这一条</small></h4><ReadableNotes source={parts.done} /></li>
      </>}
      {parts.problem && <li data-item="problem"><h4><b>{leadCount + 1}</b>问题<small>现象和原因</small></h4><ReadableNotes source={parts.problem} /></li>}
      {hasBasis && <li data-item="basis"><h4><b>{leadCount + (parts.problem ? 2 : 1)}</b>依据<small>证据、代码位置、对照图</small></h4>
        {parts.basis && <ReadableNotes source={parts.basis} />}
        {row.evidence.length > 0 && <ul className="dw-dl-evidence">{row.evidence.map((evidence, index) => <li key={index}><code>{evidence}</code></li>)}</ul>}
        {figures.length > 0 && <div className="dw-delivery-shots">
          {figures.map(shot => <figure key={shot.id}><a href={designArtifact(entry.projectId, shot.id)} target="_blank" rel="noreferrer">
            <img loading="lazy" src={designArtifact(entry.projectId, shot.id)} alt={shot.title} /></a>
            <figcaption>{attachmentCaption(entry, row, shot)}</figcaption></figure>)}
        </div>}</li>}
      {history.length > 0 && <li data-item="history"><h4><b>{leadCount + Number(Boolean(parts.problem)) + Number(hasBasis) + 1}</b>往来<small>{history.length} 条</small></h4>
        {hidden > 0 && <button type="button" className="ep-link" data-action="earlier" onClick={() => setEarlier(true)}>显示前面 {hidden} 条</button>}
        <ol className="dw-dl-replies">
          {history.slice(hidden).map((item, index) => <li key={index} className={item.label === '确认关闭' || item.label === '重新打开' ? 'dw-dl-decision' : undefined}>
            <small>{item.label} · {designPublisherLabel(item.author.label)} · {designDate(item.at)}</small>
            <ReadableNotes source={item.body} />
            {item.revision && <button type="button" className="ep-link" onClick={() => openVersion(item.revision!)}>查看 V{item.revision} 修订</button>}
          </li>)}
        </ol></li>}
    </ol>
    {permissions.feedback && <div className="dw-dl-compose">
      {row.status !== 'closed' && !resolving && !supplementing && <form className="dw-delivery-form" onSubmit={event => void submit(event, 'feedback.reply')}>
        <label>回复<textarea name="body" rows={3} required maxLength={4000} placeholder="说明怎么处理；改了稿件就关联版本" /></label>
        <div className="dw-dl-compose-row">
          {revisions.length > 0 && <label>关联本稿版本<select name="revision" defaultValue="">
            <option value="">仅回复说明</option>{revisions.map(item => <option key={item.version} value={item.version}>V{item.version}</option>)}
          </select></label>}
          <span className="dw-dl-compose-actions">
            {canResolve && <button className="ep-button" type="button" data-action="feedback-resolve" onClick={() => setResolving(true)}>确认处理…</button>}
            <button className="ep-button ep-button--primary" type="submit" disabled={busy}>发送回复</button>
          </span>
        </div>
      </form>}
      {canResolve && !supplementing && (resolving || row.status === 'closed') && <form className="dw-delivery-form dw-dl-resolve" onSubmit={event => void submit(event, 'feedback.resolve')}>
        {row.status !== 'closed' && <div className="dw-dl-criterion"><small>对照「怎么算解决」</small>{supplemented ? <ReadableNotes source={parts.done} /> : <p className="dw-dl-missing">没写完成标准，请在复核说明里写明按什么判断。</p>}</div>}
        <label>{row.status === 'closed' ? '重开原因' : '复核说明'}<textarea name="body" rows={2} required maxLength={4000}
          placeholder={row.status === 'closed' ? '说明为什么还没解决' : '写明核对了哪一版、看了什么'} /></label>
        <span className="dw-dl-compose-actions">
          {resolving && <button className="ep-button" type="button" onClick={() => setResolving(false)}>取消</button>}
          <button className="ep-button" type="submit" disabled={busy}>{row.status === 'closed' ? '重新打开' : '确认关闭'}</button>
        </span>
      </form>}
      <FeedbackAttachmentForm entry={entry} row={row} viewedVersion={version.version} busy={busy}
        submit={fields => command('feedback.attach', { designId: entry.id, feedbackId: row.id, ...fields })} />
    </div>}
  </article>;
}

function FeedbackForm({ entry, version, busy, command, draftPath, screenId, onCancel }: {
  entry: DesignEntry; version: DesignVersion; busy: boolean; command: DesignCommand; draftPath?: string; screenId?: string; onCancel: () => void;
}) {
  const [error, setError] = useState('');
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const screenId = data.get('screenId');
    if (!String(data.get('ask') ?? '').trim() || !String(data.get('done') ?? '').trim()) {
      setError('写明诉求和判断完成的标准后再提交。');
      return;
    }
    const evidence = String(data.get('evidence') ?? '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (evidence.length > 8 || evidence.some(value => value.length > 1000)) {
      setError('依据最多八条，每条最多 1000 字。');
      return;
    }
    const body = [['诉求', data.get('ask')], ['怎么算解决', data.get('done')], ['问题', data.get('problem')]]
      .filter(([, value]) => String(value ?? '').trim()).map(([name, value]) => `## ${name}\n\n${String(value).trim()}`).join('\n\n');
    setError('');
    if (await command('feedback.create', { designId: entry.id, version: version.version, category: data.get('category'), ...(draftPath ? { filePath: draftPath } : {}),
      title: data.get('title'), body, ...(screenId ? { screenId } : {}),
      evidence })) { form.reset(); onCancel(); }
  }
  return <article className="dw-dl-detail" aria-labelledby="dw-dl-new">
    <button type="button" className="ep-link dw-dl-back" onClick={onCancel}><ArrowLeft />全部反馈</button>
    <header className="dw-dl-detail-head"><h3 id="dw-dl-new" tabIndex={-1}>登记 V{version.version} 实施反馈</h3>
      <p><span>设计方在这里回复；改了稿件会关联到新版本。</span></p></header>
    <form className="dw-delivery-form" onSubmit={event => void create(event)}>
      <div className="dw-delivery-fields">
        <label>反馈分类<select name="category" defaultValue="gap">{designFeedbackCategories.map(key =>
          <option key={key} value={key}>{feedbackNames[key]}</option>)}</select></label>
        <label>相关画面<select name="screenId" defaultValue={screenId ?? ''}><option value="">整份 V{version.version} 稿件</option>
          {version.screens.map(screen => <option key={screen.id} value={screen.id}>{screen.name}</option>)}</select></label>
      </div>
      {draftPath && <p className="dw-feedback-path">关联交付文件 <code>{draftPath}</code></p>}
      <label>标题 <small>一句话说清是什么问题</small><input name="title" required maxLength={180} defaultValue={draftPath ? `关于 ${draftPath}`.slice(0, 180) : undefined} /></label>
      <label className="dw-dl-field-key"><span><b>1</b>诉求 <small>必填 · 希望设计方做什么，一两句</small></span><textarea name="ask" required rows={2} maxLength={1100} /></label>
      <label className="dw-dl-field-key"><span><b>2</b>怎么算解决 <small>必填 · 关闭时对照这一条</small></span><textarea name="done" required rows={2} maxLength={1100} /></label>
      <label><span><b>3</b>问题 <small>可选 · 现象和原因，支持 Markdown</small></span><textarea name="problem" rows={4} maxLength={1600} /></label>
      <label><span><b>4</b>依据 <small>可选 · 证据或代码位置，每行一条，最多八条</small></span><textarea name="evidence" rows={2} maxLength={8000}
        defaultValue={draftPath ? `V${version.version} · ${draftPath}` : undefined} /></label>
      {error && <p className="ep-error" role="alert">{error}</p>}
      <span className="dw-dl-compose-actions"><button className="ep-button" type="button" onClick={onCancel}>取消</button>
        <button className="ep-button ep-button--primary" type="submit" disabled={busy}>提交反馈</button></span>
    </form>
  </article>;
}

/* ── 资料 ─────────────────────────── */
function DeliveryFileReader({ entry, version, file, onFeedback, onBack, go }: {
  entry: DesignEntry; version: DesignVersion; file: DesignDeliveryFile; onFeedback?: (path: string) => void; onBack: () => void; go: Go;
}) {
  const [history, setHistory] = useState([0]);
  const [retry, setRetry] = useState(0);
  const offset = history.at(-1)!;
  const prototype = file.kind === 'prototype';
  const chunk = usePlanningRead<FileChunk>(file.text && !prototype && !isImage(file)
    ? `${designPath(entry.projectId)}/artifacts/${encodeURIComponent(file.id)}?view=text&offset=${offset}` : null, retry);
  const visible = chunk.data?.artifactId === file.id && chunk.data?.offset === offset ? chunk.data : undefined;
  const top = useRef<HTMLHeadingElement>(null);
  const headings = useMemo(() => visible && /\.md$/i.test(file.path)
    ? marked.lexer(visible.text).flatMap(token => token.type === 'heading' ? [(token as Tokens.Heading).text] : [])
    : [], [visible, file.path]);
  return <article className="dw-dl-reader" aria-labelledby={`file-${file.id}`}>
    <button type="button" className="ep-link dw-dl-back" onClick={onBack}><ArrowLeft />全部文件</button>
    <header className="dw-dl-detail-head dw-dl-reader-head">
      <div><h3 id={`file-${file.id}`} ref={top} tabIndex={-1}>{file.path}</h3>
        <p><span className="dw-dl-purpose">{groupOf(file).label} · {groupOf(file).purpose}</span><span>{size(file.size)}</span><span><code>{file.sha256.slice(0, 8)}</code></span></p></div>
      <span className="dw-dl-compose-actions">
        {onFeedback && <button className="ep-button" type="button" data-action="file-feedback" onClick={() => onFeedback(file.path)}><MessageSquare />对这个文件提反馈</button>}
        <a className="ep-button" href={designArtifact(entry.projectId, file.id) + '?download=true'} download={file.path.split('/').at(-1)}><Download />原文件</a>
      </span>
    </header>
    {headings.length > 0 && <nav className="dw-dl-outline" aria-label="本段章节">{headings.map((heading, index) =>
      <button key={index} type="button" className="ep-link" onClick={() => {
        const targets = top.current?.closest('.dw-dl-reader')?.querySelectorAll('.dw-dl-contents .dw-notes > :is(h1,h2,h3,h4,h5,h6)');
        targets?.[index]?.scrollIntoView({ block: 'start' });
      }}>{heading}</button>)}</nav>}
    <div className="dw-dl-contents" role="region" aria-label="文件内容">
      {isImage(file) ? <a href={designArtifact(entry.projectId, file.id)} target="_blank" rel="noreferrer"><img className="dw-dl-image" src={designArtifact(entry.projectId, file.id)} alt={file.path} /></a>
        : prototype ? <p className="dw-muted"><button type="button" className="ep-link"
          onClick={() => go({ tab: 'preview', part: '', fb: '', file: '' })}>打开 V{version.version} 画面</button></p>
        : visible ? (/\.md$/i.test(file.path) ? <ReadableNotes source={visible.text} /> : <pre>{visible.text}</pre>)
        : chunk.error ? <p role="alert">{chunk.error} <button className="ep-button" type="button" onClick={() => setRetry(value => value + 1)}>重试</button></p>
        : file.text && chunk.loading ? <ContentLoading label="正在读取文件" />
        : <p className="dw-muted">这个文件不能在页面里显示，请下载原文件。</p>}
    </div>
    {(history.length > 1 || (visible && visible.nextOffset !== null)) && <div className="dw-dl-compose-actions dw-dl-pages" aria-label="文件分页">
      {history.length > 1 && <button className="ep-button" type="button" onClick={() => setHistory(history.slice(0, -1))}>上一段</button>}
      <small>第 {history.length} 段</small>
      {visible && visible.nextOffset !== null && <button className="ep-button" type="button" onClick={() => { setHistory([...history, visible.nextOffset!]); top.current?.scrollIntoView({ block: 'start' }); }}>下一段</button>}
    </div>}
  </article>;
}

function FilesPart({ entry, version, selected, onSelect, onFeedback, onBack, go }: {
  entry: DesignEntry; version: DesignVersion; selected?: string; onSelect: (id: string) => void; onFeedback?: (path: string) => void; onBack: () => void; go: Go;
}) {
  const delivery = version.delivery!;
  const [query, setQuery] = useState('');
  const term = query.trim().toLocaleLowerCase();
  const files = delivery.files.filter(file => !term || [file.path, fileNames[file.kind], ...(file.headings ?? [])]
    .some(value => value.toLocaleLowerCase().includes(term)));
  const groups = groupFiles(files);
  const file = delivery.files.find(item => item.id === selected);
  return <div className="dw-dl-split" data-has-detail={Boolean(file) || undefined}>
    <div className="dw-dl-list" aria-label="版本文件">
      <div className="dw-dl-list-tools"><label className="dw-dl-search"><span className="sr-only">查找文件、章节</span>
        <input type="search" placeholder="查找文件、章节" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
      {groups.map((group, index) => <details key={group.key} className="dw-dl-group" open={term ? true : group.open || group.files.some(item => item.id === selected) || undefined}>
        <summary><b>{index + 1}</b><span><strong>{group.label}<small>{group.files.length}</small></strong><em>{group.purpose}</em></span></summary>
        <ul>{group.files.map(item => <li key={item.id}>
          <button type="button" className="dw-dl-row dw-dl-file" data-file={item.id} aria-current={item.id === selected || undefined} onClick={() => onSelect(item.id)}>
            {isImage(item) ? <FileImage /> : item.kind === 'source' || item.kind === 'prototype' ? <FileCode /> : <FileText />}
            <span><strong>{item.path.split('/').at(-1)}</strong><small>{item.path.includes('/') ? `${item.path.split('/').slice(0, -1).join('/')}/ · ` : ''}{size(item.size)}</small></span>
          </button></li>)}</ul>
      </details>)}
      {!files.length && <p className="dw-muted dw-dl-empty">没有匹配文件，试试文件名或章节名称。</p>}
    </div>
    {file ? <DeliveryFileReader key={file.id} entry={entry} version={version} file={file} onFeedback={onFeedback} onBack={onBack} go={go} />
      : <p className="dw-muted dw-dl-placeholder">从左侧选一个文件。</p>}
  </div>;
}

function HandoffCheck({ entry, version, permissions, busy, command, openScreen }: {
  entry: DesignEntry; version: DesignVersion; permissions: Permissions; busy: boolean; command: DesignCommand; openScreen: OpenScreen;
}) {
  const status = version.handoff!;
  const issues = status.cases?.filter(item => item.status !== 'passed');
  return <section className="dw-surface dw-dl-checks" aria-label="交接检查">
    <h3 role="status">{designHandoffStatusNames[status.status]}</h3>
    {status.status === 'missing-plan' && <p>请设计方在同一稿件续版，补上关键任务的操作和预期结果。</p>}
    {status.status === 'pending' && <p>运行检查后，才能从本版开始实施。</p>}
    {status.status === 'running' && <p>CDS 正在打开原型并执行操作。可以继续查看稿件。</p>}
    {status.status === 'unavailable' && !status.cases && <p>请在主用 CDS 中重试检查。</p>}
    {status.cases && <p>已通过 {status.cases.length - (issues?.length ?? 0)} / {status.cases.length} 个场景 · {designDate(status.checkedAt)}</p>}
    {!!issues?.length && <ul>{issues.map(item => <li key={item.caseId}>
      <button type="button" className="ep-link" onClick={() => openScreen(version.version, item.screenId, 'handoff-' + item.caseId)}>{item.title}</button>
      {' · '}{item.ruleIds.join('、')}{item.step && item.step > 0 ? ` · 第 ${item.step} 步` : ''}
      <p>{item.owner === 'cds' ? 'CDS' : '设计方'} · {item.message}</p>
    </li>)}</ul>}
    {permissions.handoffCheck && version.handoffPlan && (status.status === 'pending' || status.status === 'unavailable' || status.status === 'failed') &&
      <button type="button" className="ep-button" disabled={busy} onClick={() => void command('handoff.check', {
        designId: entry.id, version: version.version,
      })}>{status.status === 'pending' ? '运行检查' : '重新检查'}</button>}
  </section>;
}

export function DesignDeliveryPanel({ entry, version, permissions, busy, command, openScreen, openVersion }: {
  entry: DesignEntry; version: DesignVersion; permissions: Permissions; busy: boolean; command: DesignCommand;
  openScreen: OpenScreen; openVersion: (version: number) => void;
}) {
  const [params, setParams] = useSearchParams();
  const { hash } = useLocation();
  const rows = useMemo(() => [...(entry.feedback ?? [])].sort((first, second) => lastActivity(second).localeCompare(lastActivity(first))), [entry.feedback]);
  const pending = rows.filter(row => row.status !== 'closed');
  const mine = permissions.feedback ? pending.filter(row => designFeedbackAwaitsViewer(entry, row, permissions.actorId)) : [];
  const delivery = version.delivery;
  const [filter, setFilter] = useState<'pending' | 'all'>(pending.length ? 'pending' : 'all');
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(min-width: 900px)');
    const change = () => setWide(query.matches);
    change();
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  const anchorPrefix = '#dw-feedback-';
  const fb = params.get('fb') ?? (hash.startsWith(anchorPrefix) ? hash.slice(anchorPrefix.length) : '');
  const requestedPart = params.get('part');
  const part: Part = requestedPart === 'handoff' && version.handoff ? 'handoff' : fb || hash === '#dw-delivery-feedback' || requestedPart === 'feedback' ? 'feedback'
    : requestedPart === 'files' || params.has('file') ? 'files' : mine.length || !delivery ? 'feedback' : 'files';
  const fileParam = params.get('file') ?? '';
  /* 从资料「对这个文件提反馈」进来时带上文件路径，刷新或发给别人也保留 */
  const draftPath = delivery?.files.find(file => file.path === params.get('about'))?.path;
  /* 宽屏默认选中第一条等你处理的反馈和交付说明；窄屏先给列表 */
  const selectedFb = fb || (wide ? (mine[0] ?? pending[0] ?? rows[0])?.id ?? '' : '');
  const selectedFile = fileParam || (wide ? (delivery?.files.find(file => file.kind === 'guide') ?? delivery?.files[0])?.id ?? '' : '');
  const go: Go = fields => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(fields)) { if (value) next.set(key, value); else next.delete(key); }
    setParams(next);
  };
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!fb && !fileParam) return;
    panel.current?.querySelector<HTMLElement>('h3[tabindex]')?.focus({ preventScroll: true });
    if (!wide) panel.current?.scrollIntoView({ block: 'start' });
  }, [fb, fileParam, wide]);
  const row = rows.find(item => item.id === selectedFb);
  const creating = fb === 'new' && permissions.feedback;
  const draftScreen = version.screens.find(screen => screen.id === params.get('screen'))?.id;
  const tabs: [Part, string, number][] = [['feedback', '反馈', mine.length], ['files', '资料', 0]];
  if (version.handoff && version.handoff.status !== 'legacy') tabs.push(['handoff', '交接检查',
    version.handoff.cases?.filter(item => item.status !== 'passed').length ?? 0]);
  return <div className="dw-delivery-panel dw-dl">
    <div className="dw-dl-top">
      <nav className="dw-dl-parts" role="tablist" aria-label="交付内容">
        {tabs.map(([key, label, count]) => <button key={key} type="button" role="tab" aria-selected={part === key} data-part={key}
          data-todo={count > 0 || undefined} onClick={() => go({ part: key, fb: '', file: '', about: '' })}>
          {label}{count > 0 && <small className="dw-tab-todo" title={key === 'handoff' ? `${count} 个场景待修正` : `${count} 条反馈等你处理`}>{count}</small>}</button>)}
      </nav>
      <DeliveryFacts entry={entry} version={version} />
    </div>
    <DeliveryNote version={version} />
    <div ref={panel} role="tabpanel" aria-label={tabs.find(item => item[0] === part)?.[1]} className="dw-dl-panel">
      {part === 'handoff' && <HandoffCheck entry={entry} version={version} permissions={permissions} busy={busy}
        command={command} openScreen={openScreen} />}
      {part === 'feedback' && <div id="dw-delivery-feedback" className="dw-dl-split" data-has-detail={Boolean(row || creating) || undefined}>
        <FeedbackList rows={rows} selected={creating ? undefined : selectedFb} filter={filter} setFilter={setFilter} entry={entry} permissions={permissions}
          onSelect={id => go({ part: 'feedback', fb: id, about: '' })} onCreate={() => go({ part: 'feedback', fb: 'new', about: '' })} />
        {creating ? <FeedbackForm key={draftPath ?? 'new'} entry={entry} version={version} busy={busy} command={command} draftPath={draftPath} screenId={draftScreen}
          onCancel={() => go({ fb: '', about: '' })} />
          : row ? <FeedbackDetail key={row.id} row={row} entry={entry} version={version} permissions={permissions} busy={busy} command={command}
            openScreen={openScreen} openVersion={openVersion} onBack={() => go({ fb: '' })} />
          : <p className="dw-muted dw-dl-placeholder">{rows.length ? '从左侧选一条反馈。' : '还没有实施反馈。实现中发现缺漏、约束或更好的做法，在这里登记。'}</p>}
      </div>}
      {part === 'files' && (delivery ? <FilesPart entry={entry} version={version} selected={selectedFile} go={go}
        onSelect={id => go({ part: 'files', file: id })} onBack={() => go({ file: '' })}
        onFeedback={permissions.feedback ? path => go({ part: 'feedback', fb: 'new', about: path, file: '' }) : undefined} />
        : <section className="dw-surface dw-dl-checks"><h3>没有资料归档</h3><p>此版本发布于资料归档启用前。原型、思路、规范和自检仍可从对应标签查看。</p>
          {version.sourcePath && <p>Git 目录 <code>{version.sourcePath}</code></p>}</section>)}
    </div>
  </div>;
}
