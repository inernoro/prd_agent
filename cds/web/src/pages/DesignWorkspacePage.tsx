import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { ChevronLeft, Layers, Maximize, MoreHorizontal, PanelRightOpen, Upload, X } from 'lucide-react';
import { AppShell, TopBar, Workspace } from '@/components/layout/AppShell';
import { MotionLink, rememberRouteFocus } from '@/components/layout/RouteMotion';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { apiRequest, apiUrl } from '@/lib/api';
import { requestAgentAccess } from '@/lib/agent-onboarding';
import type { DesignComment, DesignEntry, DesignReviewer, DesignScreen, DesignTheme, DesignVersion, DesignViewerState, DesignWorkspace } from '../../../src/shared/design-workspace';
import { currentDesignRun, frameworkInUse, frameworkMaterialCandidates, latestDesignFeedbackAt, type DesignMaterialKey, type FrameworkResolutions } from '../../../src/shared/design-workspace';
import { type PlanningProject, usePlanningRead } from './engineering-planning/planning-ui';
import { DesignCanvas, DesignReviewDialog } from './design-workspace/DesignCanvas';
import { DesignAcceptancePanel } from './design-workspace/DesignAcceptancePanel';
import { DesignDeliveryPanel } from './design-workspace/DesignDelivery';
import { DesignDeliverySide, type DesignFullView, type SideTab } from './design-workspace/DesignDeliverySide';
import { DesignLegacyDeliverySide } from './design-workspace/DesignLegacyDeliverySide';
import { DesignRationale } from './design-workspace/DesignRationale';
import { DesignNeed, needTrace } from './design-workspace/DesignNeed';
import { DesignHistory } from './design-workspace/DesignHistory';
import { DesignRequirementView } from './design-workspace/DesignRequirements';
import { DesignLibrary, libraryStatus } from './design-workspace/DesignLibrary';
import { DesignShareDialog } from './design-workspace/DesignShareDialog';
import { DesignFrameworkView, FrameworkBadge, frameworkTabs } from './design-workspace/DesignFramework';
import { DesignSkillsMenu, SkillGuide } from './design-workspace/SkillGuide';
import { defaultDesignScreen, designDate, designDetailPath, designFeedbackAwaitsViewer, designPath, designPublisherLabel, designSourceNames, designStatus, emptyDesignViewer, failedBaseline, latestDesign, legacyRequirementGroup, materialNames, openReviews, scopePath, statusNames, type DesignCommand } from './design-workspace/design-ui';
import './engineering-planning/planning.css';
import './design-workspace/design.css';
import './design-workspace/design-v17-delivery.css';
import './design-workspace/design-v18.css';

const tabs = [['delivery', '交付', '人和智能体'], ['accept', '验收', '人和智能体按规则执行'], ['log', '记录', '操作时自动写入']] as const;
const deliveryQuery = { full: '', part: '', fb: '', file: '', about: '', compare: '' };
type ReviewTarget = { entryId: string; commentId: string; version: number; sourceVersion: number };
type LargeTarget = { entryId: string; version: number };
const validSha = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

function frameworkVersionPath(project: string, version: DesignVersion) {
  return '/design?' + new URLSearchParams({ project, framework: version.framework!,
    ...(version.frameworkVersion ? { version: String(version.frameworkVersion) } : {}) });
}

export function DesignWorkspacePage() {
  const [params, setParams] = useSearchParams();
  const { key: locationKey, hash } = useLocation();
  const [reload, refresh] = useState(0);
  const refreshWorkspace = useCallback(() => refresh(value => value + 1), []);
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);
  const [issue, setIssue] = useState('');
  const [notice, setNotice] = useState('');
  const [canvasTheme, setCanvasTheme] = useState<DesignTheme>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const [upload, setUpload] = useState(false);
  const [assignReviewers, setAssignReviewers] = useState<string>();
  const [extract, setExtract] = useState(false);
  const [freezeTarget, setFreezeTarget] = useState<{ id: string; version: number }>();
  const [freezeReason, setFreezeReason] = useState('');
  const [cancelUpgrade, setCancelUpgrade] = useState<{ id: string; entryId: string }>();
  const [cancelReason, setCancelReason] = useState('');
  const [selectedScene, setScene] = useState<{ draft: string; screen?: DesignScreen }>();
  const [unfreezeTarget, setUnfreeze] = useState<{ id: string; version: number }>();
  const [share, setShare] = useState(false);
  const [review, setReview] = useState<ReviewTarget>();
  const [large, setLarge] = useState<LargeTarget>();
  const returnFocus = useRef<HTMLElement | null>(null);
  const deliveryReturn = useRef<{ designId: string; version: number; origin: string; fields: Record<string, string> }>();
  const pending = useRef<{ key: string; id: string }>();
  const mode = params.get('mode') === 'list' ? 'list' : 'cards';
  const group = params.get('group') ?? '';
  const tag = params.get('tag') ?? '';
  const system = params.get('system') ?? '';
  const module = params.get('module') ?? '';
  const search = params.get('q') ?? '';
  const status = libraryStatus(params.get('status') ?? params.get('filter'));
  const frameworkId = params.get('framework');
  const libraryFilter = params.get('view') === 'library' || Boolean((group || tag || status || search) && !params.has('tab') && !params.has('version'));
  const frameworkFilter = params.get('frameworkFilter') || (libraryFilter ? frameworkId : null) || '';
  const query = { search, group, tag, status, system, module, framework: frameworkFilter };

  const projects = usePlanningRead<{ projects: PlanningProject[] }>('/api/projects', 0);
  const options = (projects.data?.projects ?? []).filter(row => !row.mirror);
  const project = params.get('project') ?? options[0]?.id ?? '';
  const authorized = options.some(option => option.id === project);
  const draftId = params.get('design');
  const versionParam = params.get('version');
  const selectedVersion = Number(versionParam);
  const loadPath = !authorized ? null : draftId
    ? designDetailPath(project, draftId, Number.isSafeInteger(selectedVersion) && selectedVersion > 0 ? selectedVersion : undefined)
    : designPath(project) + '?view=summary';
  const source = usePlanningRead<DesignWorkspace>(loadPath, reload);
  const workspace = source.data?.projectId === project ? source.data : undefined;
  const permissions = workspace?.permissions;
  const entry = workspace?.designs.find(row => row.id === draftId);
  const requirementKey = params.get('brief');
  const requirement = workspace?.requirements?.find(row => row.designKey === requirementKey);
  const draftRequirement = entry?.designKey ? workspace?.requirements?.find(row => row.designKey === entry.designKey) : undefined;
  const assignment = workspace?.designs.find(row => row.id === assignReviewers);
  const framework = !libraryFilter && !entry ? workspace?.frameworks.find(row => row.id === frameworkId) : undefined;
  const frameworkVersion = framework?.versions.find(row => row.version === Number(params.get('version')));
  const frameworkList = params.get('view') === 'frameworks';
  const version = entry?.versions.find(row => row.version === Number(versionParam)) ?? (entry ? latestDesign(entry) : undefined);
  const canFreeze = permissions?.review && (!entry?.reviewers?.length || entry.reviewers.some(reviewer => reviewer.id === permissions.actorId));
  const canUnfreeze = permissions?.review && (permissions.steward || canFreeze);
  const activeUpgrade = entry?.upgrade?.status === 'active' ? entry.upgrade : undefined;
  const versionGap = entry?.versionGap;
  const panel = params.get('panel');
  const draftVisible = !requirementKey && !framework && Boolean(entry && version);
  const requestedBaseline = Number(params.get('baseline'));
  const linkedUnfreeze = draftVisible && canUnfreeze && panel === 'unfreeze' && entry && entry.frozen === requestedBaseline
    ? { id: entry.id, version: requestedBaseline } : undefined;
  const unfreeze = unfreezeTarget ?? linkedUnfreeze;
  const freeze = freezeTarget ?? (draftVisible && panel === 'freeze' && entry && version ? { id: entry.id, version: version.version } : undefined);
  const showCandidates = draftVisible && permissions?.review && entry?.frozen === version?.version
    && (extract || (panel === 'framework-candidates' && (!versionParam || Number(versionParam) === version?.version)));
  const canAssign = permissions?.write && entry && (permissions.steward || latestDesign(entry).publisher.id === permissions.actorId);
  const pinnedFramework = workspace?.frameworks.find(row => row.id === version?.framework)?.versions.find(row => row.version === version?.frameworkVersion);
  const requestedTab = params.get('tab');
  const tab = requestedTab === 'accept' || requestedTab === 'delivery' && params.get('part') === 'checks' ? 'accept'
    : requestedTab === 'log' ? 'log' : 'delivery';
  const comparing = tab === 'delivery' && (requestedTab === 'diff' || params.get('compare') === '1');
  const requestedFull = params.get('full');
  const fullView: DesignFullView | undefined = tab !== 'delivery' ? undefined
    : requestedFull === 'need' || requestedFull === 'notes' || requestedFull === 'delivery' ? requestedFull
    : requestedTab === 'need' ? 'need'
    : requestedTab === 'rationale' || requestedTab === 'notes' || requestedTab === 'spec' ? 'notes'
    : requestedTab === 'delivery' && (params.has('part') || params.has('fb') || params.has('file') || hash.startsWith('#dw-')) ? 'delivery' : undefined;
  const sideClosed = params.get('side') === 'off';
  const pane = params.get('pane');
  const sideTab: SideTab = pane === 'comments' || pane === 'deliver' ? pane : 'demo';
  const guidedDelivery = Boolean(version?.screens.length);
  const frameworkTab = frameworkTabs.find(value => value === params.get('tab')) ?? 'overview';
  const screenParam = params.get('screen') ?? undefined;
  const commentParam = params.get('comment') ?? undefined;
  const sceneDraft = entry && version ? `${entry.id}/${version.version}/${screenParam ?? ''}` : '';
  const defaultScene = version && defaultDesignScreen(version, screenParam);
  const scene = selectedScene?.draft === sceneDraft ? selectedScene.screen
    : defaultScene;
  const rememberScene = useCallback((screen?: DesignScreen) => setScene(current =>
    current?.draft === sceneDraft && current.screen === screen ? current : { draft: sceneDraft, screen }), [sceneDraft]);
  const compareFrom = Number(params.get('compareFrom') ?? params.get('from')) || undefined;
  const currentVersion = entry ? latestDesign(entry).version : undefined;
  const activeFeedback = permissions?.feedback ? entry?.feedback?.filter(row => designFeedbackAwaitsViewer(entry, row, permissions.actorId)).length : 0;
  const readKey = permissions?.actorId && project + '/' + permissions.actorId;
  const [read, setRead] = useState<{ key: string; viewer: DesignViewerState }>();
  const viewer = read?.key === readKey && read ? read.viewer : workspace?.viewer ?? emptyDesignViewer;
  const viewedVersion = draftVisible ? version?.version : undefined;
  const viewedDesign = draftVisible ? entry?.id : undefined;
  const viewedFeedback = fullView === 'delivery' && draftVisible && entry
    && (params.get('part') !== 'files' && !params.has('file')) ? latestDesignFeedbackAt(entry) || undefined : undefined;
  const viewedBrief = requirement?.designKey;
  const viewedBriefAt = requirement?.sharedAt;
  const viewingLibrary = !requirementKey && !draftId && !framework && !frameworkList;
  const serverReading = Boolean(workspace?.viewer);
  useEffect(() => {
    if (!readKey) return;
    const mark = viewedDesign && viewedVersion ? { kind: 'design', designId: viewedDesign, version: viewedVersion,
      ...(viewedFeedback ? { feedbackAt: viewedFeedback } : {}) }
      : viewedBrief && viewedBriefAt ? { kind: 'brief', designKey: viewedBrief, sharedAt: viewedBriefAt }
        : viewingLibrary ? { kind: 'library' } : undefined;
    if (!mark) return;
    if (viewedDesign && viewedVersion || viewedBrief && viewedBriefAt) {
      setRead(current => {
        const base = current?.key === readKey ? current.viewer : workspace?.viewer ?? emptyDesignViewer;
        if (viewedDesign && viewedVersion) {
          const old = base.designs?.[viewedDesign];
          const feedbackAt = [old?.feedbackAt ?? '', viewedFeedback ?? ''].sort().at(-1);
          const updated = { version: Math.max(old?.version ?? 0, viewedVersion), ...(feedbackAt ? { feedbackAt } : {}) };
          return { key: readKey, viewer: { ...base, designs: { ...base.designs, [viewedDesign]: updated } } };
        }
        return { key: readKey, viewer: { ...base, briefs: { ...base.briefs, [viewedBrief!]: viewedBriefAt! } } };
      });
    }
    if (!serverReading) return;
    const controller = new AbortController();
    void apiRequest<{ projectId: string; viewer: DesignViewerState }>(designPath(project) + '/viewed',
      { method: 'POST', body: mark, signal: controller.signal }).then(result => {
      if (!controller.signal.aborted && result.projectId === project) setRead({ key: readKey, viewer: result.viewer });
    }).catch(() => {});
    return () => controller.abort();
  }, [readKey, project, serverReading, viewedDesign, viewedVersion, viewedFeedback, viewedBrief, viewedBriefAt, viewingLibrary]);
  const objectScope = entry?.scope ?? requirement?.scope;
  const objectSystem = workspace?.systems?.find(row => row.id === objectScope?.systemId);
  const objectModule = objectSystem?.modules.find(row => row.id === objectScope?.moduleId);
  const canvas = !!entry && tab === 'delivery';
  useEffect(() => {
    const source = deliveryReturn.current;
    if (fullView !== 'delivery' || !source || entry?.id !== source.designId || version?.version !== source.version) return;
    const frame = requestAnimationFrame(() => {
      const element = document.getElementById(source.origin);
      if (!element) return;
      for (let parent = element.closest('details'); parent; parent = parent.parentElement?.closest('details') ?? null) {
        parent.open = true;
      }
      element.scrollIntoView({ block: 'center' });
      element.focus({ preventScroll: true });
      deliveryReturn.current = undefined;
    });
    return () => cancelAnimationFrame(frame);
  }, [entry?.id, version?.version, fullView]);
  const needsDetail = (id: string, version: number) =>
    !workspace?.designs.some(entry => entry.id === id && entry.versions.some(row => row.version === version && row.prototypeId));
  const modalSource = usePlanningRead<DesignWorkspace>(authorized && review
    && (needsDetail(review.entryId, review.version) || needsDetail(review.entryId, review.sourceVersion))
    ? designDetailPath(project, review.entryId, review.version, review.sourceVersion) : null, reload);
  const largeSource = usePlanningRead<DesignWorkspace>(authorized && large && needsDetail(large.entryId, large.version)
    ? designDetailPath(project, large.entryId, large.version) : null, reload);
  const modalEntry = (modalSource.data ?? workspace)?.designs.find(item => item.id === review?.entryId);
  const reviewComment = modalEntry?.comments.find(item => item.id === review?.commentId);
  const reviewVersion = modalEntry?.versions.find(item => item.version === review?.version);
  const largeEntry = (largeSource.data ?? workspace)?.designs.find(item => item.id === large?.entryId);
  const largeVersion = largeEntry?.versions.find(item => item.version === large?.version);
  const onChange = (fields: Record<string, string>, replace = false) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(fields)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setParams(next, { replace });
    setIssue(''); setNotice('');
  };
  const dismissPanel = (name: string) => {
    if (panel !== name) return;
    const next = new URLSearchParams(params);
    next.delete('panel');
    next.delete('baseline');
    setParams(next, { replace: true });
  };
  const closeUnfreeze = () => { setUnfreeze(undefined); dismissPanel('unfreeze'); };
  const closeFreeze = () => { setFreezeTarget(undefined); setFreezeReason(''); dismissPanel('freeze'); };
  const selectEntry = (id: string) => {
    deliveryReturn.current = undefined;
    onChange({ design: id, framework: '', brief: '', tab: '', version: '', view: '', screen: '', comment: '', compareFrom: '', from: '', panel: '', baseline: '', side: '', pane: '', run: '', check: '', log: '', ...deliveryQuery,
      ...(!id && !module && !group && entry ? (entry.scope ? { system: entry.scope.systemId, module: entry.scope.moduleId }
        : { group: latestDesign(entry).group ?? '' }) : {}) });
  };
  const selectFramework = (id: string) => onChange({ design: '', framework: id, tab: 'overview', version: '', view: '', compareFrom: '', panel: '', baseline: '' });
  const changeLibrary = (fields: Record<string, string>) => {
    const keepFrameworkFilter = frameworkId && libraryFilter && fields.framework !== '' && !fields.view;
    onChange(keepFrameworkFilter ? { ...fields, view: 'library' } : fields, Object.hasOwn(fields, 'q'));
  };
  const openReview = (row: DesignEntry, comment: DesignComment, version: DesignVersion) => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setReview({ entryId: row.id, commentId: comment.id, version: version.version, sourceVersion: comment.version });
  };
  const openLarge = (row: DesignEntry, version: DesignVersion) => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setLarge({ entryId: row.id, version: version.version });
  };
  const replayFocus = () => window.requestAnimationFrame(() => returnFocus.current?.isConnected && returnFocus.current.focus());
  const closeLarge = () => { setLarge(undefined); replayFocus(); };
  const closeReview = () => { setReview(undefined); replayFocus(); };
  const openFull = (view: DesignFullView, fields?: Record<string, string>) => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    onChange({ ...deliveryQuery, tab: 'delivery', full: view, compare: comparing ? '1' : '',
      screen: scene?.id ?? '', ...fields });
  };
  const closeFull = () => {
    onChange({ ...deliveryQuery, tab: 'delivery', compare: comparing ? '1' : '' });
    replayFocus();
  };

  const command: DesignCommand = async (type, fields) => {
    if (writing.current) return false;
    writing.current = true;
    setBusy(true);
    setNotice(''); setIssue('');
    const key = JSON.stringify([project, type, fields]);
    const requestId = pending.current?.key === key ? pending.current.id : crypto.randomUUID();
    pending.current = { key, id: requestId };
    try {
      const endpoint = type === 'feedback.attach' ? '/feedback/attachments'
        : type.startsWith('feedback.') || ['brief.reply', 'brief.claim', 'brief.release'].includes(type) ? '/feedback' : '/commands';
      const response = await apiRequest<{ projectId: string }>(designPath(project) + endpoint,
        { method: 'POST', body: { type, requestId, ...fields } });
      if (response.projectId !== project) throw new Error('操作回执与当前项目不符');
      pending.current = undefined;
      setNotice('操作已保存');
      refreshWorkspace();
      return true;
    } catch (error) { setIssue(error instanceof Error ? error.message : '未能保存操作，请重试'); return false; }
    finally { writing.current = false; setBusy(false); }
  };

  const libraryPath = scopePath(project);
  const folder = version?.group ?? (requirement && workspace ? legacyRequirementGroup(requirement, workspace.designs) : undefined);
  const parent = framework ? { name: '框架', href: libraryPath + '&view=frameworks' }
    : objectModule && objectScope ? { name: objectModule.name, href: scopePath(project, objectScope) }
    : folder && folder !== '未分组' ? { name: folder, href: scopePath(project, undefined, folder) }
    : undefined;
  const inDetail = Boolean(entry || requirementKey || framework || frameworkList || group || module);
  const projectSwitcher = options.length > 0 && <select className="dw-crumb-project" aria-label="设计项目" value={project}
    onChange={event => setParams(new URLSearchParams({ project: event.target.value }))}>
    {options.map(option => <option key={option.id} value={option.id}>{option.aliasName || option.name}</option>)}
  </select>;
  const breadcrumbs = <TopBar left={<nav className="dw-crumb" aria-label="位置" data-detail={inDetail || undefined}>
    <span className="dw-crumb-desktop"><MotionLink to="/project-list">CDS</MotionLink><span aria-hidden="true">/</span>
      {inDetail ? <MotionLink to={libraryPath}>设计</MotionLink> : <span>设计</span>}<span aria-hidden="true">/</span>
      {projectSwitcher}
      {parent && <><span aria-hidden="true">/</span><MotionLink className="dw-crumb-parent" to={parent.href}>{parent.name}</MotionLink></>}
      {draftVisible && entry && version && <><span aria-hidden="true">/</span><span className="dw-crumb-draft" aria-current="page">
        <strong title={version.title}>{version.title}</strong><span className="dw-status" data-state={designStatus(entry)}>{statusNames[designStatus(entry)]}</span>
      </span></>}
    </span>
    {inDetail && <MotionLink className="dw-crumb-mobile" to={parent?.href ?? libraryPath}><ChevronLeft size={15} />{parent?.name ?? '设计'}</MotionLink>}
  </nav>} />;
  const versionRun = entry?.runs.filter(run => run.version === version?.version).at(-1);
  const failingVersion = entry && failedBaseline(entry);
  const acceptanceAlerts = (entry && failingVersion && !versionRun
    ? currentDesignRun(entry) : versionRun)?.cells.filter(cell => cell.status === 'failed') ?? [];
  const commentTodos = permissions?.review && entry ? openReviews(entry).filter(({ comment }) =>
    permissions.steward || comment.author.id === permissions.actorId).length : 0;
  const requirementGaps = entry && version && draftRequirement ? needTrace(entry, version, draftRequirement).gaps : 0;
  const summaryTabLinks = entry && version && <nav className="dw-tablinks" aria-label="稿件标签">
    {tabs.map(([value, label, role]) => {
      const count = value === 'delivery' ? (activeFeedback ?? 0) + commentTodos + requirementGaps
        : value === 'accept' ? new Set(acceptanceAlerts.map(cell => cell.itemId)).size : undefined;
      const oldFailure = value === 'accept' && !versionRun && failingVersion && failingVersion !== version.version && count;
      const details = value === 'delivery' ? '条待处理' : `项不通过${oldFailure ? ` · 基线 V${failingVersion}` : ''}`;
      return <button type="button" className="dw-tab" key={value} aria-current={tab === value} title={role}
        aria-label={count ? label + ' ' + count + ' ' + details : undefined} onClick={() => {
          if (tab === value) { if (value === 'delivery' && fullView) closeFull(); return; }
          onChange({ tab: value, compareFrom: '', from: '', run: '', panel: '', screen: value === 'delivery' ? screenParam ?? '' : scene?.id ?? '',
            ...(oldFailure ? { version: String(failingVersion) } : {}), ...deliveryQuery });
        }}>
        {label}{count ? <small className="dw-tab-todo" data-negative={value === 'accept'} title={count + ' ' + details}>{count}</small> : null}
      </button>;
    })}
  </nav>;
  const canvasCommon = {
    command, canComment: Boolean(permissions?.review), canWrite: Boolean(permissions?.write),
    actorId: permissions?.actorId ?? '', steward: Boolean(permissions?.steward), commandBusy: busy,
    selectedTheme: canvasTheme, onThemeChange: setCanvasTheme,
  };
  const draftActions = entry && version && <div className="dw-tools dw-draft-actions">
    <select className="dw-version-select" value={version.version} aria-label="稿件版本" disabled={comparing}
      title={comparing ? '对比时请在画布选择左右版本' : undefined}
      onChange={event => onChange({ version: event.target.value, screen: '', compareFrom: '', from: '', run: '', panel: '',
        ...deliveryQuery, ...(fullView === 'need' || fullView === 'notes' ? { full: fullView } : {}) })}>
      {[...entry.versions].reverse().map(row => {
        const label = `V${row.version}${row.version === currentVersion ? ' · 最新' : ''}${entry.frozen === row.version ? ' · 实施基线'
          : row.version === version.version && entry.frozen !== undefined ? ` · 基线 V${entry.frozen}` : ''}`;
        return <option key={row.version} value={row.version}>{label}</option>;
      })}
    </select>
    <button className="ep-button ep-icon-button" type="button" aria-label="大屏" title="大屏" onClick={() => openLarge(entry, version)}><Maximize /></button>
    <details className="ep-new dw-info" data-design-panel="design-info" open={panel === 'design-info' || undefined}
      onToggle={event => { if (!event.currentTarget.open) dismissPanel('design-info'); }}>
      <summary className="ep-button ep-icon-button" aria-label="更多稿件操作" title="稿件信息和更多操作" data-action="design-info"><MoreHorizontal /></summary>
      <div className="dw-info-body dw-info-panel">
        <header className="dw-row"><strong>{entry.id}</strong><small>V{version.version} · {designDate(version.createdAt)}</small></header>
        <dl>
          <dt>稿件</dt><dd>{version.title}</dd>
          <dt>发布</dt><dd>{designPublisherLabel(version.publisher.label)}</dd>
          <dt>来源</dt><dd><code>{version.sourceCommit.slice(0, 12)}</code> · {designSourceNames[version.sourceVerification ?? 'declared']}</dd>
          <dt>基线</dt><dd>{entry.frozen === undefined ? '尚未定稿' : `实施基线 V${entry.frozen}`}。同一稿件可以继续发布新版本。</dd>
          <dt>已实现</dt><dd>{entry.implementedVersion === undefined ? '待首次签收' : `V${entry.implementedVersion}`}
            {versionGap?.direction === 'behind' && ` · 落后 ${versionGap.count} 版`}
            {versionGap?.direction === 'ahead' && ` · 待回退 ${versionGap.count} 版`}</dd>
          {activeUpgrade && <><dt>升级</dt><dd>目标已锁定为 V{activeUpgrade.targetVersion}
            {activeUpgrade.fromVersion !== undefined && ` · 自 V${activeUpgrade.fromVersion} 开始`}</dd></>}
          <dt>需求</dt><dd>{draftRequirement
            ? <button className="ep-link" type="button" onClick={() => openFull('need')}>查看来源需求</button> : '无交接记录'}</dd>
          <dt>框架</dt><dd>{version.framework ? <Link className="ep-link" to={frameworkVersionPath(project, version)}>
            <FrameworkBadge id={version.framework} version={version.frameworkVersion}
              latest={workspace?.frameworks.find(row => row.id === version.framework)?.versions.at(-1)?.version} />
          </Link> : '未绑定框架'}</dd>
          <dt>评审人</dt><dd>{entry.reviewers?.map(reviewer => reviewer.label).join('、') || '待指定'}</dd>
          <dt>说明</dt><dd>{version.note || '本版未附发布说明'}
            {version.tags.length > 0 && <nav className="dw-draft-tags" aria-label="稿件分类">{version.tags.map(tag =>
              <Link className="ep-link" to={'/design?' + new URLSearchParams({ project, tag })} key={tag}>#{tag}</Link>)}</nav>}</dd>
          <dt>决策</dt><dd className="dw-draft-tags">{version.decisionIds.length ? version.decisionIds.map(id =>
            <Link className="ep-link" key={id} to={`/engineering-planning?project=${encodeURIComponent(project)}&kind=decision&item=${encodeURIComponent(id)}`}>{id}</Link>) : '未关联决策'}</dd>
        </dl>
        <footer className="dw-row">
          {canFreeze && !activeUpgrade && entry.frozen !== version.version
            && <button className="ep-button" type="button" disabled={busy} data-action="freeze" onClick={() => setFreezeTarget({ id: entry.id, version: version.version })}>定为实施基线</button>}
          {canFreeze && !activeUpgrade && (version.version === currentVersion || version.version === entry.frozen)
            && version.version !== entry.implementedVersion && <button className="ep-button" type="button" disabled={busy}
              data-action="start-upgrade" onClick={() => void command('implementation.start', {
                designId: entry.id, version: version.version, expectedBaseline: entry.frozen ?? null,
              })}>锁定 V{version.version} 为升级目标</button>}
          {canFreeze && activeUpgrade && <button className="ep-button" type="button" disabled={busy}
            data-action="cancel-upgrade" onClick={() => setCancelUpgrade({ id: activeUpgrade.id, entryId: entry.id })}>结束本次升级</button>}
          {permissions?.review && entry.frozen === version.version
            && <button className="ep-button" type="button" data-action="extract-framework" onClick={() => { setIssue(''); setExtract(true); }}><Layers />框架候选</button>}
          {canAssign && <button className="ep-button" type="button" onClick={() => setAssignReviewers(entry.id)}>设置评审人</button>}
          {canFreeze && version.sourceVerification === 'git' && (entry.frozen === version.version || entry.freezes?.some(row => row.version === version.version))
            && <button className="ep-button" type="button" onClick={() => setShare(true)}>固定版本分享</button>}
          {canUnfreeze && !activeUpgrade && entry.frozen !== undefined && <button className="ep-button dw-revoke-baseline" type="button" data-action="unfreeze"
            onClick={() => setUnfreeze({ id: entry.id, version: entry.frozen! })}>撤销定稿</button>}
        </footer>
        <SkillGuide designId={entry.id} version={version.version} />
      </div>
    </details>
  </div>;
  const draftHeader = entry && version && <header className="dw-head dw-head--draft dw-head--v18">
    <div className="dw-draft-bar">
      <div className="dw-draft-heading">
        <h1 title={version.title}>{version.title}</h1>
        <span className="dw-status" data-state={designStatus(entry)}>{statusNames[designStatus(entry)]}</span>
      </div>
      {draftActions}
    </div>
    <div className="dw-draft-tabbar">
      {summaryTabLinks}
    </div>
  </header>;
  const messages = <>
    {issue && <div className="dw-message ep-error" role="alert">{issue}</div>}
    {notice && <p className="dw-message" role="status">{notice}</p>}
  </>;
  return <AppShell active="design" topbar={breadcrumbs} wide>
    <Workspace fluid className={`ep-workspace dw-workspace${entry ? ' dw-workspace--detail' : ''}${canvas ? ' cds-workspace--fill dw-workspace--canvas' : ''}`}>
      {!draftVisible && messages}
      {!workspace ? (projects.error || source.error)
        ? <p role="alert" className="dw-placeholder">{projects.error ?? source.error} <button type="button" className="ep-button" onClick={() => refresh(value => value + 1)}>重试</button></p>
        : projects.loading || source.loading ? <ContentLoading variant="table" label="正在读取设计工作区" />
        : <p className="dw-placeholder">当前没有可查看的设计项目。</p>
      : requirementKey ? <DesignRequirementView key={`${project}/${requirementKey}`} project={project} requirement={requirement} workspace={workspace} command={command} busy={busy} startOpen={panel === 'brief-start'} />
      : framework ? <DesignFrameworkView key={framework.id} framework={framework} revision={frameworkVersion} tab={frameworkTab} designs={workspace.designs}
        onTab={value => onChange({ tab: value })} />
      : entry && version ? <>
        {share && <DesignShareDialog key={`${entry.id}/${version.version}`} entry={entry} version={version} busy={busy} command={command} close={() => setShare(false)} />}
        {draftHeader}
        {messages}
        {canvas && permissions ? <div className="dw-deliver" data-guided={guidedDelivery || undefined} data-side={sideClosed ? 'off' : undefined}>
          <div className="dw-canvas-slot" aria-hidden={Boolean(fullView) || undefined}>
            <DesignCanvas key={`${entry.id}/${version.version}/${commentParam ?? ''}/${compareFrom ?? ''}`} {...canvasCommon}
              entry={entry} version={version} active={!large && !review && !fullView}
              comparing={comparing} initialScreenId={defaultScene?.id} initialCommentId={commentParam} initialComparisonVersion={compareFrom}
              cornerTools onSceneChange={rememberScene}
              onSelectScreen={id => onChange({ screen: id, comment: '' }, true)}
              onModeChange={(compare, screen, from) => onChange({ ...deliveryQuery, tab: 'delivery', compare: compare ? '1' : '',
                screen: screen ?? '', compareFrom: from === undefined ? '' : String(from), from: '' })}
              onReview={(comment, sourceVersion) => openReview(entry, comment, sourceVersion)} />
            {!fullView && deliveryReturn.current?.designId === entry.id && <button className="ep-button dw-delivery-back" type="button"
              aria-label="返回交付" title="返回交付" onClick={() => {
                const prior = deliveryReturn.current!;
                onChange({ ...deliveryQuery, ...prior.fields, tab: 'delivery', full: 'delivery', version: String(prior.version) });
              }}><ChevronLeft /><span>返回交付</span></button>}
          </div>
          {sideClosed ? <button className="ep-button dw-side-open" type="button" data-action="side-open"
            onClick={() => onChange({ side: '' })}><PanelRightOpen />{guidedDelivery ? '演示、评论和交付' : '打开右栏'}</button>
            : guidedDelivery ? <DesignDeliverySide key={`${entry.id}/${version.version}`} entry={entry} version={version} screenId={scene?.id}
              requirement={draftRequirement} permissions={permissions} tab={sideTab} theme={canvasTheme}
              onTab={value => onChange({ pane: value === 'demo' ? '' : value }, true)}
              open={openFull} onCollapse={() => onChange({ side: 'off' })}
              onScreen={id => onChange({ screen: id, comment: '' }, true)}
              onReview={comment => openReview(entry, comment, version)}
              onAccept={() => onChange({ ...deliveryQuery, tab: 'accept', screen: scene?.id ?? '' })} />
            : <DesignLegacyDeliverySide entry={entry} version={version} screen={scene} requirement={draftRequirement}
              permissions={permissions} onOpen={openFull} onCollapse={() => onChange({ side: 'off' })} />}
          {fullView && <DesignFullOverlay view={fullView} onClose={closeFull}>
            {fullView === 'need' ? <DesignNeed entry={entry} version={version} requirement={draftRequirement} />
              : fullView === 'notes' ? <DesignRationale entry={entry} version={version} baseline={pinnedFramework} focusSpec={requestedTab === 'spec'} />
              : <DesignDeliveryPanel key={`${entry.id}/${version.version}`} entry={entry} version={version}
                permissions={permissions} busy={busy} command={command}
                openScreen={(selected, screen, origin) => {
                  const fields = Object.fromEntries(['screen', 'part', 'fb', 'file', 'about']
                    .flatMap(key => params.has(key) ? [[key, params.get(key)!]] : []));
                  const thread = origin.startsWith('delivery-feedback-') ? origin.slice('delivery-feedback-'.length) : undefined;
                  if (thread) Object.assign(fields, { part: 'feedback', fb: thread });
                  deliveryReturn.current = { designId: entry.id, version: version.version, origin, fields };
                  rememberRouteFocus(locationKey, origin);
                  onChange({ ...deliveryQuery, version: String(selected), tab: 'delivery', screen });
                }}
                openVersion={selected => onChange({ version: String(selected), tab: 'delivery', full: 'delivery', screen: '',
                  part: 'files', fb: '', file: '', about: '' })} />}
          </DesignFullOverlay>}
        </div> : <>
          {tab === 'accept' && <DesignAcceptancePanel key={`${entry.id}/${version.version}`} entry={entry} version={version} busy={busy}
            canWrite={Boolean(permissions?.write)} canReview={Boolean(permissions?.review)}
            actorId={permissions?.actorId}
            canSign={Boolean(permissions?.sign ?? (permissions?.write && permissions?.review))}
            installedAcceptance={permissions?.installedAcceptance} requirement={draftRequirement} onOpen={(view, screen) => {
              if (view === 'need') openFull('need');
              else onChange({ ...deliveryQuery, tab: 'delivery', screen: screen ?? '' });
            }}
            onSetBaseline={canFreeze && !activeUpgrade ? () => setFreezeTarget({ id: entry.id, version: version.version }) : undefined}
            command={command} onPreviewStale={refreshWorkspace} />}
          {tab === 'log' && <DesignHistory entry={entry} version={version}
            onVersion={selected => onChange({ ...deliveryQuery, version: String(selected), tab: 'delivery', run: '', screen: '' })}
            onRun={(selected, run) => onChange({ ...deliveryQuery, version: String(selected), tab: 'accept', run })}
            onFeedback={selected => openFull('delivery', { part: 'feedback', fb: selected })} />}
        </>}
      </> : <>
        <DesignLibrary workspace={workspace} query={query} onChange={changeLibrary} mode={mode} theme={canvasTheme}
          viewer={viewer} frameworkList={frameworkList} onFramework={selectFramework}
          onReview={openReview} onLarge={openLarge} headerActions={<>
            <DesignSkillsMenu linked={panel === 'cli' || panel === 'skills'}
              dismiss={() => { if (panel === 'cli' || panel === 'skills') dismissPanel(panel); }} onAccess={() => requestAgentAccess('design-publish')} />
            {permissions?.write && <button className="ep-button ep-button--primary" type="button" onClick={() => setUpload(true)}><Upload />发布稿件</button>}
          </>} />
      </>}
    </Workspace>
    {upload && <DesignUpload project={project} entries={workspace?.designs ?? []} close={() => setUpload(false)}
      onPublished={id => { setUpload(false); refresh(value => value + 1); selectEntry(id); }} />}
    {assignment && <DesignReviewerDialog key={`${project}/${assignment.id}`} project={project} entry={assignment} command={command}
      busy={busy} close={() => setAssignReviewers(undefined)} />}
    {large && <Dialog open onOpenChange={open => { if (!open) closeLarge(); }}>
      <DialogContent className="dw-stage ep-dialog" frame onCloseAutoFocus={event => { event.preventDefault(); replayFocus(); }}>
        <header><DialogTitle>{largeVersion ? `${largeVersion.title} · V${largeVersion.version}` : '大屏查看'}</DialogTitle><button className="ep-button" type="button" onClick={closeLarge}><X />退出大屏</button></header>
        <DialogDescription className="sr-only">方向键切换画面，按 C 显示评论，按 Esc 退出。</DialogDescription>
        {largeEntry && largeVersion?.prototypeId ? <DesignCanvas {...canvasCommon} entry={largeEntry} version={largeVersion} comparing={false} active={!review} full onEscape={closeLarge}
          onReview={(comment, sourceVersion) => openReview(largeEntry, comment, sourceVersion)} />
          : largeSource.error ? <p role="alert" className="dw-placeholder">{largeSource.error} <button type="button" className="ep-button" onClick={refreshWorkspace}>重试</button></p>
          : <ContentLoading variant="table" label="正在打开大屏" />}
      </DialogContent>
    </Dialog>}
    {modalEntry && reviewComment && reviewVersion?.prototypeId && !modalSource.loading && <DesignReviewDialog entry={modalEntry} comment={reviewComment} version={reviewVersion}
      canReview={Boolean(permissions?.review && (permissions.steward || permissions.actorId === reviewComment.author.id))}
      command={command} busy={busy} onClose={closeReview} />}
    {review && (modalSource.loading || modalSource.error) && <Dialog open onOpenChange={open => { if (!open) closeReview(); }}><DialogContent>
      <DialogTitle>核对评论</DialogTitle>
      {modalSource.error ? <p role="alert">{modalSource.error} <button type="button" className="ep-button" onClick={refreshWorkspace}>重试</button></p>
        : <ContentLoading variant="table" label="正在读取评论画面" />}
    </DialogContent></Dialog>}
    {showCandidates && entry && version && workspace && <ExtractFramework key={`${entry.id}/${version.version}`} entry={entry} version={version} workspace={workspace} command={command}
      busy={busy} issue={issue} close={() => { setIssue(''); setExtract(false); dismissPanel('framework-candidates'); }} />}
    {draftVisible && canFreeze && !activeUpgrade && entry && version && freeze?.id === entry.id && freeze.version === version.version
      && entry.frozen !== version.version && <Dialog open onOpenChange={open => { if (!open && !busy) closeFreeze(); }}>
      <DialogContent className="dw-modal dw-surface" data-design-panel="freeze">
        <DialogTitle>将 V{version.version} 定为实施基线</DialogTitle>
        <DialogDescription>{entry.frozen === undefined ? '实现方将以此版本作为对照。' : `实施基线将从 V${entry.frozen} 移到 V${version.version}。`}</DialogDescription>
        <ul className="dw-consequences">
          <li>原基线的验收和签收继续保留在原版本。</li>
          <li>本次定稿会记入稿件记录，保留操作者和时间。</li>
          <li>同一稿件可继续续版，续版不会移动实施基线。</li>
        </ul>
        {version.version !== currentVersion && <label>选择历史版本的理由
          <textarea value={freezeReason} required maxLength={1000} onChange={event => setFreezeReason(event.target.value)} />
        </label>}
        <footer className="dw-row">
          <button className="ep-button" type="button" disabled={busy} onClick={closeFreeze}>取消</button>
          <button className="ep-button ep-button--primary" type="button" disabled={busy || version.version !== currentVersion && !freezeReason.trim()} onClick={async () => {
            if (await command('design.freeze', { designId: entry.id, version: version.version, expectedBaseline: entry.frozen ?? null,
              ...(freezeReason.trim() ? { reason: freezeReason.trim() } : {}) })) closeFreeze();
          }}>确认实施基线</button>
        </footer>
      </DialogContent>
    </Dialog>}
    {draftVisible && canUnfreeze && !activeUpgrade && unfreeze && entry?.id === unfreeze.id && entry.frozen === unfreeze.version
      && <Dialog open onOpenChange={open => { if (!open && !busy) closeUnfreeze(); }}>
      <DialogContent className="dw-modal dw-surface" data-design-panel="unfreeze">
        <DialogTitle>撤销 V{unfreeze.version} 定稿</DialogTitle>
        <DialogDescription>撤销后这份稿件没有实施基线，实现方会看到「未定稿」。</DialogDescription>
        <ul className="dw-consequences"><li>所有历史版本保留，可以随时重新定稿。</li><li>已有的做法验收和签收仍挂在 V{unfreeze.version} 上，可以追溯。</li><li>撤销记入稿件记录，写明谁在什么时候撤销。</li></ul>
        <footer className="dw-row">
          <button className="ep-button" type="button" disabled={busy} onClick={closeUnfreeze}>取消</button>
          <button className="ep-button ep-button--primary" type="button" disabled={busy} onClick={async () => {
            if (await command('design.unfreeze', { designId: unfreeze.id, version: unfreeze.version })) closeUnfreeze();
          }}>确认撤销定稿</button>
        </footer>
      </DialogContent>
    </Dialog>}
    {draftVisible && cancelUpgrade && activeUpgrade?.id === cancelUpgrade.id && entry?.id === cancelUpgrade.entryId && canFreeze &&
      <Dialog open onOpenChange={open => { if (!open && !busy) { setCancelUpgrade(undefined); setCancelReason(''); } }}>
        <DialogContent className="dw-modal dw-surface">
          <DialogTitle>结束 V{activeUpgrade.targetVersion} 升级</DialogTitle>
          <DialogDescription>结束后可锁定新的升级目标，已记录的验收仍可回看。</DialogDescription>
          <label>结束原因<textarea value={cancelReason} onChange={event => setCancelReason(event.target.value)} maxLength={1000} required /></label>
          <footer className="dw-row">
            <button className="ep-button" type="button" disabled={busy} onClick={() => { setCancelUpgrade(undefined); setCancelReason(''); }}>取消</button>
            <button className="ep-button ep-button--primary" type="button" disabled={busy || !cancelReason.trim()} onClick={async () => {
              if (await command('implementation.cancel', { designId: entry.id, upgradeId: activeUpgrade.id, reason: cancelReason.trim() })) {
                setCancelUpgrade(undefined); setCancelReason('');
              }
            }}>确认结束升级</button>
          </footer>
        </DialogContent>
      </Dialog>}
  </AppShell>;
}

const fullTitles: Record<DesignFullView, string> = { need: '原始需求与验收对照', notes: '说明全文', delivery: '反馈和资料' };

function DesignFullOverlay({ view, onClose, children }: { view: DesignFullView; onClose: () => void; children: ReactNode }) {
  const close = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!panel.current?.contains(document.activeElement)) close.current?.focus({ preventScroll: true });
  }, [view]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('[role="dialog"]')) return;
      onClose();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onClose]);
  return <section className="dw-overlay" aria-labelledby="dw-full-title" data-full-view={view} ref={panel}>
    <header><h2 id="dw-full-title">{fullTitles[view]}</h2><button ref={close} type="button" className="ep-button" onClick={onClose}>
      <ChevronLeft />回到画面</button></header>
    <div className="dw-overlay-body">{children}</div>
  </section>;
}

function DesignUpload({ project, entries, close, onPublished }: {
  project: string; entries: DesignEntry[]; close: () => void; onPublished: (id: string) => void;
}) {
  const [file, setFile] = useState<File>();
  const [commit, setCommit] = useState('');
  const [sourcePath, setSourcePath] = useState('');
  const [entry, setEntry] = useState('');
  const [note, setNote] = useState('');
  const [requestReview, setRequestReview] = useState(true);
  const [reviewerIds, setReviewerIds] = useState<string[]>();
  const [resolves, setResolves] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const previous = useRef<{ fingerprint: string; id: string }>();
  const existing = entries.find(row => row.id === entry);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file || !validSha.test(commit.trim()) || busy) return;
    if (!file.name.toLowerCase().endsWith('.zip') || file.size > 4 * 1024 * 1024) { setError('请选择 4 MiB 内的稿件 ZIP'); return; }
    setBusy(true); setError('');
    try {
      const query = new URLSearchParams({ sourceCommit: commit.trim() });
      if (sourcePath.trim()) query.set('sourcePath', sourcePath.trim());
      if (entry) query.set('designId', entry);
      if (note.trim()) query.set('note', note.trim());
      if (requestReview) query.set('review', 'true');
      if (requestReview && reviewerIds) query.set('reviewerIds', JSON.stringify(reviewerIds));
      if (Object.keys(resolves).length) query.set('resolves', JSON.stringify(Object.fromEntries(Object.entries(resolves).filter(([, value]) => value.trim()))));
      const fingerprint = query.toString() + '/' + file.name + '/' + file.size + '/' + file.lastModified;
      const requestId = previous.current?.fingerprint === fingerprint ? previous.current.id : crypto.randomUUID();
      previous.current = { fingerprint, id: requestId };
      query.set('requestId', requestId);
      const result = await fetch(apiUrl(`${designPath(project)}/packages?${query}`), {
        method: 'POST', body: file, credentials: 'include', redirect: 'error', headers: { 'Content-Type': 'application/zip' },
      });
      const value = await result.json();
      if (!result.ok || value.projectId !== project || !value.result?.designId) throw new Error(value.message ?? '未收到有效发布回执');
      onPublished(value.result.designId);
    } catch (error) { setError(error instanceof Error ? error.message : '发布未确认，可沿用原稿件重试'); }
    finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}><DialogContent className="dw-modal dw-surface">
    <DialogTitle>发布设计稿件</DialogTitle><DialogDescription>上传含 design.json、思路和独立 HTML 原型的稿件包。</DialogDescription>
    <form onSubmit={submit}>
      <label>发布到<select value={entry} onChange={event => { setEntry(event.target.value); setResolves({}); setReviewerIds(undefined); }}>
        <option value="">新稿件</option>{entries.map(row => <option key={row.id} value={row.id}>{latestDesign(row).title}</option>)}
      </select></label>
      <label>稿件 ZIP<input type="file" accept=".zip,application/zip" required onChange={event => setFile(event.target.files?.item(0) ?? undefined)} /></label>
      <label>完整 Git 提交<input value={commit} onChange={event => setCommit(event.target.value)} required autoComplete="off" /></label>
      <label>仓库内稿件目录（可选）<input value={sourcePath} maxLength={400} placeholder="例如 design/members" onChange={event => setSourcePath(event.target.value)} /></label>
      <label>发布说明<textarea value={note} onChange={event => setNote(event.target.value)} maxLength={1000}/></label>
      <label className="dw-row"><input type="checkbox" checked={requestReview} onChange={event => setRequestReview(event.target.checked)} />请求评审</label>
      {requestReview && <DesignReviewerPicker project={project} selected={reviewerIds ?? existing?.reviewers?.map(reviewer => reviewer.id) ?? []}
        onChange={setReviewerIds} busy={busy} />}
      {existing?.comments.filter(row => !row.closed).map(row => <label key={row.id}>
        {row.body}<input value={resolves[row.id] ?? ''} placeholder="填写本版处理说明" onChange={event => setResolves({ ...resolves, [row.id]: event.target.value })} />
      </label>)}
      {error && <p role="alert" className="ep-error">{error}</p>}
      <footer><button type="button" className="ep-button" onClick={close} disabled={busy}>取消</button>
        <button type="submit" className="ep-button ep-button--primary" disabled={busy || !file || !validSha.test(commit.trim())}>发布稿件</button></footer>
    </form>
  </DialogContent></Dialog>;
}

function DesignReviewerPicker({ project, selected, onChange, busy }: {
  project: string; selected: string[]; onChange: (ids: string[]) => void; busy: boolean;
}) {
  const members = usePlanningRead<{ projectId: string; reviewers: DesignReviewer[] }>(designPath(project) + '/reviewers', 0);
  const reviewers = members.data?.projectId === project ? members.data.reviewers : [];
  return <fieldset className="dw-reviewer-picker" disabled={busy}>
    <legend>评审人</legend>
    {members.loading ? <ContentLoading label="正在读取项目成员" /> : members.error ? <p role="alert">{members.error}</p>
      : reviewers.length ? <div>{reviewers.map(member => <label className="dw-row" key={member.id}>
        <input type="checkbox" checked={selected.includes(member.id)} disabled={selected.length >= 20 && !selected.includes(member.id)}
          onChange={event => onChange(event.target.checked ? [...selected, member.id] : selected.filter(id => id !== member.id))} />
        {member.label}
      </label>)}</div> : <p>当前项目没有可选成员。</p>}
  </fieldset>;
}

function DesignReviewerDialog({ project, entry, command, busy, close }: {
  project: string; entry: DesignEntry; command: DesignCommand; busy: boolean; close: () => void;
}) {
  const [selected, setSelected] = useState(entry.reviewers?.map(reviewer => reviewer.id) ?? []);
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}><DialogContent className="dw-modal dw-surface">
    <DialogTitle>设置稿件评审人</DialogTitle>
    <DialogDescription>{latestDesign(entry).title} · V{latestDesign(entry).version}</DialogDescription>
    <form onSubmit={async event => {
      event.preventDefault();
      if (await command('design.review', { designId: entry.id, reviewerIds: selected })) close();
    }}>
      <DesignReviewerPicker project={project} selected={selected} onChange={setSelected} busy={busy} />
      <footer><button type="button" className="ep-button" onClick={close} disabled={busy}>取消</button>
        <button type="submit" className="ep-button ep-button--primary" disabled={busy}>保存评审人</button></footer>
    </form>
  </DialogContent></Dialog>;
}

function ExtractFramework({ entry, version, workspace, command, busy, issue, close }: {
  entry: DesignEntry; version: DesignVersion; workspace: DesignWorkspace; command: DesignCommand; busy: boolean; issue: string; close: () => void;
}) {
  const derivedId = `fw-${entry.id.toLowerCase()}`;
  const [step, setStep] = useState(1);
  const [id, setId] = useState(() => workspace.frameworks.some(row => row.id === version.framework) ? version.framework! : derivedId);
  const [title, setTitle] = useState(`${version.title.slice(0, 140)}框架`);
  const [excluded, setExcluded] = useState<DesignMaterialKey[]>([]);
  const current = workspace.frameworks.find(row => row.id === id)?.versions.at(-1);
  const candidates = frameworkMaterialCandidates(version.spec, current?.material);
  const changes = candidates.filter(row => row.state !== 'same').map(row => row.key);
  const keys = changes.filter(key => !excluded.includes(key));
  const shared = frameworkInUse(id, current, workspace.designs);
  const conflicts = candidates.filter(row => row.state === 'conflict').map(row => row.key);
  const [selection, setSelection] = useState<{ target: string; values: FrameworkResolutions }>();
  const target = id + '/' + (current?.version ?? 0);
  const choice = selection?.target === target ? selection.values : {};
  const undecided = shared ? conflicts.filter(key => !choice[key]) : [];
  const adopted = keys.filter(key => !shared || !conflicts.includes(key) || choice[key] === 'adopt');
  if (!candidates.length) return <Dialog open onOpenChange={open => { if (!open) close(); }}><DialogContent className="dw-modal dw-surface" data-design-panel="framework-candidates">
    <DialogTitle>没有可提取的规范</DialogTitle>
    <DialogDescription>{version.title} V{version.version} 没有附令牌、规则、组件或页面骨架。</DialogDescription>
    <p>在稿件包的 <code>spec/</code> 里加上 <code>tokens.json</code> 或 <code>rules.md</code>，下一版发布后再提取。也可以直接用 CLI 导入 Git 里的规范。</p>
    <footer><button className="ep-button" type="button" onClick={close}>知道了</button></footer>
  </DialogContent></Dialog>;
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}><DialogContent className="dw-modal dw-surface" data-design-panel="framework-candidates">
    <DialogTitle>{step === 1 ? '选择框架' : '确认采用规范'}</DialogTitle>
    <DialogDescription>第 {step} 步，共 2 步 · {version.title} V{version.version} 已自动提取 {candidates.length} 类规范</DialogDescription>
    <form onSubmit={async event => {
      event.preventDefault();
      if (step === 1) { setStep(2); return; }
      if (busy || !adopted.length || undecided.length) return;
      if (await command('framework.extract', { designId: entry.id, frameworkId: id, title: current ? undefined : title.trim(),
        version: version.version, expectedVersion: current?.version ?? 0, keys: adopted, ...(shared ? { resolutions: choice } : {}) })) close();
    }}>
      {step === 1 ? <>
        <label>采用到<select value={id} onChange={event => { setId(event.target.value); setExcluded([]); setSelection(undefined); }}>
          {!workspace.frameworks.some(row => row.id === derivedId) && <option value={derivedId}>新建本稿框架</option>}
          {workspace.frameworks.map(row => <option key={row.id} value={row.id}>{row.versions.at(-1)?.title}</option>)}
        </select></label>
        {!current && <label>框架名称<input value={title} maxLength={150} onChange={event => setTitle(event.target.value)} required /></label>}
        <p>自动提取了 {candidates.length} 类规范，请核对来源和内容。</p>
        <ul className="dw-candidates">{candidates.map(({ key, state }) => <li key={key}><strong>{materialNames[key]}</strong>
          <small>来自 {entry.id} V{version.version} · 规范 / {materialNames[key]} · 提交 <code>{version.sourceCommit.slice(0, 8)}</code></small>
          <span className="dw-fw-status" data-state={state === 'new' ? 'adopted' : state === 'conflict' ? 'draft' : 'unknown'}>{state === 'new' ? '新增' : state === 'conflict' ? '和目标不同' : '相同'}</span></li>)}</ul>
        {shared && <p className="dw-muted">目标框架已采用，和它不同的项下一步要逐项确认。</p>}
      </> : <>
        <p>{current?.title ?? title} · 将生成 V{(current?.version ?? 0) + 1}</p>
        <p>{changes.length ? `将采用 ${adopted.map(key => materialNames[key]).join('、') || '0 项规范'}` : '目标框架已包含这版的规范。'}</p>
        {shared && !!conflicts.length && <fieldset className="dw-conflicts"><legend>和已采用的 {current?.title} 冲突 {conflicts.length} 项，逐项选择</legend>
          {conflicts.map(key => <div className="dw-row" key={key}><strong>{materialNames[key]}</strong>
            <label><input type="radio" name={`c-${key}`} checked={choice[key] === 'keep'} onChange={() => setSelection({ target, values: { ...choice, [key]: 'keep' } })} />保留现有</label>
            <label><input type="radio" name={`c-${key}`} checked={choice[key] === 'adopt'} onChange={() => setSelection({ target, values: { ...choice, [key]: 'adopt' } })} />采用候选</label></div>)}
          {!!undecided.length && <small>还有 {undecided.length} 项没有选择</small>}</fieldset>}
        {!!changes.length && !shared && <details><summary>手动选择采用的规范</summary>
          {changes.map(key => <label className="dw-row" key={key}><input type="checkbox" checked={!excluded.includes(key)}
            onChange={event => setExcluded(event.target.checked ? excluded.filter(item => item !== key) : [...excluded, key])} />
            {materialNames[key]}</label>)}
        </details>}
      </>}
      {issue && <p className="ep-error" role="alert">{issue}</p>}
      <footer><button className="ep-button" type="button" disabled={busy} onClick={step === 1 ? close : () => setStep(1)}>{step === 1 ? '取消' : '上一步'}</button>
        <button className="ep-button ep-button--primary" disabled={busy || (step === 2 && (!adopted.length || undecided.length > 0))}>{step === 1 ? '下一步' : busy ? '正在采用…' : '确认采用'}</button></footer>
    </form>
  </DialogContent></Dialog>;
}
