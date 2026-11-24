import { useEffect, useState } from 'react';
import { Check, FileCheck2, RefreshCw, ScrollText } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { designAcceptanceTarget, designDemoImplementationPath, designProgramEvidenceRequired, designSlots, type DesignCell, type DesignEntry, type DesignRequirement, type DesignRun, type DesignVersion } from '../../../../src/shared/design-workspace';
import { designProgramStatus, designVisualKey, designVisualRequired, designVisualSlots, designVisualSummary } from '../../../../src/shared/design-visual';
import { designMethodPlanEnabled, designMethodsState, designRuleApplicable, type DesignMethodStatus } from '../../../../src/shared/design-methods';
import { AcceptanceMethodDetails, AcceptanceMethodIntro, AcceptanceMethodOverview, AcceptanceMethodTabs,
  type AcceptanceCheck } from './DesignAcceptanceMethods';
import { AcceptanceScreens, AcceptanceTrace, EvidenceCauses, HistoricalAcceptance, ObjectiveCoverage, ObjectiveMethodIntro,
  ObjectiveMethodTable, acceptanceImpact, groupEvidence, type OpenAcceptance, type RuleStatus } from './DesignAcceptanceObjective';
import { needTrace } from './DesignNeed';
import { DesignVisualAcceptance } from './DesignVisualAcceptance';
import { DesignAcceptanceVideo } from './DesignAcceptanceVideo';
import { DesignAcceptanceAnimation, videoChapters } from './DesignAcceptanceAnimation';
import { cellNames, designArtifact, designCheckRows, designDate, designPath, ruleModes, slotNames, verdictNames, type DesignCommand } from './design-ui';
import { planningPath, usePlanningRead } from '../engineering-planning/planning-ui';
import './design-v17-acceptance.css';

function BindImplementation({ choices, preferred, busy, close, bind }: {
  choices: DesignVersion['screens']; preferred: string | null; busy: boolean; close: () => void;
  bind: (fields: Record<string, unknown>) => Promise<boolean>;
}) {
  const initial = choices.find(screen => screen.id === preferred) ?? choices.find(screen => !screen.impl) ?? choices[0];
  const [screenId, selectScreen] = useState(initial.id);
  const [path, setPath] = useState(initial.impl ?? '');
  const [ready, setReady] = useState(initial.readySelector ?? '');
  const select = (id: string) => {
    const screen = choices.find(row => row.id === id);
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

export function DesignAcceptancePanel({ entry, version, busy, canWrite, canReview, canSign, command, onSetBaseline, onPreviewStale, requirement, onOpen, installedAcceptance, actorId }: {
  entry: DesignEntry; version: DesignVersion; busy: boolean; canWrite: boolean; canReview: boolean; canSign: boolean;
  command: DesignCommand; onSetBaseline?: () => void; onPreviewStale: () => void;
  requirement?: DesignRequirement; onOpen?: OpenAcceptance; installedAcceptance?: boolean; actorId?: string;
}) {
  const [params, setParams] = useSearchParams();
  const [runId, setRunId] = useState(params.get('run') ?? '');
  const [pr, setPr] = useState(String(entry.pullRequest ?? ''));
  const [selected, setSelected] = useState<DesignCell>();
  const [binding, setBinding] = useState(false);
  const [disableReason, setDisableReason] = useState('');
  const [previewRevision, refreshPreview] = useState(0);
  const runs = entry.runs.filter(row => row.version === version.version);
  const run = runs.find(row => row.id === runId) ?? runs.at(-1);
  const installed = run?.target === 'installed';
  const [source, chooseSource] = useState(installedAcceptance && (installed || !entry.pullRequest) ? 'installed' : 'preview');
  const targetInstalled = installedAcceptance && source === 'installed';
  const previewPath = installed ? `${designPath(entry.projectId)}/installed` : run ? `${planningPath(entry.projectId)}/preview/${run.pullRequest}` : null;
  const preview = usePlanningRead<{ projectId: string; commit?: string; url?: string }>(previewPath, previewRevision);
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
  const applicableItems = items.filter(item => designRuleApplicable(version, item, entry, run));
  const applicableIds = new Set(applicableItems.map(item => item.id));
  const cells = run?.cells.filter(cell => applicableIds.has(cell.itemId)) ?? [];
  const failures = applicableItems.filter(item => cells.some(cell => cell.itemId === item.id && cell.status === 'failed'));
  const pending = cells.filter(cell => (cell.status === 'missing' || cell.status === 'unverified') && !cell.debtId);
  const counts = [
    ['通过', cells.filter(cell => cell.status === 'passed').length],
    ['不通过', cells.filter(cell => cell.status === 'failed').length],
    ['待补证据', pending.length],
    ['已记债', new Set(cells.flatMap(cell => cell.debtId ? [cell.debtId] : [])).size],
  ] as const;
  const methodData = designMethodPlanEnabled(version) ? designMethodsState(version, run, entry) : undefined;
  const objective = methodData?.objective === true;
  const structuredOverview = Boolean(methodData || version.goals?.length);
  const programRequired = designProgramEvidenceRequired(version);
  const proof = designProgramStatus(version, run);
  const activeMethod = methodData?.methods.find(method => method.id === params.get('check'));
  const methodOpen = activeMethod?.status !== 'not_applicable' && activeMethod?.status !== 'disabled';
  const check: AcceptanceCheck = activeMethod?.id ?? 'overview';
  const video = version.videos?.find(item => item.page === 'accept');
  const animation = programRequired && methodData
    ? videoChapters(methodData.methods.map(method => ({ key: method.id, name: method.name }))) : [];
  const hasDemo = Boolean(video || animation.length);
  const go = (next: AcceptanceCheck) => setParams(former => {
    const value = new URLSearchParams(former);
    if (next === 'overview') value.delete('check');
    else value.set('check', next);
    if (next !== check) {
      value.delete('demo');
      value.delete('compare-screen');
      if (value.get('panel') === 'disable-method') value.delete('panel');
    }
    return value;
  });
  const toggleDemo = (show: boolean) => setParams(former => {
    const value = new URLSearchParams(former);
    if (show && activeMethod) value.set('demo', activeMethod.id);
    else value.delete('demo');
    return value;
  }, { replace: !show });
  const showOverview = check === 'overview';
  const showRules = !methodData || check === 'mece' && methodOpen;
  const comparisonSkipped = methodData?.methods.some(method => method.id === 'compare' && (method.status === 'not_applicable' || method.status === 'disabled'));
  const visualOnly = comparisonSkipped === true && check === 'visual' && methodOpen;
  const showComparison = version.screens.length > 0 && (!methodData || visualOnly || check === 'compare' && (methodOpen || programRequired));
  const blockers = methodData?.blockers ?? [];
  const requiresVisual = programRequired || !methodData && designVisualRequired(version, run);
  const visualRemaining = requiresVisual && run && !run.signed ? designVisualSummary(version, run).remaining : 0;
  const recordedState = run?.verdict ?? 'needs_evidence';
  const state = run?.signed ? recordedState
    : blockers.some(method => method.status === 'failed') ? 'failed'
      : blockers.length && recordedState !== 'failed' ? 'needs_evidence' : recordedState;
  const activeCommit = preview.data?.projectId === entry.projectId ? preview.data.commit : undefined;
  const linkedChanged = !!run && !installed && run.pullRequest !== entry.pullRequest;
  const locationChanged = !!run && preview.data?.projectId === entry.projectId && Boolean(preview.data.url && preview.data.url !== run.previewUrl);
  const stale = !!run && (linkedChanged || locationChanged || (!!activeCommit && activeCommit !== run.commit));
  const staleSignature = stale && !!run && entry.currentSignoffRunId === run.id;
  useEffect(() => { if (staleSignature) onPreviewStale(); }, [staleSignature, onPreviewStale]);
  const isBaseline = entry.frozen === version.version;
  const canSetMethods = canReview && isBaseline && !run?.signed;
  const setDisablePanel = (open: boolean) => {
    setDisableReason('');
    setParams(former => {
      const value = new URLSearchParams(former);
      if (open) value.set('panel', 'disable-method');
      else value.delete('panel');
      return value;
    }, { replace: !open });
  };
  const methodToDisable = params.get('panel') === 'disable-method' && canSetMethods && methodOpen ? activeMethod : undefined;
  const upgradeMatched = entry.upgrade?.status !== 'active' || (entry.upgrade.targetVersion === version.version && run?.upgradeId === entry.upgrade.id);
  const latestRun = run?.id === entry.runs.at(-1)?.id;
  const activeRun = !!run && !run.signed && isBaseline && latestRun && upgradeMatched && !stale && activeCommit === run.commit && !preview.loading;
  const evidenceWritable = canWrite && activeRun && !programRequired;
  const signable = run && !run.signed && !visualRemaining && !blockers.length && isBaseline && latestRun && upgradeMatched
    && !stale && activeCommit === run.commit && !preview.loading
    && (!programRequired || !proof.invalid && proof.total > 0 && proof.reviewed === proof.total && state === 'passed')
    && (state === 'passed' || state === 'conditional');
  const send = (action: string, fields: Record<string, unknown>) => command(action, { designId: entry.id, ...fields });
  const sendEvidence = (action: string, fields: Record<string, unknown>) => run
    ? send(action, { runId: run.id, commit: run.commit, ...fields }) : Promise.resolve(false);
  const start = async () => {
    if (await send('acceptance.start', { version: version.version, ...(targetInstalled ? { target: 'installed' } : { pullRequest: Number(pr) }) })) {
      setRunId('');
      refreshPreview(value => value + 1);
    }
  };
  const sign = async () => {
    if (run && !(await send('acceptance.sign', { runId: run.id }))) refreshPreview(value => value + 1);
  };
  const allBindingsRequired = requiresVisual || methodData?.required.some(method => method.id === 'compare' || method.id === 'visual');
  const workDone = !!run && (state === 'passed' || state === 'conditional') && !visualRemaining && !blockers.length;
  const bound = version.screens.filter(screen => screen.impl).length;
  const demoReady = programRequired ? version.screens.filter(screen => !screen.impl && designDemoImplementationPath(screen)).length : 0;
  const located = bound + demoReady;
  const bindingSummary = `${bound}/${version.screens.length} 个真实入口已绑定${demoReady ? `，${demoReady} 个可用演示数据进入` : ''}`;
  const latestEvidence = runs.at(-1)?.programEvidence;
  const bindingChoices = runs.length ? version.screens.filter(screen => !screen.impl
    && !designVisualSlots(screen).some(slot => latestEvidence?.[designVisualKey(screen.id, slot)])) : version.screens;
  const canBindMissing = (requiresVisual || methodData) && runs.length > 0 && !runs.some(row => row.signed) && bindingChoices.length > 0;
  const visualWritable = evidenceWritable && isBaseline && run?.id === entry.runs.at(-1)?.id;
  const verdictWord = linkedChanged ? '针对旧 PR' : locationChanged ? '针对旧预览' : stale ? '针对旧提交' : run?.signed ? '已签收' : run ? verdictNames[state] : '还没开始';
  const lead = linkedChanged ? '关联的 PR 已经换了，这次结果只针对旧 PR。请对当前 PR 重新运行。'
    : locationChanged ? '预览地址已经变化，这次证据对应原预览。请重新运行。'
    : stale ? `预览已经更新到 ${activeCommit?.slice(0, 8)}，这次结果只针对旧提交。请重新运行。`
    : run?.signed ? `已按 V${version.version} 签收（${designDate(run.signed.at)}）。`
    : !isBaseline ? `正式验收使用登记的实施基线${entry.frozen === undefined ? '。当前尚未定稿。' : ` V${entry.frozen}。当前查看 V${version.version}。`}`
    : run && blockers.length ? `还有 ${blockers.length} 个已启用的验收手段待通过。`
    : visualRemaining ? `还有 ${visualRemaining} 行逐画面对照待处理。`
    : run && state === 'conditional' ? '已有附条件的验收结果。可查看关联债务。'
    : run ? (failures.length || pending.length ? `还差 ${[failures.length ? `${failures.length} 项要修` : '', pending.length ? `${pending.length} 处待补证据` : ''].filter(Boolean).join('、')}。`
      : state === 'passed' ? '所有验收项已通过。' : '还需补齐验收证据。')
    : `尚无真实页面验收证据。${installedAcceptance ? '可选择主用 CDS 运行验收。' : '用关联 PR 的预览运行验收。'}`;
  const pendingGroups = structuredOverview ? groupEvidence(pending) : [];
  const pendingText = [...new Set(pending.map(cell => cell.itemId))].length;
  const methodProgress = blockers.map(method => `${method.name}${method.progress?.total ? ` ${method.progress.done}/${method.progress.total}` : ''}`);
  type Step = { key: string; title: string; detail: string; done: boolean; action?: JSX.Element };
  const steps: Step[] = [
    { key: 'baseline', title: '定为实施基线', done: isBaseline,
      detail: isBaseline ? `V${version.version} 是实施基线` : entry.frozen === undefined
        ? '请有权评审人选择正式对照稿。' : `登记基线 V${entry.frozen}，当前查看 V${version.version}。`,
      action: !isBaseline && onSetBaseline ? <button type="button" className="ep-button" onClick={onSetBaseline}>定为实施基线</button>
        : !isBaseline && entry.frozen !== undefined ? <Link className="ep-button" to={`/design?${new URLSearchParams({ project: entry.projectId, design: entry.id, version: String(entry.frozen), tab: 'accept' })}`}>打开基线 V{entry.frozen} 的验收</Link> : undefined },
    { key: 'bind', title: '绑定实现画面', done: located === version.screens.length || !allBindingsRequired && (!items.length || located > 0 || runs.length > 0),
      detail: programRequired ? bindingSummary : canBindMissing ? `${bound}/${version.screens.length} 个画面已绑定；可以补充未绑定的画面`
        : runs.length && bound < version.screens.length ? `${bound}/${version.screens.length} 个画面已绑定；运行后不能再改，没绑的画面会缺证据` : `${bound}/${version.screens.length} 个画面已绑定预览内地址；实拍时进入该画面的目标状态`,
      action: canReview && !!version.screens.length && (!runs.length || canBindMissing) ? <button className="ep-button" type="button" onClick={() => setBinding(true)}>绑定实现画面</button> : undefined },
    { key: 'run', title: run ? '重新运行验收' : '运行验收', done: !!run && !stale && upgradeMatched,
      detail: run ? `${installed ? '主用 CDS' : `PR #${run.pullRequest}`} · 提交 ${run.commit.slice(0, 8)} · ${designDate(run.createdAt)}`
        : targetInstalled ? '使用主用正在服务的 CDS 提交记录实拍与结果' : '填写关联 PR 编号，用它的预览逐条实拍',
      action: canWrite ? <form className="dw-row" onSubmit={event => { event.preventDefault(); void start(); }}>
        {installedAcceptance && <select aria-label="验收环境" value={source} onChange={event => chooseSource(event.target.value)}>
          <option value="installed">主用 CDS</option><option value="preview">PR 预览</option></select>}
        {!targetInstalled && <input aria-label="关联 PR 编号" placeholder="PR 编号" type="number" min={1} required value={pr} onChange={event => setPr(event.target.value)} />}
        <button className="ep-button" disabled={busy || !isBaseline || !items.length && !methodData}><RefreshCw />{run ? '重新运行' : '运行验收'}</button>
      </form> : undefined },
    { key: 'fix', title: '修问题、补证据', done: workDone,
      detail: workDone ? state === 'conditional' ? '有条件通过，相关问题已记债' : '验收证据已齐'
        : run && blockers.length ? blockers.map(method => method.name).join('、') + '待通过'
        : visualRemaining ? `逐画面对照还有 ${visualRemaining} 行待处理`
        : run && state === 'conditional' ? '已有附条件的验收结果。可查看关联债务。'
    : run ? (failures.length || pending.length ? `${failures.length} 项要修，${pending.length} 处待补证据` : '还有证据待补') : '运行后才知道' },
    { key: 'sign', title: '签收', done: !!run?.signed,
      detail: run?.signed ? `签收于 ${designDate(run.signed.at)}`
        : objective && (pending.length || failures.length || methodProgress.length) ? `还差 ${[
          failures.length ? `修 ${failures.length} 项` : '', pending.length ? `补 ${pending.length} 处证据` : '', ...methodProgress,
        ].filter(Boolean).join('、')}`
        : methodData ? '所有适用手段通过，稿件验收项达到签收条件后可签收'
          : requiresVisual ? '稿件验收项达到签收条件，逐画面对照通过后签收' : '全部通过或有条件通过后签收',
      action: canSign ? <button className="ep-button" type="button" disabled={busy || !signable} onClick={() => void sign()}><Check />签收</button> : undefined },
  ];
  const current = steps.findIndex(step => !step.done);
  const statusOf = (itemId: string): RuleStatus => {
    const evidence = cells.filter(cell => cell.itemId === itemId);
    const slots = items.find(item => item.id === itemId)?.slots ?? [];
    if (evidence.some(cell => cell.status === 'failed')) return 'failed';
    if (evidence.some(cell => (cell.status === 'missing' || cell.status === 'unverified') && !cell.debtId)) return 'missing';
    if (slots.length && slots.every(slot => evidence.some(cell => cell.slot === slot && cell.status === 'passed'))) return 'passed';
    if (evidence.some(cell => cell.debtId)) return 'debt';
    return 'unverified';
  };
  const goalStatus = { elsewhere: '在别处', failed: '未达成', passed: '已达成', missing: '待证据' };
  const goalRows = (version.goals ?? []).map(goal => {
    const status = goal.items.map(statusOf);
    const state: keyof typeof goalStatus = !status.length ? 'elsewhere' : status.includes('failed') ? 'failed'
      : status.every(value => value === 'passed') ? 'passed' : 'missing';
    return { ...goal, state };
  });
  const handoff = version.delivery?.files.find(file => file.path === '交接清单.md');
  const groups = ([['failed', '不通过'], ['missing', '待补证据'], ['debt', '已记债'], ['unverified', '未验证'], ['passed', '通过']] as const)
    .map(([key, label]) => [key, label, items.filter(item => statusOf(item.id) === key)] as const).filter(([, , list]) => list.length);
  const selfChecks = designCheckRows(version);
  const selfFailed = selfChecks.filter(row => row.status !== '通过');
  const origins = new Map<string, typeof version.screens>();
  for (const screen of version.screens) { const key = `${screen.viewport}:${screen.route}`; origins.set(key, [...(origins.get(key) ?? []), screen]); }
  const shared = [...origins.values()].filter(list => list.length > 1);
  const visualNumber = Number(showComparison && !methodData);
  const issueNumber = structuredOverview ? 6 + Number(hasDemo) : 3 + visualNumber;
  const ruleNumber = objective ? 4 : methodData ? 3 : issueNumber + Number(failures.length > 0) + Number(pending.length > 0);
  const moreNumber = methodData ? issueNumber + Number(failures.length > 0) + Number(pending.length > 0) : ruleNumber + 1;
  const overall: DesignMethodStatus = !run ? 'notrun' : stale ? 'missing'
    : state === 'failed' ? 'failed' : state === 'needs_evidence' ? 'missing' : 'passed';
  const jump = (anchor: string) => document.getElementById(anchor)?.scrollIntoView({ block: 'start' });
  const previewBlocked = !!run && !run.signed && !stale && !preview.loading && !activeCommit;
  const blockingFailure = failures.filter(rule => rule.priority === 'high' || cells.some(cell => cell.itemId === rule.id && cell.status === 'failed' && !cell.debtId));
  const gaps = structuredOverview && showOverview ? needTrace(entry, version, requirement, run) : undefined;
  type Cause = Parameters<typeof EvidenceCauses>[0]['causes'][number];
  const causes: Cause[] = [];
  if (structuredOverview && showOverview && !run?.signed) {
    if (run && (stale || previewBlocked || !upgradeMatched || programRequired && proof.invalid)) causes.push({ key: 'preview', tone: 'block', who: '实现方',
      title: programRequired && proof.invalidProvenance ? '图证来源核对失败，本次作废'
        : programRequired && proof.invalid ? '独立复验有差异，本次作废' : linkedChanged ? '关联的 PR 已变更' : locationChanged ? '预览地址已变更' : stale ? `预览已更新到 ${activeCommit?.slice(0, 8)}`
        : previewBlocked ? '预览提交没核对上' : '运行早于当前升级目标',
      detail: `当前运行的证据和签收暂不可用${pending.length ? `，挡住 ${pending.length} 处待补证据` : ''}。`,
      action: previewBlocked ? <a className="ep-button" href={run.previewUrl} target="_blank" rel="noreferrer">打开真实预览</a>
        : <button className="ep-button" type="button" onClick={() => jump('dw-ac-steps')}>重新运行</button> });
    else if (!isBaseline) causes.push({ key: 'baseline', tone: 'block', title: '当前稿件未定为实施基线', who: '项目评审人',
      detail: '选定要验收的实施目标后，才能运行并签收这一版。', action: <button className="ep-button" type="button" onClick={() => jump('dw-ac-steps')}>看实施基线</button> });
    else if (!run) causes.push({ key: 'start', tone: 'block', title: '还没有真实预览的验收运行', who: '实现方',
      detail: bindingSummary + '。运行验收时会锁定提交。',
      action: <button className="ep-button" type="button" onClick={() => jump('dw-ac-steps')}>{located < version.screens.length ? '绑定实现画面' : '开始运行'}</button> });
    if (blockingFailure.length) causes.push({ key: 'fail', tone: 'fail', title: `${blockingFailure.length} 项不通过`, who: '实现方',
      detail: `${blockingFailure.map(rule => rule.id).join('、')}${acceptanceImpact(blockingFailure, version) ? ` · 影响 ${acceptanceImpact(blockingFailure, version)}` : ''}`,
      action: <button className="ep-button" type="button" onClick={() => jump('dw-ac-fix')}>看不通过的项</button> });
    for (const category of ['evidence', 'demo', 'conflict']) {
      const group = pendingGroups.find(([key]) => key === category)?.[1];
      if (!group?.length) continue;
      const total = new Set(group.map(cell => cell.itemId)).size;
      const title = category === 'demo' ? `${total} 项要用演示数据补`
        : category === 'conflict' ? `${total} 处规则冲突` : `${total} 项缺实拍或对照`;
      const label = category === 'demo' ? '用演示数据截' : category === 'conflict' ? '看冲突' : '补证据';
      causes.push({ key: category, tone: 'missing', title, who: category === 'conflict' ? '设计方' : '实现方',
        detail: <ul>{group.map(cell => <li key={`${cell.itemId}/${cell.slot}`}>{cell.itemId} · {slotNames[cell.slot]} · {cell.actual}</li>)}</ul>,
        action: <button className="ep-button" type="button" onClick={() =>
          category === 'conflict' ? jump('dw-ac-evidence') : go('compare')}>{label}</button> });
    }
    if (blockers.length || gaps?.gaps || programRequired && run && proof.reviewed < proof.total) {
      const nextMethod = blockers[0];
      const missingReview = programRequired && proof.captured === proof.total && proof.reviewed < proof.total;
      causes.push({ key: 'methods', tone: 'open', who: missingReview || !nextMethod ? '设计方' : nextMethod.id === 'human' ? '评审人' : '实现方',
        title: missingReview ? `${proof.total - proof.reviewed} 处待设计方复验` : nextMethod ? `${blockers.length} 个验收手段没做完` : '需求条款待关联',
        detail: [methodProgress.join(' · '), gaps?.gaps ? `${gaps.gaps} 条需求没有关联验收项` : ''].filter(Boolean).join(' · '),
        action: <button className="ep-button" type="button" onClick={() =>
          missingReview ? go('compare') : nextMethod ? go(nextMethod.id) : onOpen ? onOpen('need') : jump('dw-ac-steps')}>
          {missingReview ? '看复验清单' : nextMethod ? '做下一个手段' : '看需求'}</button> });
    }
  }
  return <section className="dw-acceptance dw-ac" data-objective={objective || undefined}>
    {methodData && <AcceptanceMethodTabs active={check} methods={methodData.methods} overall={overall} objective={objective} go={go} />}
    <div id={methodData ? 'dw-ac-method-panel' : undefined} role={methodData ? 'tabpanel' : undefined}
      aria-labelledby={methodData ? `dw-ac-tab-${check}` : undefined}>
    <ol className="dw-dl-items dw-surface dw-ac-items">
      {activeMethod && animation.length > 0 && <li data-item="method-video">
        <DesignAcceptanceAnimation key={activeMethod.id} title={activeMethod.name} compact chapters={animation.filter(chapter => chapter.key === activeMethod.id)} /></li>}
      {activeMethod && !animation.length && video?.chapters.some(chapter => chapter.method === activeMethod.id) && <li data-item="method-video">
        <DesignAcceptanceVideo key={activeMethod.id} projectId={entry.projectId} video={video} method={activeMethod.id} /></li>}
      {activeMethod && (objective ? <ObjectiveMethodIntro key={activeMethod.id} method={activeMethod} canEnable={canSetMethods} busy={busy}
        demo={params.get('demo') === activeMethod.id} setDemo={toggleDemo}
        disable={canSetMethods && methodOpen ? () => setDisablePanel(true) : undefined}
        enable={() => void send('acceptance.enable', { version: version.version, method: activeMethod.id })} /> : <AcceptanceMethodIntro method={activeMethod} />)}
      {objective && methodData && check === 'mece' && methodOpen && <ObjectiveCoverage data={methodData} version={version}
        executable={canReview && canWrite && activeRun} send={sendEvidence} busy={busy} />}
      {objective && check === 'regress' && methodOpen && <HistoricalAcceptance entry={entry} version={version} run={run} busy={busy}
        canRegister={canWrite && isBaseline} executable={evidenceWritable} command={command} send={sendEvidence} />}
      {activeMethod && methodData && methodOpen && (!objective || (check !== 'mece' && check !== 'regress')) && <AcceptanceMethodDetails
        method={activeMethod} data={methodData} version={version} run={run} entry={entry} busy={busy} writable={evidenceWritable}
        onRule={setSelected} onDebt={itemId => { if (run) void send('acceptance.debt', { runId: run.id, itemId }); }}
        savedCompare={comparisonSkipped ? undefined : () => go('compare')} />}
      {showOverview && <li data-item="verdict"><h4><b>1</b>结论{structuredOverview && causes.length > 0 && <small>还不能签收的原因和处理入口</small>}</h4>
        {structuredOverview ? <div className="dw-ac-hero"><strong>{run?.signed ? '已签收' : signable ? '可以签收' : '暂不能签收'}</strong>
          {goalRows.length > 0 && <span>目标达成 {goalRows.filter(goal => goal.state === 'passed').length}/{goalRows.length}</span>}
          <span>验收项 {applicableItems.length}</span><span>通过 {applicableItems.filter(item => statusOf(item.id) === 'passed').length}</span>
          <span>不通过 {failures.length}</span><span>缺证据 {applicableItems.filter(item => ['missing', 'unverified'].includes(statusOf(item.id))).length}</span>
        </div> : <p className="dw-dl-lead-text"><span className="dw-status" data-state={stale ? 'needs_evidence' : run?.signed ? 'passed' : run ? state : 'draft'}>{verdictWord}</span> {lead}</p>}
        {structuredOverview && !goalRows.length && <EvidenceCauses causes={causes} />}
        <p className="dw-dl-factline">
          {programRequired && proof.total > 0 && <span>程序取证 {proof.captured}/{proof.total} · 复验一致 {proof.reviewed}/{proof.total}</span>}
          {!isBaseline && onSetBaseline && entry.frozen !== undefined &&
            <Link className="ep-link" to={`/design?${new URLSearchParams({ project: entry.projectId, design: entry.id, version: String(entry.frozen), tab: 'accept' })}`}>查看基线 V{entry.frozen} 的验收</Link>}
          {!structuredOverview && run && counts.filter(([, count]) => count > 0).map(([label, count]) => <span key={label} data-status={label}>{label} {count}</span>)}
          {run && <a className="ep-link" href={run.previewUrl} target="_blank" rel="noreferrer">打开真实预览</a>}
          {handoff && <Link className="ep-link" to={'/design?' + new URLSearchParams({ project: entry.projectId, design: entry.id,
            version: String(version.version), tab: 'delivery', part: 'files', file: handoff.id })}>查看交接清单</Link>}
          {runs.length > 1 && <select aria-label="查看历史运行" value={run?.id ?? ''} onChange={event => setRunId(event.target.value)}>
            {[...runs].reverse().map(row => <option key={row.id} value={row.id}>{row.commit.slice(0, 8)}{row.signed ? row.id === runs.at(-1)?.id ? ' · 已签收' : ' · 历史签收' : ' · ' + verdictNames[row.verdict]}</option>)}
          </select>}
        </p>
        {run && !run.signed && !stale && (preview.loading ? <ContentLoading label="核对当前预览提交" variant="inline" className="dw-dl-missing" />
          : !objective && !activeCommit ? <p className="dw-dl-missing" role="status">暂时无法核对当前预览提交，请确认预览已部署；核对上之前不能补证据、不能签收。</p> : null)}</li>}
      {showOverview && goalRows.length > 0 && <li data-item="goals"><h4>目标 → 验收项 → 结论</h4>
        <ol className="dw-ac-goals" aria-label="目标与验收结果">{goalRows.map(goal => <li key={goal.id} data-state={goal.state}>
          <div><strong>{goal.goal}</strong><small>{goal.doneWhen}</small></div>
          <span>{goal.items.length ? goal.items.map(id => <code className="dw-ac-goal-rule" data-state={statusOf(id)} key={id}>{id}</code>)
            : goal.where && /^DSN-[A-Z0-9]+$/.test(goal.where)
              ? <Link className="ep-link" to={'/design?' + new URLSearchParams({ project: entry.projectId, design: goal.where })}>{goal.where}</Link>
              : goal.where}</span>
          <span className="dw-status" data-state={goal.state}>{goalStatus[goal.state]}</span>
        </li>)}</ol>
      </li>}
      {showOverview && goalRows.length > 0 && causes.length > 0 && <li data-item="causes"><h4>为什么还不能签收</h4>
        <EvidenceCauses causes={causes} /></li>}
      {showOverview && structuredOverview && <AcceptanceTrace entry={entry} version={version} run={run} requirement={requirement} statusOf={statusOf}
        onOpen={onOpen} openRules={() => methodData ? go('mece') : jump('dw-ac-rules')} />}
      {showOverview && structuredOverview && <AcceptanceScreens version={version} statusOf={statusOf} onOpen={onOpen}
        thumbnailProject={hasDemo ? entry.projectId : undefined} />}
      {showOverview && methodData && <li data-item="methods"><h4><b>4</b>验收手段<small>{objective ? '按执行顺序排列，已启用的在前' : '每种手段的状态及不适用理由'}</small></h4>
        {objective ? <ObjectiveMethodTable methods={methodData.methods} go={go} cards={hasDemo} /> : <AcceptanceMethodOverview methods={methodData.methods} go={go} />}</li>}
      {showOverview && hasDemo && <li data-item="videos"><h4><b>5</b>验收方式演示</h4>
        {animation.length ? <DesignAcceptanceAnimation title="全部验收手段" chapters={animation} />
          : video && <DesignAcceptanceVideo projectId={entry.projectId} video={video} />}
        {animation.length > 0 && video && <a className="ep-link" href={designArtifact(entry.projectId, video.artifactId) + '?download=true'}>下载演示影片</a>}</li>}
      {showOverview && <li data-item="steps" id="dw-ac-steps"><h4><b>{structuredOverview ? 5 + Number(hasDemo) : 2}</b>下一步</h4>
        <ol className="dw-ac-steps">{steps.map((step, index) => <li key={step.key} data-state={step.done ? 'done' : index === current ? 'current' : 'later'}>
          <span className="dw-ac-step-mark">{step.done ? <Check /> : index + 1}</span>
          <div><strong>{step.title}</strong><small>{step.detail}</small>
            {step.key === 'bind' && !!version.screens.length && <details className="dw-ac-screens" open={(index === current && bound < version.screens.length) || undefined}><summary>画面和实现地址 {version.screens.length}</summary>
              <ul>{version.screens.map(screen => <li key={screen.id}><span><Link className="ep-link" to={`/design?${new URLSearchParams({ project: entry.projectId, design: entry.id, version: String(version.version), tab: 'preview', screen: screen.id })}`}>{screen.name}</Link><small> · {screen.viewport === 'phone' ? '手机' : '桌面'}</small></span>
                <code>{screen.route}</code><span>{screen.impl ? <code>{screen.impl}</code>
                  : <em>{programRequired && designDemoImplementationPath(screen) ? '演示数据场景' : '未绑定'}</em>}</span></li>)}</ul></details>}</div>
          {index === current && step.action ? <div className="dw-ac-step-action" data-primary>{step.action}</div>
            : step.done ? ((step.key === 'run' || step.key === 'bind' && bound < version.screens.length) && step.action
              ? <div className="dw-ac-step-action">{step.action}</div> : null)
            : current >= 0 && index > current && step.action ? <small className="dw-ac-step-wait">先完成第 {current + 1} 步</small> : null}
        </li>)}</ol></li>}
      {showComparison && <li data-item="screens"><h4><b>{objective && visualOnly ? 4 : objective || !methodData || visualOnly ? 3 : 2}</b>{visualOnly ? '逐画面实拍与检查' : '逐画面对照'}
        <small>{visualOnly ? '按画面记录实际截图和十项检查' : methodData ? '查看同条件的两张图和对照结论' : requiresVisual ? '缺实拍或缺证据的画面需补齐后签收' : '选择画面查看同条件下的两张截图'}</small></h4>
        <DesignVisualAcceptance key={version.version} entry={entry} version={version} run={run} busy={busy} writable={visualWritable}
          program={programRequired ? { capture: canWrite && activeRun && !proof.invalid,
            recheck: Boolean((version.publisher.id === actorId || canReview && entry.reviewers?.some(reviewer => reviewer.id === actorId))
              && activeRun && !proof.invalid), actor: actorId } : undefined}
          command={command} onRule={setSelected} visualOnly={visualOnly} />
      </li>}
      {showOverview && !!failures.length && <li data-item="fix" id="dw-ac-fix"><h4><b>{issueNumber}</b>要修的问题<small>{failures.length} 项 · 修复后重跑，或把普通问题记成债务</small></h4>
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
              <dl className="dw-details"><dt>实测</dt><dd>{cells.map(cell => cell.actual).join(' · ')}</dd><dt>期望</dt><dd>{item.expected ?? item.rule}</dd>
                {objective && acceptanceImpact([item], version) && <><dt>影响</dt><dd>{acceptanceImpact([item], version)}</dd></>}</dl>
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
      {showOverview && !!pending.length && <li data-item="evidence" id="dw-ac-evidence"><details open={!structuredOverview || undefined}>
        <summary>待补证据 · {pending.length} 处</summary><h4><b>{issueNumber + Number(failures.length > 0)}</b>待补证据
        <small>{pending.length} 处{objective ? ` · ${pendingText} 项验收` : ' · 上传实拍并写判断依据'}</small></h4>
        {(structuredOverview ? pendingGroups : [['', pending] as const]).map(([reason, group]) => <div className="dw-pending-group" key={reason}>
        {reason && <h5>{reason === 'demo' ? '要用演示数据' : reason === 'conflict' ? '规则冲突' : '缺实拍或对照'} <small>{group.length} 处</small></h5>}
        <div className="dw-pending">{group.map(cell => {
          const item = items.find(row => row.id === cell.itemId)!;
          return <div className="dw-pending-row" key={`${cell.itemId}-${cell.slot}`}><span className="dw-status" data-state="needs_evidence">{cellNames[cell.status]}</span>
            <div><strong><code>{item.id}</code> {item.rule}</strong><small>{slotNames[cell.slot]} · {cell.actual}</small></div>
            {evidenceWritable && <button type="button" className="ep-button" onClick={() => setSelected(cell)}>{item.how === 'human' ? '人工核对' : '补充证据'}</button>}
          </div>;
        })}</div></div>)}</details></li>}
      {showRules && <li data-item="rules" id="dw-ac-rules"><h4><b>{ruleNumber}</b>全部验收项<small>{items.length} 条 · 按状态分组</small></h4>
        {!items.length && <p className="dw-dl-missing">这版稿件未声明验收项。</p>}
        {groups.map(([key, label, list]) => <details key={key} className="dw-dl-rulegroup" open={key === 'failed' || key === 'missing' || undefined}>
          <summary><span className="dw-status" data-state={key === 'missing' ? 'needs_evidence' : key === 'unverified' ? 'draft' : key}>{label}</span> <small>{list.length}</small></summary>
          <ul className="dw-dl-rules">{list.map(item => <li key={item.id}><code>{item.id}</code><span><strong>{item.rule}</strong>
            <small>{ruleModes[item.how]}{item.priority === 'high' ? ' · 高级别' : ''}{item.expected ? ` · 预期：${item.expected}` : ''}</small>
            <span className="dw-ac-slots">{designSlots.filter(slot => item.slots.includes(slot)).map(slot => {
              const cell = cells.find(value => value.itemId === item.id && value.slot === slot);
              return cell ? <button key={slot} type="button" className="dw-status" data-state={cell.status} onClick={() => setSelected(cell)}>{slotNames[slot]} · {cellNames[cell.status]}</button>
                : <span key={slot} className="dw-ac-slot">{slotNames[slot]}</span>;
            })}</span></span></li>)}</ul>
        </details>)}</li>}
      {showOverview && (shared.length > 0 || selfChecks.length > 0 || version.checks) && <li data-item="more"><h4><b>{moreNumber}</b>原型检查</h4>
        {!selfChecks.length && version.checks && <p className="dw-dl-factline">
          <span>作者自检{typeof version.checks.passed === 'number' && typeof version.checks.total === 'number'
            ? ` ${version.checks.passed}/${version.checks.total}` : ''}（未附明细）</span>
        </p>}
        {selfChecks.length > 0 && <details className="dw-dl-rulegroup"><summary>作者自检 <small>{selfChecks.length - selfFailed.length}/{selfChecks.length} 通过 · 作者发布时自己记录的，不是稿件状态</small></summary>
          <ul className="dw-dl-plain">{[...selfFailed, ...selfChecks.filter(row => row.status === '通过')].map((row, index) => <li key={`${row.id}/${index}`}>{row.name} <small>· {row.status}</small></li>)}</ul></details>}
        {shared.length > 0 && <details className="dw-dl-rulegroup"><summary>共用原型入口的画面 <small>{shared.length} 组</small></summary>
          <ul className="dw-dl-plain">{shared.map(items => <li key={items[0].id}>{items.map(screen => screen.name).join('、')} <code>{items[0].route}</code> · 在画布内切换状态</li>)}</ul></details>}</li>}
    </ol>
    </div>
    {binding && bindingChoices.length > 0 && <BindImplementation choices={bindingChoices} preferred={params.get('screen')} busy={busy}
      close={() => setBinding(false)} bind={fields => send('implementation.bind', { version: version.version, ...fields })} />}
    {methodToDisable && <Dialog open onOpenChange={open => { if (!open && !busy) setDisablePanel(false); }}>
      <DialogContent className="dw-modal dw-surface dw-disable-dialog">
        <DialogTitle>停用{methodToDisable.name}</DialogTitle>
        <DialogDescription>停用后，该方式的 {methodToDisable.progress?.total ?? 0} 个检查条目暂不计入本版验收。已有证据会保留，重新启用时恢复计入。</DialogDescription>
        <form onSubmit={async event => {
          event.preventDefault();
          const reason = disableReason.trim();
          if (reason && await send('acceptance.disable', { version: version.version, method: methodToDisable.id, reason })) setDisablePanel(false);
        }}>
          <label>停用理由<textarea value={disableReason} onChange={event => setDisableReason(event.target.value)} required maxLength={1000} /></label>
          <footer><button type="button" className="ep-button" disabled={busy} onClick={() => setDisablePanel(false)}>取消</button>
            <button type="submit" className="ep-button ep-button--primary" data-action="confirm-disable" disabled={busy || !disableReason.trim()}>确认停用</button></footer>
        </form>
      </DialogContent>
    </Dialog>}
    {run && selected && <DesignEvidenceDialog entry={entry} run={run} cell={selected} version={version} command={command}
      canWrite={evidenceWritable && applicableIds.has(selected.itemId)} canReview={canReview} busy={busy} close={() => setSelected(undefined)} />}
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
