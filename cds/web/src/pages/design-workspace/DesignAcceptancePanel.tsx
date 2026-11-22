import { useEffect, useState } from 'react';
import { Check, FileCheck2, RefreshCw, ScrollText } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { designAcceptanceTarget, designSlots, type DesignCell, type DesignEntry, type DesignRun, type DesignVersion } from '../../../../src/shared/design-workspace';
import { cellNames, designArtifact, designDate, ruleModes, slotNames, verdictNames, type DesignCommand } from './design-ui';
import { planningPath, usePlanningRead } from '../engineering-planning/planning-ui';

function BindImplementation({ version, preferred, busy, close, bind }: {
  version: DesignVersion; preferred: string | null; busy: boolean; close: () => void;
  bind: (fields: Record<string, unknown>) => Promise<boolean>;
}) {
  const initial = version.screens.find(screen => screen.id === preferred) ?? version.screens.find(screen => !screen.impl) ?? version.screens[0];
  const [screenId, selectScreen] = useState(initial.id);
  const [path, setPath] = useState(initial.impl ?? '');
  const [ready, setReady] = useState(initial.readySelector ?? '');
  const select = (id: string) => {
    const screen = version.screens.find(row => row.id === id);
    selectScreen(id);
    setPath(screen?.impl ?? '');
    setReady(screen?.readySelector ?? '');
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}><DialogContent className="dw-modal dw-surface">
    <DialogTitle>绑定实现画面</DialogTitle>
    <DialogDescription>填写该画面在项目预览中的相对地址，以及只能在目标状态出现的元素选择器。</DialogDescription>
    <form onSubmit={async event => {
      event.preventDefault();
      if (await bind({ screens: [{ screenId, path: path.trim(), readySelector: ready.trim() }] })) close();
    }}>
      <label>原型画面<select value={screenId} onChange={event => select(event.target.value)}>
        {version.screens.map(row => <option key={row.id} value={row.id}>{row.name} · {row.viewport === 'phone' ? '手机' : '桌面'}{row.impl ? ' · 已绑定' : ''}</option>)}
      </select></label>
      <label>预览内地址<input value={path} onChange={event => setPath(event.target.value)} placeholder="/页面?参数=值" maxLength={1200} required /></label>
      <label>就绪选择器<input value={ready} onChange={event => setReady(event.target.value)} maxLength={300} placeholder="#当前画面" required /></label>
      <footer><button className="ep-button" type="button" onClick={close} disabled={busy}>取消</button>
        <button className="ep-button ep-button--primary" disabled={busy}>保存定位</button></footer>
    </form>
  </DialogContent></Dialog>;
}

export function DesignAcceptancePanel({ entry, version, busy, canWrite, canReview, canSign, command, onPreviewStale }: {
  entry: DesignEntry; version: DesignVersion; busy: boolean; canWrite: boolean; canReview: boolean; canSign: boolean;
  command: DesignCommand; onPreviewStale: () => void;
}) {
  const [params] = useSearchParams();
  const [runId, setRunId] = useState(params.get('run') ?? '');
  const [pr, setPr] = useState(String(entry.pullRequest ?? ''));
  const [selected, setSelected] = useState<DesignCell>();
  const [binding, setBinding] = useState(false);
  const [previewRevision, refreshPreview] = useState(0);
  const runs = entry.runs.filter(row => row.version === version.version);
  const run = runs.find(row => row.id === runId) ?? runs.at(-1);
  const previewPath = run ? `${planningPath(entry.projectId)}/preview/${run.pullRequest}` : null;
  const preview = usePlanningRead<{ projectId: string; commit?: string }>(previewPath, previewRevision);
  useEffect(() => {
    if (!previewPath) return;
    const refresh = () => { if (document.visibilityState === 'visible') refreshPreview(value => value + 1); };
    window.addEventListener('focus', refresh);
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      window.removeEventListener('focus', refresh);
      window.clearInterval(timer);
    };
  }, [previewPath]);
  const items = version.acceptance;
  const failures = items.filter(item => run?.cells.some(cell => cell.itemId === item.id && cell.status === 'failed'));
  const pending = run?.cells.filter(cell => (cell.status === 'missing' || cell.status === 'unverified') && !cell.debtId) ?? [];
  const counts = [
    ['通过', run?.cells.filter(cell => cell.status === 'passed').length ?? 0],
    ['不通过', run?.cells.filter(cell => cell.status === 'failed').length ?? 0],
    ['待补证据', pending.length],
    ['已记债', new Set(run?.cells.flatMap(cell => cell.debtId ? [cell.debtId] : [])).size],
  ] as const;
  const state = run?.verdict ?? 'needs_evidence';
  const activeCommit = preview.data?.projectId === entry.projectId ? preview.data.commit : undefined;
  const linkedChanged = !!run && run.pullRequest !== entry.pullRequest;
  const stale = !!run && (linkedChanged || (!!activeCommit && activeCommit !== run.commit));
  const staleSignature = stale && !!run && entry.currentSignoffRunId === run.id;
  useEffect(() => { if (staleSignature) onPreviewStale(); }, [staleSignature, onPreviewStale]);
  const evidenceWritable = canWrite && !!run && !run.signed && !stale && activeCommit === run.commit && !preview.loading;
  const signable = run && !run.signed && entry.frozen === version.version && run.id === entry.runs.at(-1)?.id
    && !stale && activeCommit === run.commit && !preview.loading
    && (state === 'passed' || state === 'conditional') && version.version === entry.versions.at(-1)?.version;
  const send = (action: string, fields: Record<string, unknown>) => command(action, { designId: entry.id, ...fields });
  const start = async () => {
    if (await send('acceptance.start', { version: version.version, pullRequest: Number(pr) })) {
      setRunId('');
      refreshPreview(value => value + 1);
    }
  };
  const sign = async () => {
    if (run && !(await send('acceptance.sign', { runId: run.id }))) refreshPreview(value => value + 1);
  };
  return <section className="dw-acceptance">
    <div className="dw-baseline">基准 V{entry.frozen ?? '未定稿'}{run && <> · PR #{run.pullRequest} · 提交 <code>{run.commit.slice(0, 8)}</code></>}</div>
    <section className="dw-surface dw-verdict">
      <div>
        <strong className="dw-status" data-state={stale ? 'needs_evidence' : state}>{linkedChanged ? '针对旧 PR' : stale ? '针对旧提交' : run ? verdictNames[state] : '等待运行'}</strong>
        <h2>{run ? `PR #${run.pullRequest} ${linkedChanged ? '关联已变更' : stale ? '预览已更新' : `${signable ? '可以' : run.signed ? '已按' : '暂不能按'} V${version.version} 签收`}` : '尚无真实页面验收证据'}</h2>
        <p>{linkedChanged ? '请对当前关联的 PR 重新运行，本次验收保留在记录里。'
          : stale ? `当前预览为 ${activeCommit?.slice(0, 8)}。请对当前提交重新运行，本次验收保留在记录里。`
          : run?.signed ? `签收于 ${designDate(run.signed.at)} · 提交 ${run.commit.slice(0, 8)}`
          : run && preview.loading ? '正在核对当前预览提交。'
          : run && !activeCommit ? '暂时无法核对当前预览提交，请确认预览已部署。'
          : failures.length ? `有 ${failures.length} 项发现问题。修复后重跑，或把普通问题记成债务。`
          : pending.length ? `还有 ${pending.length} 个场景需要证据。`
          : entry.frozen !== version.version ? '定稿后，可用关联的 PR 预览开始验收。' : '请选择当前项目已部署的 PR。'}</p>
        {run && <small><code>{run.id.slice(0, 16)}</code> · {designDate(run.createdAt)} · <a href={run.previewUrl} target="_blank" rel="noreferrer">打开真实预览</a></small>}
      </div>
      <div className="dw-verdict-actions">
        <dl>{counts.map(([label, count]) => <div key={label} data-status={label}><dt>{label}</dt><dd>{count}</dd></div>)}</dl>
        <div className="dw-row">
          {runs.length > 1 && <select aria-label="查看历史运行" value={run?.id ?? ''} onChange={event => setRunId(event.target.value)}>
            {[...runs].reverse().map(row => <option key={row.id} value={row.id}>{row.commit.slice(0, 8)}{row.signed ? row.id === runs.at(-1)?.id ? ' · 已签收' : ' · 历史签收' : ' · ' + verdictNames[row.verdict]}</option>)}
          </select>}
          {canWrite && <form className="dw-row" onSubmit={event => { event.preventDefault(); void start(); }}>
            <input aria-label="关联 PR 编号" placeholder="PR 编号" type="number" min={1} required value={pr} onChange={event => setPr(event.target.value)} />
            <button className="ep-button" disabled={busy || entry.frozen !== version.version || !items.length}><RefreshCw />{run ? '重新运行' : '运行验收'}</button>
          </form>}
          {canSign && <button className="ep-button" type="button" disabled={busy || !signable} onClick={() => void sign()}>
            <Check />签收</button>}
        </div>
      </div>
    </section>
    <section className="dw-surface dw-delivery-card">
      <header className="dw-delivery-heading">
        <div><h3>真实页面定位</h3><p>{version.screens.filter(screen => screen.impl).length} / {version.screens.length} 个画面已绑定</p></div>
        {!runs.length && canReview && !!version.screens.length && <button className="ep-button" type="button" onClick={() => setBinding(true)}>绑定实现画面</button>}
      </header>
      {!runs.length && <p className="dw-muted">运行验收后，这里绑定的画面用于定位实拍。每条规则需要能定位到对应页面。</p>}
    </section>
    {binding && <BindImplementation version={version} preferred={params.get('screen')} busy={busy}
      close={() => setBinding(false)} bind={fields => send('implementation.bind', { version: version.version, ...fields })} />}
    {!!failures.length && <section><h3>要修的问题 <small>{failures.length}</small></h3>
      <div className="dw-issues">{failures.map(item => {
        const unmatched = run!.cells.filter(cell => cell.itemId === item.id && cell.status !== 'passed');
        const cells = unmatched.filter(cell => cell.status === 'failed');
        const evidence = cells.find(cell => cell.imageId);
        const issue = run!.issues[item.id];
        const needsLink = issue && unmatched.some(cell => cell.debtId !== issue.id);
        return <article className="dw-issue dw-surface" key={item.id}>
          <button className="dw-issue-shot" type="button" aria-label={`查看 ${item.id} 证据`} disabled={!evidence} onClick={() => setSelected(evidence)}>
            {evidence?.imageId ? <img src={designArtifact(entry.projectId, evidence.imageId)} alt={item.rule} /> : '缺少截图'}
          </button>
          <div><small>{item.id} · {ruleModes[item.how]} · {item.priority === 'high' ? '高级别' : '普通'}</small>
            <h4>{item.rule}</h4>
            <div className="dw-row">{cells.map(cell => <span className="ep-badge" key={cell.slot}>{slotNames[cell.slot]}</span>)}</div>
            <dl className="dw-details"><dt>实测</dt><dd>{cells.map(cell => cell.actual).join(' · ')}</dd><dt>期望</dt><dd>{item.expected ?? item.rule}</dd></dl>
            <div className="dw-row">
              {canWrite && !run!.signed && <button className="ep-button" disabled={busy || !!issue && !issue.pending && !needsLink} type="button"
                onClick={() => void send('acceptance.debt', { runId: run!.id, itemId: item.id })}>
                <ScrollText />{issue ? issue.pending ? '核对待确认提案' : needsLink ? '重新关联债务' : '已记债' : '记成债务'}</button>}
              {issue && !issue.pending && <Link className="ep-link" to={`/engineering-planning?project=${encodeURIComponent(entry.projectId)}&view=debts&kind=debt&item=${encodeURIComponent(issue.id)}`}>{issue.id}</Link>}
              {evidence && <button className="ep-text-button" type="button" onClick={() => setSelected(evidence)}>看证据</button>}
            </div>
          </div>
        </article>;
      })}</div>
    </section>}
    {!!pending.length && <section><h3>待补证据 <small>{pending.length}</small></h3>
      <div className="dw-surface dw-pending">{pending.map(cell => {
        const item = items.find(item => item.id === cell.itemId)!;
        return <div className="dw-pending-row" key={`${cell.itemId}-${cell.slot}`}><span className="dw-status" data-state="needs_evidence">{cellNames[cell.status]}</span>
          <div><strong>{item.rule}</strong><small>{slotNames[cell.slot]} · {cell.actual}</small></div>
          {evidenceWritable && <button type="button" className="ep-button" onClick={() => setSelected(cell)}>{item.how === 'human' ? '人工核对' : '补充证据'}</button>}
        </div>;
      })}</div>
    </section>}
    <section><h3>全部验收项 <small>{items.length}</small></h3>
      <div className="dw-surface dw-matrix" role="region" aria-label="做法验收矩阵" tabIndex={0}><table><thead><tr><th>验收项</th>{designSlots.map(slot => <th key={slot}>{slotNames[slot]}</th>)}</tr></thead>
        <tbody>{items.map(item => <tr key={item.id}><th scope="row"><code>{item.id}</code> {item.rule}</th>
          {designSlots.map(slot => {
            const cell = run?.cells.find(value => value.itemId === item.id && value.slot === slot);
            return <td key={slot}>{!item.slots.includes(slot) ? '—' : cell
              ? <button className="dw-status" data-state={cell.status} onClick={() => setSelected(cell)}>{cellNames[cell.status]}</button> : '未验证'}</td>;
          })}
        </tr>)}</tbody></table>
        {!items.length && <p>这版稿件未声明验收项。</p>}
      </div>
    </section>
    {run && selected && <DesignEvidenceDialog entry={entry} run={run} cell={selected} version={version} command={command}
      canWrite={evidenceWritable} canReview={canReview} busy={busy} close={() => setSelected(undefined)} />}
  </section>;
}

function DesignEvidenceDialog({ entry, run, cell, version, command, canWrite, canReview, busy, close }: {
  entry: DesignEntry; run: DesignRun; cell: DesignCell; version: DesignVersion; command: DesignCommand;
  canWrite: boolean; canReview: boolean; busy: boolean; close: () => void;
}) {
  const rule = version.acceptance.find(row => row.id === cell.itemId)!;
  const [actual, setActual] = useState(cell.imageId && cell.recordedBy ? cell.actual : '');
  const [file, setFile] = useState<File>();
  const [issue, setIssue] = useState('');
  const [uploading, setUploading] = useState(false);
  const [, theme] = cell.slot.split('-');
  const path = designAcceptanceTarget(version, rule, cell.slot)?.impl;
  const canSubmit = canWrite && !!path && !run.signed && (rule.how !== 'human' || canReview);
  const hasScreenshot = !!file || !!cell.imageId;
  const submit = async (status: 'passed' | 'failed') => {
    if (!hasScreenshot || !actual.trim() || !path) return;
    setUploading(true);
    setIssue('');
    try {
      let evidence: { image: string; measured: { width: number; height: number; path: string; theme: string } } | undefined;
      if (file) {
        if (file.type !== 'image/png' || file.size > 1.5 * 1024 * 1024) throw new Error('请提供 1.5 MiB 以内的 PNG 截图');
        const shot = await createImageBitmap(file);
        const { width, height } = shot;
        shot.close();
        const image = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        evidence = { image, measured: { width, height, path, theme } };
      }
      if (await command('acceptance.record', { designId: entry.id, runId: run.id, commit: run.commit,
        cells: [{ itemId: cell.itemId, slot: cell.slot, status, actual: actual.trim(), ...evidence }] })) close();
    } catch (error) { setIssue(error instanceof Error ? error.message : '无法读取截图'); }
    finally { setUploading(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open) close(); }}><DialogContent className="dw-modal dw-surface">
    <DialogTitle><FileCheck2 />{rule.id} · {slotNames[cell.slot]}</DialogTitle>
    <DialogDescription>{rule.rule}</DialogDescription>
    <p><strong>{cellNames[cell.status]}</strong> · {cell.actual}</p>
    {cell.imageId && <a href={designArtifact(entry.projectId, cell.imageId)} target="_blank" rel="noreferrer">
      <img className="dw-evidence-image" src={designArtifact(entry.projectId, cell.imageId)} alt={`${slotNames[cell.slot]}实拍`} /></a>}
    {cell.recordedBy && <p>判断人 {cell.recordedBy}</p>}
    {cell.debtId && <p>关联债务 {cell.debtId}</p>}
    {canSubmit && <form onSubmit={event => { event.preventDefault(); void submit('passed'); }}>
      <label>实测与判断依据<textarea value={actual} required maxLength={2000} onChange={event => setActual(event.target.value)} /></label>
      <label>{cell.imageId ? '替换真实页面截图' : '真实页面截图'}<input type="file" accept="image/png" required={!cell.imageId}
        onChange={event => setFile(event.target.files?.item(0) ?? undefined)} /></label>
      <p><code>{run.commit.slice(0, 8)}</code> · {path}</p>
      {issue && <p role="alert">{issue}</p>}
      <footer><button className="ep-button" type="button" disabled={busy || uploading || !hasScreenshot || !actual.trim()} onClick={() => void submit('failed')}>我看过，需要修正</button>
        <button className="ep-button ep-button--primary" type="submit" disabled={busy || uploading || !hasScreenshot || !actual.trim()}>我看过，通过</button></footer>
    </form>}
  </DialogContent></Dialog>;
}
