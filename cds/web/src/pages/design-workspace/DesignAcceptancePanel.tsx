import { useEffect, useState } from 'react';
import { Check, FileCheck2, RefreshCw, ScrollText } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { designAcceptanceTarget, designSlots, type DesignCell, type DesignEntry, type DesignRun, type DesignVersion } from '../../../../src/shared/design-workspace';
import { designVisualRequired, designVisualSummary } from '../../../../src/shared/design-visual';
import { DesignVisualAcceptance } from './DesignVisualAcceptance';
import { cellNames, designArtifact, designCheckRows, designDate, ruleModes, slotNames, verdictNames, type DesignCommand } from './design-ui';
import { planningPath, usePlanningRead } from '../engineering-planning/planning-ui';

function BindImplementation({ version, onlyUnbound, preferred, busy, close, bind }: {
  version: DesignVersion; onlyUnbound: boolean; preferred: string | null; busy: boolean; close: () => void;
  bind: (fields: Record<string, unknown>) => Promise<boolean>;
}) {
  const choices = onlyUnbound ? version.screens.filter(screen => !screen.impl) : version.screens;
  const initial = choices.find(screen => screen.id === preferred) ?? choices.find(screen => !screen.impl) ?? choices[0];
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
        {choices.map(row => <option key={row.id} value={row.id}>{row.name} · {row.viewport === 'phone' ? '手机' : '桌面'}{row.impl ? ' · 已绑定' : ''}</option>)}
      </select></label>
      <label>预览内地址<input value={path} onChange={event => setPath(event.target.value)} placeholder="/页面?参数=值" maxLength={1200} required /></label>
      <label>就绪选择器<input value={ready} onChange={event => setReady(event.target.value)} maxLength={300} placeholder="#当前画面" required /></label>
      <footer><button className="ep-button" type="button" onClick={close} disabled={busy}>取消</button>
        <button className="ep-button ep-button--primary" disabled={busy}>保存定位</button></footer>
    </form>
  </DialogContent></Dialog>;
}

export function DesignAcceptancePanel({ entry, version, busy, canWrite, canReview, canSign, command, onSetBaseline, onPreviewStale }: {
  entry: DesignEntry; version: DesignVersion; busy: boolean; canWrite: boolean; canReview: boolean; canSign: boolean;
  command: DesignCommand; onSetBaseline?: () => void; onPreviewStale: () => void;
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
  const requiresVisual = designVisualRequired(version, run);
  const visualRemaining = requiresVisual && run && !run.signed ? designVisualSummary(version, run).remaining : 0;
  const state = run?.verdict ?? 'needs_evidence';
  const activeCommit = preview.data?.projectId === entry.projectId ? preview.data.commit : undefined;
  const linkedChanged = !!run && run.pullRequest !== entry.pullRequest;
  const stale = !!run && (linkedChanged || (!!activeCommit && activeCommit !== run.commit));
  const staleSignature = stale && !!run && entry.currentSignoffRunId === run.id;
  useEffect(() => { if (staleSignature) onPreviewStale(); }, [staleSignature, onPreviewStale]);
  const evidenceWritable = canWrite && !!run && !run.signed && !stale && activeCommit === run.commit && !preview.loading;
  const signable = run && !run.signed && !visualRemaining && entry.frozen === version.version && run.id === entry.runs.at(-1)?.id
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
  const isBaseline = entry.frozen === version.version;
  const bound = version.screens.filter(screen => screen.impl).length;
  const canBindMissing = requiresVisual && runs.length > 0 && !runs.some(row => row.signed) && version.screens.some(screen => !screen.impl);
  const visualWritable = evidenceWritable && isBaseline && run?.id === entry.runs.at(-1)?.id;
  const verdictWord = linkedChanged ? '针对旧 PR' : stale ? '针对旧提交' : run?.signed ? '已签收' : run ? verdictNames[state] : '还没开始';
  const lead = linkedChanged ? '关联的 PR 已经换了，这次结果只针对旧 PR。请对当前 PR 重新运行。'
    : stale ? `预览已经更新到 ${activeCommit?.slice(0, 8)}，这次结果只针对旧提交。请重新运行。`
    : run?.signed ? `已按 V${version.version} 签收（${designDate(run.signed.at)}）。`
    : !isBaseline ? `正式验收使用登记的实施基线${entry.frozen === undefined ? '。当前尚未定稿。' : ` V${entry.frozen}。当前查看 V${version.version}。`}`
    : visualRemaining ? `还有 ${visualRemaining} 行逐画面对照待处理。`
    : run ? (failures.length || pending.length ? `还差 ${[failures.length ? `${failures.length} 项要修` : '', pending.length ? `${pending.length} 处待补证据` : ''].filter(Boolean).join('、')}。`
      : state === 'conditional' ? '已有附条件的验收结果，请查看关联债务。' : state === 'passed' ? '所有验收项已通过。' : '还需补齐验收证据。')
    : '尚无真实页面验收证据。用关联 PR 的预览运行验收。';
  type Step = { key: string; title: string; detail: string; done: boolean; action?: JSX.Element };
  const steps: Step[] = [
    { key: 'baseline', title: '定为实施基线', done: isBaseline,
      detail: isBaseline ? `V${version.version} 是实施基线` : entry.frozen === undefined
        ? '请有权评审人选择正式对照稿。' : `登记基线 V${entry.frozen}，当前查看 V${version.version}。`,
      action: !isBaseline && onSetBaseline ? <button type="button" className="ep-button" onClick={onSetBaseline}>定为实施基线</button>
        : !isBaseline && entry.frozen !== undefined ? <Link className="ep-button" to={`/design?${new URLSearchParams({ project: entry.projectId, design: entry.id, version: String(entry.frozen), tab: 'accept' })}`}>打开基线 V{entry.frozen} 的验收</Link> : undefined },
    { key: 'bind', title: '绑定实现画面', done: bound === version.screens.length || !requiresVisual && (bound > 0 || runs.length > 0),
      detail: canBindMissing ? `${bound}/${version.screens.length} 个画面已绑定；可以补充未绑定的画面`
        : runs.length && bound < version.screens.length ? `${bound}/${version.screens.length} 个画面已绑定；运行后不能再改，没绑的画面会缺证据` : `${bound}/${version.screens.length} 个画面已绑定预览内地址；实拍时进入该画面的目标状态`,
      action: canReview && !!version.screens.length && (!runs.length || canBindMissing) ? <button className="ep-button" type="button" onClick={() => setBinding(true)}>绑定实现画面</button> : undefined },
    { key: 'run', title: run ? '重新运行验收' : '运行验收', done: !!run && !stale,
      detail: run ? `PR #${run.pullRequest} · 提交 ${run.commit.slice(0, 8)} · ${designDate(run.createdAt)}` : '填写关联 PR 编号，用它的预览逐条实拍',
      action: canWrite ? <form className="dw-row" onSubmit={event => { event.preventDefault(); void start(); }}>
        <input aria-label="关联 PR 编号" placeholder="PR 编号" type="number" min={1} required value={pr} onChange={event => setPr(event.target.value)} />
        <button className="ep-button" disabled={busy || !isBaseline || !items.length}><RefreshCw />{run ? '重新运行' : '运行验收'}</button>
      </form> : undefined },
    { key: 'fix', title: '修问题、补证据', done: !!run && !failures.length && !pending.length && !visualRemaining,
      detail: visualRemaining ? `逐画面对照还有 ${visualRemaining} 行待处理`
        : run ? (failures.length || pending.length ? `${failures.length} 项要修，${pending.length} 处待补证据` : '没有要修的') : '运行后才知道' },
    { key: 'sign', title: '签收', done: !!run?.signed,
      detail: run?.signed ? `签收于 ${designDate(run.signed.at)}`
        : requiresVisual ? '稿件验收项达到签收条件，逐画面对照通过后签收' : '全部通过或有条件通过后签收',
      action: canSign ? <button className="ep-button" type="button" disabled={busy || !signable} onClick={() => void sign()}><Check />签收</button> : undefined },
  ];
  const current = steps.findIndex(step => !step.done);
  const statusOf = (itemId: string) => {
    const cells = run?.cells.filter(cell => cell.itemId === itemId) ?? [];
    if (cells.some(cell => cell.status === 'failed')) return 'failed';
    if (cells.some(cell => (cell.status === 'missing' || cell.status === 'unverified') && !cell.debtId)) return 'missing';
    if (cells.length && cells.every(cell => cell.status === 'passed')) return 'passed';
    if (cells.some(cell => cell.debtId)) return 'debt';
    return 'unverified';
  };
  const groups = ([['failed', '不通过'], ['missing', '待补证据'], ['debt', '已记债'], ['unverified', '未验证'], ['passed', '通过']] as const)
    .map(([key, label]) => [key, label, items.filter(item => statusOf(item.id) === key)] as const).filter(([, , list]) => list.length);
  const selfChecks = designCheckRows(version);
  const selfFailed = selfChecks.filter(row => row.status !== '通过');
  const origins = new Map<string, typeof version.screens>();
  for (const screen of version.screens) { const key = `${screen.viewport}:${screen.route}`; origins.set(key, [...(origins.get(key) ?? []), screen]); }
  const shared = [...origins.values()].filter(list => list.length > 1);
  const visualNumber = Number(version.screens.length > 0);
  const ruleNumber = 3 + visualNumber + Number(failures.length > 0) + Number(pending.length > 0);
  return <section className="dw-acceptance dw-ac">
    <ol className="dw-dl-items dw-surface dw-ac-items">
      <li data-item="verdict"><h4><b>1</b>结论</h4>
        <p className="dw-dl-lead-text"><span className="dw-status" data-state={stale ? 'needs_evidence' : run?.signed ? 'passed' : run ? state : 'draft'}>{verdictWord}</span> {lead}</p>
        <p className="dw-dl-factline">
          {!isBaseline && onSetBaseline && entry.frozen !== undefined &&
            <Link className="ep-link" to={`/design?${new URLSearchParams({ project: entry.projectId, design: entry.id, version: String(entry.frozen), tab: 'accept' })}`}>查看基线 V{entry.frozen} 的验收</Link>}
          {run && counts.filter(([, count]) => count > 0).map(([label, count]) => <span key={label} data-status={label}>{label} {count}</span>)}
          {run && <a className="ep-link" href={run.previewUrl} target="_blank" rel="noreferrer">打开真实预览</a>}
          {runs.length > 1 && <select aria-label="查看历史运行" value={run?.id ?? ''} onChange={event => setRunId(event.target.value)}>
            {[...runs].reverse().map(row => <option key={row.id} value={row.id}>{row.commit.slice(0, 8)}{row.signed ? row.id === runs.at(-1)?.id ? ' · 已签收' : ' · 历史签收' : ' · ' + verdictNames[row.verdict]}</option>)}
          </select>}
        </p>
        {run && !run.signed && !stale && (preview.loading ? <ContentLoading label="核对当前预览提交" variant="inline" className="dw-dl-missing" />
          : !activeCommit ? <p className="dw-dl-missing" role="status">暂时无法核对当前预览提交，请确认预览已部署；核对上之前不能补证据、不能签收。</p> : null)}</li>
      <li data-item="steps"><h4><b>2</b>下一步</h4>
        <ol className="dw-ac-steps">{steps.map((step, index) => <li key={step.key} data-state={step.done ? 'done' : index === current ? 'current' : 'later'}>
          <span className="dw-ac-step-mark">{step.done ? <Check /> : index + 1}</span>
          <div><strong>{step.title}</strong><small>{step.detail}</small>
            {step.key === 'bind' && !!version.screens.length && <details className="dw-ac-screens" open={(index === current && bound < version.screens.length) || undefined}><summary>画面和实现地址 {version.screens.length}</summary>
              <ul>{version.screens.map(screen => <li key={screen.id}><span><Link className="ep-link" to={`/design?${new URLSearchParams({ project: entry.projectId, design: entry.id, version: String(version.version), tab: 'preview', screen: screen.id })}`}>{screen.name}</Link><small> · {screen.viewport === 'phone' ? '手机' : '桌面'}</small></span>
                <code>{screen.route}</code><span>{screen.impl ? <code>{screen.impl}</code> : <em>未绑定</em>}</span></li>)}</ul></details>}</div>
          {index === current && step.action ? <div className="dw-ac-step-action" data-primary>{step.action}</div>
            : step.done ? ((step.key === 'run' || step.key === 'bind' && bound < version.screens.length) && step.action
              ? <div className="dw-ac-step-action">{step.action}</div> : null)
            : current >= 0 && index > current && step.action ? <small className="dw-ac-step-wait">先完成第 {current + 1} 步</small> : null}
        </li>)}</ol></li>
      {!!version.screens.length && <li data-item="screens"><h4><b>3</b>逐画面对照
        <small>{requiresVisual ? '缺实拍或缺证据的画面需补齐后签收' : '选择画面查看同条件下的两张截图'}</small></h4>
        <DesignVisualAcceptance key={version.version} entry={entry} version={version} run={run} busy={busy} writable={visualWritable}
          command={command} onRule={setSelected} />
      </li>}
      {!!failures.length && <li data-item="fix"><h4><b>{3 + visualNumber}</b>要修的问题<small>{failures.length} 项 · 修复后重跑，或把普通问题记成债务</small></h4>
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
        })}</div></li>}
      {!!pending.length && <li data-item="evidence"><h4><b>{3 + visualNumber + Number(failures.length > 0)}</b>待补证据<small>{pending.length} 处 · 上传实拍并写判断依据</small></h4>
        <div className="dw-pending">{pending.map(cell => {
          const item = items.find(row => row.id === cell.itemId)!;
          return <div className="dw-pending-row" key={`${cell.itemId}-${cell.slot}`}><span className="dw-status" data-state="needs_evidence">{cellNames[cell.status]}</span>
            <div><strong><code>{item.id}</code> {item.rule}</strong><small>{slotNames[cell.slot]} · {cell.actual}</small></div>
            {evidenceWritable && <button type="button" className="ep-button" onClick={() => setSelected(cell)}>{item.how === 'human' ? '人工核对' : '补充证据'}</button>}
          </div>;
        })}</div></li>}
      <li data-item="rules"><h4><b>{ruleNumber}</b>全部验收项<small>{items.length} 条 · 按状态分组</small></h4>
        {!items.length && <p className="dw-dl-missing">这版稿件未声明验收项。</p>}
        {groups.map(([key, label, list]) => <details key={key} className="dw-dl-rulegroup" open={key === 'failed' || key === 'missing' || undefined}>
          <summary><span className="dw-status" data-state={key === 'missing' ? 'needs_evidence' : key === 'unverified' ? 'draft' : key}>{label}</span> <small>{list.length}</small></summary>
          <ul className="dw-dl-rules">{list.map(item => <li key={item.id}><code>{item.id}</code><span><strong>{item.rule}</strong>
            <small>{ruleModes[item.how]}{item.priority === 'high' ? ' · 高级别' : ''}{item.expected ? ` · 预期：${item.expected}` : ''}</small>
            <span className="dw-ac-slots">{designSlots.filter(slot => item.slots.includes(slot)).map(slot => {
              const cell = run?.cells.find(value => value.itemId === item.id && value.slot === slot);
              return cell ? <button key={slot} type="button" className="dw-status" data-state={cell.status} onClick={() => setSelected(cell)}>{slotNames[slot]} · {cellNames[cell.status]}</button>
                : <span key={slot} className="dw-ac-slot">{slotNames[slot]}</span>;
            })}</span></span></li>)}</ul>
        </details>)}</li>
      {(shared.length > 0 || selfChecks.length > 0 || version.checks) && <li data-item="more"><h4><b>{ruleNumber + 1}</b>原型检查</h4>
        {!selfChecks.length && version.checks && <p className="dw-dl-factline">
          <span>作者自检{typeof version.checks.passed === 'number' && typeof version.checks.total === 'number'
            ? ` ${version.checks.passed}/${version.checks.total}` : ''}（未附明细）</span>
        </p>}
        {selfChecks.length > 0 && <details className="dw-dl-rulegroup"><summary>作者自检 <small>{selfChecks.length - selfFailed.length}/{selfChecks.length} 通过 · 作者发布时自己记录的，不是稿件状态</small></summary>
          <ul className="dw-dl-plain">{[...selfFailed, ...selfChecks.filter(row => row.status === '通过')].map((row, index) => <li key={`${row.id}/${index}`}>{row.name} <small>· {row.status}</small></li>)}</ul></details>}
        {shared.length > 0 && <details className="dw-dl-rulegroup"><summary>共用原型入口的画面 <small>{shared.length} 组</small></summary>
          <ul className="dw-dl-plain">{shared.map(items => <li key={items[0].id}>{items.map(screen => screen.name).join('、')} <code>{items[0].route}</code> · 在画布内切换状态</li>)}</ul></details>}</li>}
    </ol>
    {binding && <BindImplementation version={version} onlyUnbound={runs.length > 0} preferred={params.get('screen')} busy={busy}
      close={() => setBinding(false)} bind={fields => send('implementation.bind', { version: version.version, ...fields })} />}
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
