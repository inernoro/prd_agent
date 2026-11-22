import { useState, type FormEvent } from 'react';
import { Download, FileText, MessageSquare } from 'lucide-react';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import {
  designFeedbackCategories, type DesignDeliveryFile, type DesignEntry, type DesignFeedback, type DesignVersion, type DesignWorkspace,
} from '../../../../src/shared/design-workspace';
import { usePlanningRead } from '../engineering-planning/planning-ui';
import { ReadableNotes } from './DesignMarkdown';
import { designArtifact, designCheckRows, designDate, designPath, designSourceNames, type DesignCommand } from './design-ui';

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

function DeliveryFiles({ entry, version }: { entry: DesignEntry; version: DesignVersion }) {
  const delivery = version.delivery;
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState(delivery?.files.find(file => file.kind === 'guide')?.id ?? delivery?.files[0]?.id);
  const [history, setHistory] = useState([0]);
  const [retry, setRetry] = useState(0);
  const selected = delivery?.files.find(file => file.id === selection);
  const offset = history.at(-1)!;
  const chunk = usePlanningRead<FileChunk>(selected?.text
    ? `${designPath(entry.projectId)}/artifacts/${encodeURIComponent(selected.id)}?view=text&offset=${offset}` : null, retry);
  const visibleChunk = chunk.data?.artifactId === selected?.id && chunk.data?.offset === offset ? chunk.data : undefined;
  if (!delivery) return <section className="dw-surface dw-delivery-card">
    <h2>版本资料</h2><p>此版本发布于资料归档启用前。已保留的原型、思路、规范和自检仍可从对应标签查看。</p>
    {version.sourcePath && <p>Git 目录 <code>{version.sourcePath}</code></p>}
  </section>;
  const term = query.trim().toLocaleLowerCase();
  const files = delivery.files.filter(file => !term || [file.path, fileNames[file.kind], ...(file.headings ?? [])]
    .some(value => value.toLocaleLowerCase().includes(term)));
  return <section className="dw-surface dw-delivery-card" aria-labelledby="dw-delivery-files">
    <header className="dw-delivery-heading">
      <div><h2 id="dw-delivery-files">版本资料</h2><small>{delivery.files.length} 个文件 · V{version.version}</small></div>
      <a className="ep-button" href={designArtifact(entry.projectId, delivery.archiveId)} download><Download />下载原包</a>
    </header>
    <div className="dw-delivery-browser">
      <div className="dw-delivery-filelist">
        <label>查找文件、章节<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <div className="dw-delivery-files" aria-label="版本文件">
          {files.map(file => <button type="button" key={file.id} aria-pressed={file.id === selection} onClick={() => {
            setSelection(file.id); setHistory([0]); setRetry(0);
          }}>
            <FileText /><span><strong>{file.path}</strong><small>{fileNames[file.kind]}</small></span>
          </button>)}
          {!files.length && <p className="dw-muted">没有匹配文件，试试文件名或章节名称。</p>}
        </div>
      </div>
      {selected && <div className="dw-delivery-document">
        <header className="dw-delivery-heading">
          <div><h3>{selected.path}</h3><small>{fileNames[selected.kind]} · {(selected.size / 1024).toFixed(1)} KiB</small></div>
          <a className="ep-button" href={designArtifact(entry.projectId, selected.id) + '?download=true'} download={selected.path.split('/').at(-1)}><Download />原文件</a>
        </header>
        {selected.headings?.length ? <details className="dw-delivery-outline">
          <summary>章节目录 · {selected.headings.length} 项</summary>
          <ul>{selected.headings.map((heading, index) => <li key={index}>{heading}</li>)}</ul>
        </details> : null}
        <div className="dw-delivery-contents" role="region" aria-label="文件内容" tabIndex={0}>
          {visibleChunk ? (/\.md$/i.test(selected.path) ? <ReadableNotes source={visibleChunk.text} /> : <pre>{visibleChunk.text}</pre>)
            : chunk.error ? <p role="alert">{chunk.error} <button className="ep-button" type="button" onClick={() => setRetry(value => value + 1)}>重试</button></p>
            : selected.text && chunk.loading ? <ContentLoading label="正在读取文件" />
              : <p className="dw-muted">请下载原文件查看此附件。</p>}
        </div>
        <div className="dw-delivery-actions dw-delivery-pagination" aria-label="文件分页">
          {history.length > 1 && <button className="ep-button" type="button" onClick={() => setHistory(history.slice(0, -1))}>上一段</button>}
          {visibleChunk && visibleChunk.nextOffset !== null && <button className="ep-button" type="button" onClick={() => setHistory([...history, visibleChunk.nextOffset!])}>下一段</button>}
        </div>
      </div>}
    </div>
  </section>;
}

function DeliveryChecks({ version, openScreen }: { version: DesignVersion; openScreen: OpenScreen }) {
  const missing = version.screens.filter(screen => !screen.impl);
  const slots = version.screens.reduce((sum, screen) => sum + screen.themes.length, 0);
  const captured = Object.values(version.renders ?? {}).reduce((sum, themes) => sum + Object.keys(themes).length, 0);
  const origins = new Map<string, typeof version.screens>();
  for (const screen of version.screens) {
    const key = `${screen.viewport}:${screen.route}`;
    origins.set(key, [...(origins.get(key) ?? []), screen]);
  }
  const sharedEntries = [...origins.values()].filter(items => items.length > 1);
  const checks = designCheckRows(version);
  return <section className="dw-surface dw-delivery-card" aria-labelledby="dw-delivery-checks">
    <h2 id="dw-delivery-checks">验收指引</h2>
    <div className="dw-delivery-metrics">
      <div><strong>{version.screens.length - missing.length}/{version.screens.length}</strong><span>已有实现地址</span></div>
      <div><strong>{captured}/{slots}</strong><span>已有原型截图</span></div>
      <div><strong>{version.acceptance.length}</strong><span>稿件验收项</span></div>
      <div><strong>{checks.filter(check => check.status === '通过').length}/{checks.length}</strong><span>作者原型自检</span></div>
    </div>
    {missing.length > 0 && <details>
      <summary>{missing.length} 个画面待补实现地址</summary>
      <ul>{missing.map(screen => <li key={screen.id}>
        <button id={`delivery-check-${screen.id}`} className="ep-link" type="button"
          onClick={() => openScreen(version.version, screen.id, `delivery-check-${screen.id}`)}>{screen.name}</button>
      </li>)}</ul>
    </details>}
    {sharedEntries.length > 0 && <details>
      <summary>{sharedEntries.length} 组画面共用原型入口</summary>
      <ul>{sharedEntries.map(items => <li key={items[0].id}>{items.map(screen => screen.name).join('、')} <code>{items[0].route}</code> · 可在画布内切换状态</li>)}</ul>
    </details>}
    {version.acceptance.length > 0 && <details><summary>查看稿件验收项</summary><ul>
      {version.acceptance.map(rule => <li key={rule.id}><code>{rule.id}</code> {rule.rule}
        {rule.expected && <p>预期 {rule.expected}</p>}
        {rule.how === 'measure' && !rule.probe && <small> · 待补测量方法</small>}
      </li>)}
    </ul></details>}
    {checks.length > 0 && <details><summary>查看 {checks.length} 条作者原型自检</summary>
      <p className="dw-muted">记录来源为随稿自检。实现分支取证在「做法验收」。</p>
      <ul>{checks.map((row, index) => <li key={`${row.id}/${index}`}>{row.name} <small>{row.status}</small></li>)}</ul>
    </details>}
  </section>;
}

function FeedbackThread({ row, entry, permissions, busy, command, openScreen, openVersion }: {
  row: DesignFeedback; entry: DesignEntry; permissions: Permissions; busy: boolean; command: DesignCommand;
  openScreen: OpenScreen; openVersion: (version: number) => void;
}) {
  const revisions = entry.versions.filter(version => version.version >= row.version &&
    (permissions.steward || version.publisher.id === permissions.actorId));
  const canResolve = permissions.feedback && (permissions.steward || row.author.id === permissions.actorId);
  const history = [
    ...row.replies.map(reply => ({ ...reply, label: '回复' })),
    ...row.decisions.map(decision => ({ ...decision, revision: undefined, label: decision.decision === 'close' ? '确认关闭' : '重新打开' })),
  ].sort((first, second) => first.at.localeCompare(second.at));
  async function submit(event: FormEvent<HTMLFormElement>, type: 'feedback.reply' | 'feedback.resolve') {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const revision = Number(data.get('revision'));
    if (await command(type, { designId: entry.id, feedbackId: row.id, body: String(data.get('body')),
      ...(revision ? { revision } : {}), ...(type === 'feedback.resolve' ? { decision: row.status === 'closed' ? 'reopen' : 'close' } : {}) })) form.reset();
  }
  return <details className="dw-delivery-thread" open={row.status !== 'closed' || undefined}>
    <summary><strong>{row.title}</strong><small>{feedbackNames[row.category]} · {feedbackStates[row.status]}</small></summary>
    <div className="dw-delivery-actions">
      <small>{row.author.label} · {designDate(row.createdAt)}</small>
      <button className="ep-link" type="button" onClick={() => openVersion(row.version)}>V{row.version} 资料</button>
      {row.screenId && <button id={`delivery-feedback-${row.id}`} className="ep-link" type="button"
        onClick={() => openScreen(row.version, row.screenId!, `delivery-feedback-${row.id}`)}>定位画面</button>}
    </div>
    <p>{row.body}</p>
    {row.evidence.length > 0 && <ul>{row.evidence.map((evidence, index) => <li key={index}>{evidence}</li>)}</ul>}
    {history.length > 0 && <ol className="dw-delivery-replies">
      {history.map((item, index) => <li key={index}>
        <small>{item.label} · {item.author.label} · {designDate(item.at)}</small>
        <p>{item.body}</p>
        {item.revision && <button type="button" className="ep-link" onClick={() => openVersion(item.revision!)}>查看 V{item.revision} 修订</button>}
      </li>)}
    </ol>}
    {permissions.feedback && row.status !== 'closed' && <form className="dw-delivery-form" onSubmit={event => void submit(event, 'feedback.reply')}>
      <label>回复<textarea name="body" rows={2} required maxLength={4000} /></label>
      {revisions.length > 0 && <label>关联本稿版本<select name="revision" defaultValue="">
        <option value="">仅回复说明</option>{revisions.map(version => <option key={version.version} value={version.version}>V{version.version}</option>)}
      </select></label>}
      <button className="ep-button" type="submit" disabled={busy}>发送回复</button>
    </form>}
    {canResolve && <details className="dw-delivery-resolution">
      <summary>{row.status === 'closed' ? '重开反馈' : '确认处理'}</summary>
      <form className="dw-delivery-form" onSubmit={event => void submit(event, 'feedback.resolve')}>
        <label>复核说明<textarea name="body" rows={2} required maxLength={4000} /></label>
        <button className="ep-button" type="submit" disabled={busy}>{row.status === 'closed' ? '重新打开' : '确认关闭'}</button>
      </form>
    </details>}
  </details>;
}

export function DesignDeliveryPanel({ entry, version, permissions, busy, command, openScreen, openVersion }: {
  entry: DesignEntry; version: DesignVersion; permissions: Permissions; busy: boolean; command: DesignCommand;
  openScreen: OpenScreen; openVersion: (version: number) => void;
}) {
  const threads = [...(entry.feedback ?? [])].reverse();
  const delivery = version.delivery;
  const pendingFeedback = threads.filter(thread => thread.status !== 'closed').length;
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const screenId = data.get('screenId');
    if (await command('feedback.create', { designId: entry.id, version: version.version, category: data.get('category'),
      title: data.get('title'), body: data.get('body'), ...(screenId ? { screenId } : {}),
      evidence: String(data.get('evidence') ?? '').split(/\r?\n/).map(value => value.trim()).filter(Boolean) })) form.reset();
  }
  return <div className="dw-delivery-panel">
    <section className="dw-surface dw-delivery-card dw-delivery-version">
      <div><header className="dw-delivery-heading"><h2>V{version.version} 交付摘要</h2>
        <a className="ep-link" href="#dw-delivery-feedback" onClick={event => {
          event.preventDefault();
          const heading = document.getElementById('dw-delivery-feedback');
          heading?.scrollIntoView({ block: 'start' });
          heading?.focus({ preventScroll: true });
        }}><MessageSquare size={16} aria-hidden />实施反馈 {pendingFeedback || ''}</a>
      </header>
        <p>{version.note || delivery?.notes || '本版未附变更说明。'}</p>
        {version.note && delivery?.notes && version.note !== delivery.notes && <p>{delivery.notes}</p>}
        <small>{version.publisher.label} · {designDate(version.createdAt)}{delivery?.prototypeVersion ? ` · 原型第 ${delivery.prototypeVersion} 版` : ''}
          {delivery?.date ? ` · 稿件日期 ${delivery.date}` : ''}</small>
      </div>
      <div><strong>{designSourceNames[version.sourceVerification ?? 'declared']}</strong>
        <code>{version.sourceCommit}</code>
        {version.sourcePath && <small>{version.sourcePath}</small>}
        {delivery?.frameworkDraft && <small>框架草案 {delivery.frameworkDraft}</small>}
        {delivery?.source && <small>可重建源码 {delivery.source}</small>}
      </div>
      {delivery?.warnings.length ? <ul className="dw-delivery-warnings">{delivery.warnings.map(message => <li key={message}>{message}</li>)}</ul> : null}
    </section>
    <DeliveryChecks version={version} openScreen={openScreen} />
    <DeliveryFiles entry={entry} version={version} />
    <section className="dw-surface dw-delivery-card" aria-labelledby="dw-delivery-feedback">
      <header className="dw-delivery-heading"><div><h2 id="dw-delivery-feedback" tabIndex={-1}>实施反馈</h2>
        <small>{pendingFeedback} 条待处理 · 跨版本保留</small></div><MessageSquare /></header>
      {permissions.feedback && <details><summary>登记实施反馈</summary>
        <form className="dw-delivery-form" onSubmit={event => void create(event)}>
          <div className="dw-delivery-fields">
            <label>反馈分类<select name="category" defaultValue="gap">{designFeedbackCategories.map(key =>
              <option key={key} value={key}>{feedbackNames[key]}</option>)}</select></label>
            <label>相关画面<select name="screenId" defaultValue=""><option value="">整份 V{version.version} 稿件</option>
              {version.screens.map(screen => <option key={screen.id} value={screen.id}>{screen.name}</option>)}</select></label>
          </div>
          <label>标题<input name="title" required maxLength={180} /></label>
          <label>问题与建议<textarea name="body" required rows={4} maxLength={4000} /></label>
          <label>证据或代码位置 <small>可选，每行一条，最多八条</small><textarea name="evidence" rows={2} maxLength={8000} /></label>
          <button className="ep-button ep-button--primary" type="submit" disabled={busy}>提交 V{version.version} 反馈</button>
        </form>
      </details>}
      {threads.length ? threads.map(row => <FeedbackThread key={row.id} row={row} entry={entry} permissions={permissions}
        busy={busy} command={command} openScreen={openScreen} openVersion={openVersion} />)
        : <p className="dw-muted">还没有实施反馈。</p>}
    </section>
  </div>;
}
