import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { ChevronLeft, Info, Layers, Maximize, Terminal, Upload, X } from 'lucide-react';
import { AppShell, TopBar, Workspace } from '@/components/layout/AppShell';
import { rememberRouteFocus } from '@/components/layout/RouteMotion';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { apiRequest, apiUrl } from '@/lib/api';
import { requestAgentAccess } from '@/lib/agent-onboarding';
import type { DesignComment, DesignEntry, DesignMaterial, DesignReviewer, DesignTheme, DesignVersion, DesignWorkspace } from '../../../src/shared/design-workspace';
import { frameworkInUse, frameworkMaterialCandidates, type DesignMaterialKey, type FrameworkResolutions } from '../../../src/shared/design-workspace';
import { type PlanningProject, usePlanningRead } from './engineering-planning/planning-ui';
import { DesignCanvas, DesignReviewDialog } from './design-workspace/DesignCanvas';
import { DesignAcceptancePanel } from './design-workspace/DesignAcceptancePanel';
import { DesignDeliveryPanel } from './design-workspace/DesignDelivery';
import { DesignRationale } from './design-workspace/DesignRationale';
import { DesignRequirementView } from './design-workspace/DesignRequirements';
import { designFeedbackAt, DesignLibrary, libraryStatuses, type DesignReadChanges } from './design-workspace/DesignLibrary';
import { DesignShareDialog } from './design-workspace/DesignShareDialog';
import { DesignFrameworkView, DesignMaterialView, FrameworkBadge, frameworkTabs } from './design-workspace/DesignFramework';
import { cellNames, designCheckRows, designDate, designFailureGroups, designPath, designSourceNames, designStatus, latestDesign, materialNames, scopePath, statusNames, verdictNames, type DesignCommand } from './design-workspace/design-ui';
import { compareDesignMaterial } from './design-workspace/design-structure';
import './engineering-planning/planning.css';
import './design-workspace/design.css';

const tabs = [['preview','预览'],['diff','对比'],['delivery','交付'],['accept','做法验收'],['rationale','思路'],['spec','规范'],['log','记录']] as const;
type ReviewTarget = { entryId: string; commentId: string; version: number };
type LargeTarget = { entryId: string; version: number };
const validSha = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

function readDesignChanges(key: string): DesignReadChanges {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function frameworkVersionPath(project: string, version: DesignVersion) {
  return '/design?' + new URLSearchParams({ project, framework: version.framework!,
    ...(version.frameworkVersion ? { version: String(version.frameworkVersion) } : {}) });
}

export function DesignWorkspacePage() {
  const [params, setParams] = useSearchParams();
  const { key: locationKey } = useLocation();
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
  const [unfreezeTarget, setUnfreeze] = useState<{ id: string; version: number }>();
  const [share, setShare] = useState(false);
  const [review, setReview] = useState<ReviewTarget>();
  const [large, setLarge] = useState<LargeTarget>();
  const returnFocus = useRef<HTMLElement | null>(null);
  const deliveryReturn = useRef<{ designId: string; version: number; origin: string }>();
  const pending = useRef<{ key: string; id: string }>();
  const mode = params.get('mode') === 'list' ? 'list' : 'cards';
  const group = params.get('group') ?? '';
  const tag = params.get('tag') ?? '';
  const system = params.get('system') ?? '';
  const module = params.get('module') ?? '';
  const search = params.get('q') ?? '';
  const status = libraryStatuses.find(([value]) => value === (params.get('status') ?? params.get('filter')))?.[0] ?? '';
  const frameworkId = params.get('framework');
  const libraryFilter = params.get('view') === 'library' || Boolean((group || tag || status || search) && !params.has('tab') && !params.has('version'));
  const frameworkFilter = params.get('frameworkFilter') || (libraryFilter ? frameworkId : null) || '';
  const query = { search, group, tag, status, system, module, framework: frameworkFilter };

  const projects = usePlanningRead<{ projects: PlanningProject[] }>('/api/projects', 0);
  const options = (projects.data?.projects ?? []).filter(row => !row.mirror);
  const project = params.get('project') ?? options[0]?.id ?? '';
  const authorized = options.some(option => option.id === project);
  const source = usePlanningRead<DesignWorkspace>(authorized ? designPath(project) : null, reload);
  const [prior, setPrior] = useState<DesignWorkspace>();
  useEffect(() => { if (source.data?.projectId === project) setPrior(source.data); }, [source.data, project]);
  const workspace = source.data?.projectId === project ? source.data : !source.error && prior?.projectId === project ? prior : undefined;
  const permissions = workspace?.permissions;
  const entry = workspace?.designs.find(row => row.id === params.get('design'));
  const requirementKey = params.get('brief');
  const requirement = workspace?.requirements?.find(row => row.designKey === requirementKey);
  const assignment = workspace?.designs.find(row => row.id === assignReviewers);
  const framework = !libraryFilter && !entry ? workspace?.frameworks.find(row => row.id === frameworkId) : undefined;
  const frameworkVersion = framework?.versions.find(row => row.version === Number(params.get('version')));
  const frameworkList = params.get('view') === 'frameworks';
  const versionParam = params.get('version');
  const version = entry?.versions.find(row => row.version === Number(versionParam)) ?? (entry ? latestDesign(entry) : undefined);
  const canFreeze = permissions?.review && (!entry?.reviewers?.length || entry.reviewers.some(reviewer => reviewer.id === permissions.actorId));
  const canUnfreeze = permissions?.review && (permissions.steward || canFreeze);
  const panel = params.get('panel');
  const draftVisible = !requirementKey && !framework && Boolean(entry && version);
  const requestedBaseline = Number(params.get('baseline'));
  const linkedUnfreeze = draftVisible && canUnfreeze && panel === 'unfreeze' && entry && entry.frozen === requestedBaseline
    ? { id: entry.id, version: requestedBaseline } : undefined;
  const unfreeze = unfreezeTarget ?? linkedUnfreeze;
  const showCandidates = draftVisible && permissions?.review && entry?.frozen === version?.version
    && (extract || (panel === 'framework-candidates' && (!versionParam || Number(versionParam) === version?.version)));
  const canAssign = permissions?.write && entry && (permissions.steward || latestDesign(entry).publisher.id === permissions.actorId);
  const pinnedFramework = workspace?.frameworks.find(row => row.id === version?.framework)?.versions.find(row => row.version === version?.frameworkVersion);
  const tab = tabs.find(([value]) => value === params.get('tab'))?.[0] ?? 'preview';
  const frameworkTab = frameworkTabs.find(value => value === params.get('tab')) ?? 'overview';
  const screenParam = params.get('screen') ?? undefined;
  const commentParam = params.get('comment') ?? undefined;
  const compareFrom = Number(params.get('compareFrom')) || undefined;
  const currentVersion = entry ? latestDesign(entry).version : undefined;
  const activeFeedback = (entry?.feedback ?? []).filter(row => row.status !== 'closed').length;
  const readKey = permissions?.actorId && `cds.design.read/${encodeURIComponent(project)}/${encodeURIComponent(permissions.actorId)}`;
  const [read, setRead] = useState<{ key: string; data: DesignReadChanges }>();
  useEffect(() => {
    if (readKey) setRead({ key: readKey, data: readDesignChanges(readKey) });
  }, [readKey]);
  useEffect(() => {
    if (!readKey || !entry || !version || !draftVisible) return;
    const data = readDesignChanges(readKey);
    const prior = data[entry.id];
    const feedbackAt = tab === 'delivery' ? designFeedbackAt(entry) : (prior?.feedbackAt ?? '');
    if ((prior?.version ?? 0) >= version.version && (prior?.feedbackAt ?? '') >= feedbackAt) return;
    data[entry.id] = { version: Math.max(prior?.version ?? 0, version.version), feedbackAt };
    try { localStorage.setItem(readKey, JSON.stringify(data)); } catch { /* Browsing works with storage disabled. */ }
    setRead({ key: readKey, data });
  }, [readKey, entry, version, tab, draftVisible]);
  const draftSystem = workspace?.systems?.find(row => row.id === entry?.scope?.systemId);
  const draftModule = draftSystem?.modules.find(row => row.id === entry?.scope?.moduleId);
  const canvas = !!entry && (tab === 'preview' || tab === 'diff');
  useEffect(() => {
    const source = deliveryReturn.current;
    if (tab !== 'delivery' || !source || entry?.id !== source.designId || version?.version !== source.version) return;
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
  }, [entry?.id, version?.version, tab]);
  const modalEntry = workspace?.designs.find(item => item.id === review?.entryId);
  const reviewComment = modalEntry?.comments.find(item => item.id === review?.commentId);
  const reviewVersion = modalEntry?.versions.find(item => item.version === review?.version);
  const largeEntry = workspace?.designs.find(item => item.id === large?.entryId);
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
  const selectEntry = (id: string) => {
    deliveryReturn.current = undefined;
    onChange({ design: id, framework: '', brief: '', tab: '', version: '', view: '', screen: '', comment: '', compareFrom: '', panel: '', baseline: '',
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
    setReview({ entryId: row.id, commentId: comment.id, version: version.version });
  };
  const openLarge = (row: DesignEntry, version: DesignVersion) => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setLarge({ entryId: row.id, version: version.version });
  };
  const replayFocus = () => window.requestAnimationFrame(() => returnFocus.current?.isConnected && returnFocus.current.focus());
  const closeLarge = () => { setLarge(undefined); replayFocus(); };
  const closeReview = () => { setReview(undefined); replayFocus(); };

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
        : type.startsWith('feedback.') || type === 'brief.reply' ? '/feedback' : '/commands';
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

  const breadcrumbs = <TopBar left={<span className="dw-crumb">CDS <span>/</span> <Link to={`/design?project=${encodeURIComponent(project)}`}>设计</Link>
    {draftVisible && draftSystem && draftModule && <> <span>/</span>
      <Link to={scopePath(project, entry!.scope)}>{draftSystem.name} · {draftModule.name}</Link></>}
    {framework && <> <span>/</span> <strong>{framework.versions.at(-1)?.title}</strong></>}
  </span>} />;
  const summaryTabLinks = entry && version && <nav className="dw-tablinks" aria-label="稿件标签">
    {tabs.map(([value, label]) => {
      const count = value === 'preview' ? entry.comments.length : value === 'delivery' ? activeFeedback
        : value === 'log' ? entry.versions.length : value === 'accept' ? entry.runs.at(-1)?.cells.filter(cell => cell.status === 'failed').length : undefined;
      const details = value === 'preview' ? '条评论' : value === 'delivery' ? '条待处理' : value === 'log' ? '版' : '项不通过';
      return <button type="button" className="dw-tab" key={value} aria-current={tab === value}
        aria-label={count ? label + ' ' + count + ' ' + details : undefined} onClick={() => onChange({ tab: value, compareFrom: '' })}>
        {label}{count ? <small data-negative={value === 'accept'} title={count + ' ' + details}>{count}</small> : null}
      </button>;
    })}
  </nav>;
  const canvasCommon = {
    command, canComment: Boolean(permissions?.review), canWrite: Boolean(permissions?.write),
    actorId: permissions?.actorId ?? '', steward: Boolean(permissions?.steward), commandBusy: busy,
    selectedTheme: canvasTheme, onThemeChange: setCanvasTheme,
  };
  return <AppShell active="design" topbar={breadcrumbs} wide>
    <Workspace fluid className={`ep-workspace dw-workspace${entry ? ' dw-workspace--detail' : ''}${canvas ? ' cds-workspace--fill dw-workspace--canvas' : ''}`}>
      {issue && <div className="dw-message ep-error" role="alert">{issue}</div>}
      {notice && <p className="dw-message" role="status">{notice}</p>}
      {!workspace ? (projects.error || source.error)
        ? <p role="alert" className="dw-placeholder">{projects.error ?? source.error} <button type="button" className="ep-button" onClick={() => refresh(value => value + 1)}>重试</button></p>
        : projects.loading || source.loading ? <ContentLoading variant="table" label="正在读取设计工作区" />
        : <p className="dw-placeholder">当前没有可查看的设计项目。</p>
      : requirementKey ? <DesignRequirementView key={`${project}/${requirementKey}`} project={project} requirement={requirement} workspace={workspace} command={command} busy={busy} />
      : framework ? <DesignFrameworkView key={framework.id} framework={framework} revision={frameworkVersion} tab={frameworkTab} designs={workspace.designs}
        onTab={value => onChange({ tab: value })} back={() => onChange({ framework: '', tab: '', version: '', view: 'frameworks' })} />
      : entry && version ? <>
        <header className="dw-head dw-head--draft">
          <div className="dw-draft-bar">
            <div className="dw-draft-heading">
              <button className="ep-button ep-icon-button" type="button" aria-label="返回设计库" onClick={() => selectEntry('')}><ChevronLeft /></button>
              <h1 title={version.title}>{version.title}</h1>
              <div className="dw-draft-marks">
                <span className="dw-status" data-state={designStatus(entry)}>{statusNames[designStatus(entry)]}</span>
                {version.framework ? <Link className="dw-fw-link" to={frameworkVersionPath(project, version)}>
                  <FrameworkBadge id={version.framework} version={version.frameworkVersion} compact
                    latest={workspace.frameworks.find(row => row.id === version.framework)?.versions.at(-1)?.version} />
                </Link> : <span className="dw-fw-badge" data-missing>未绑定框架</span>}
              </div>
            </div>
            <div className="dw-tools dw-draft-actions">
              {canvas && deliveryReturn.current?.designId === entry.id && <button className="ep-button dw-delivery-back" type="button"
                aria-label="返回交付" title="返回交付" onClick={() => onChange({ tab: 'delivery', version: String(deliveryReturn.current!.version), screen: '' })}>
                <ChevronLeft /><span>返回交付</span>
              </button>}
              <select value={version.version} aria-label="稿件版本" onChange={event => onChange({ version: event.target.value, compareFrom: '' })}>
                {[...entry.versions].reverse().map(row => <option key={row.version} value={row.version}>V{row.version}
                  {row.version === currentVersion ? ' · 最新' : ''}{entry.frozen === row.version ? ' · 实施基线' : ''}</option>)}
              </select>
              <button className="ep-button" type="button" onClick={() => openLarge(entry, version)}><Maximize />大屏</button>
              {permissions?.review && entry.frozen === version.version
                && <button className="ep-button" type="button" data-action="extract-framework" onClick={() => { setIssue(''); setExtract(true); }}><Layers />框架候选</button>}
              <details className="ep-new dw-info" data-design-panel="design-info" open={panel === 'design-info' || undefined}
                onToggle={event => { if (!event.currentTarget.open) dismissPanel('design-info'); }}>
                <summary className="ep-button ep-icon-button" aria-label="稿件信息" data-action="design-info"><Info /></summary>
                <div className="dw-info-body">
                  <header className="dw-row"><strong>{entry.id}</strong><small>{designDate(version.createdAt)}</small></header>
                  <dl>
                    <dt>发布</dt><dd>V{version.version} · {version.publisher.label}</dd>
                    <dt>来源</dt><dd><code>{version.sourceCommit.slice(0, 12)}</code> · {designSourceNames[version.sourceVerification ?? 'declared']}</dd>
                    <dt>基线</dt><dd>{entry.frozen === undefined ? '尚未定稿' : `实施基线 V${entry.frozen}`}。同一稿件可以继续发布新版本。
                    {canFreeze && entry.frozen !== version.version && version.version === currentVersion
                      && <button className="ep-button" type="button" disabled={busy} onClick={() => setFreezeTarget({ id: entry.id, version: version.version })}>定为实施基线</button>}
                    </dd>
                    <dt>需求</dt><dd>{workspace.requirements?.some(row => row.designKey === entry.designKey)
                      ? <Link className="ep-link" to={'/design?' + new URLSearchParams({ project, brief: entry.designKey! })}>查看来源需求</Link> : '无交接记录'}</dd>
                    <dt>框架</dt><dd>{version.framework ? <Link className="ep-link" to={frameworkVersionPath(project, version)}>
                      <FrameworkBadge id={version.framework} version={version.frameworkVersion}
                        latest={workspace.frameworks.find(row => row.id === version.framework)?.versions.at(-1)?.version} />
                    </Link> : '未绑定框架'}</dd>
                    <dt>评审人</dt><dd>{entry.reviewers?.map(reviewer => reviewer.label).join('、') || '待指定'}</dd>
                    <dt>说明</dt><dd>{version.note || '本版未附发布说明'}
                      {version.tags.length > 0 && <nav className="dw-draft-tags" aria-label="稿件分类">{version.tags.map(tag =>
                        <Link className="ep-link" to={'/design?' + new URLSearchParams({ project, tag })} key={tag}>#{tag}</Link>)}</nav>}</dd>
                    <dt>决策</dt><dd className="dw-draft-tags">{version.decisionIds.length ? version.decisionIds.map(id =>
                      <Link className="ep-link" key={id} to={`/engineering-planning?project=${encodeURIComponent(project)}&kind=decision&item=${encodeURIComponent(id)}`}>{id}</Link>) : '未关联决策'}</dd>
                  </dl>
                  <footer className="dw-row">
                    {canAssign && <button className="ep-button" type="button" onClick={() => setAssignReviewers(entry.id)}>设置评审人</button>}
                    {canFreeze && version.sourceVerification === 'git' && (entry.frozen === version.version || entry.freezes?.some(row => row.version === version.version))
                      && <button className="ep-button" type="button" onClick={() => setShare(true)}>固定版本分享</button>}
                    {canUnfreeze && entry.frozen !== undefined && <button className="ep-button dw-revoke-baseline" type="button" data-action="unfreeze"
                      onClick={() => setUnfreeze({ id: entry.id, version: entry.frozen! })}>撤销定稿</button>}
                  </footer>
                </div>
              </details>
            </div>
          </div>
          {summaryTabLinks}
        </header>
        {entry.frozen !== undefined && entry.frozen !== version.version && <p className="dw-baseline-note" role="status">
          你在看 V{version.version}。实施基线是 V{entry.frozen}，{version.version > entry.frozen ? `V${entry.frozen + 1}${version.version > entry.frozen + 1 ? `–V${version.version}` : ''} 是定稿之后的新版本，实现仍按基线` : '这一版早于基线'}。续版不会移动基线，只有重新定稿才会。
          <button className="ep-text-button" type="button" onClick={() => onChange({ version: String(entry.frozen), tab: 'preview', compareFrom: '' })}>打开基线 V{entry.frozen}</button>
          <button className="ep-text-button" type="button" onClick={() => onChange({ tab: 'diff', compareFrom: String(entry.frozen) })}>和基线对比</button>
        </p>}
        {share && <DesignShareDialog key={`${entry.id}/${version.version}`} entry={entry} version={version} busy={busy} command={command} close={() => setShare(false)} />}
        {canvas ? <DesignCanvas key={`${entry.id}/${version.version}/${screenParam ?? ''}/${commentParam ?? ''}/${compareFrom ?? ''}`} {...canvasCommon} entry={entry} version={version} active={!large && !review}
          comparing={tab === 'diff'} initialScreenId={screenParam} initialCommentId={commentParam} initialComparisonVersion={compareFrom} onReview={(comment, sourceVersion) => openReview(entry, comment, sourceVersion)} />
        : <>
          {tab === 'accept' && <DesignAcceptancePanel key={`${entry.id}/${version.version}`} entry={entry} version={version} busy={busy}
            canWrite={Boolean(permissions?.write)} canReview={Boolean(permissions?.review)}
            canSign={Boolean(permissions?.sign ?? (permissions?.write && permissions?.review))} command={command} onPreviewStale={refreshWorkspace} />}
          {tab === 'delivery' && permissions && <DesignDeliveryPanel key={`${entry.id}/${version.version}`} entry={entry} version={version}
            permissions={permissions} busy={busy} command={command}
            openScreen={(selected, screen, origin) => {
              deliveryReturn.current = { designId: entry.id, version: version.version, origin };
              rememberRouteFocus(locationKey, origin);
              onChange({ version: String(selected), tab: 'preview', screen });
            }}
            openVersion={selected => onChange({ version: String(selected), tab: 'delivery', screen: '' })} />}
          {tab === 'rationale' && <DesignRationale entry={entry} version={version} baseline={pinnedFramework} />}
          {tab === 'spec' && <DesignSpec key={`${entry.id}/${version.version}`} version={version} baseline={pinnedFramework?.material} />}
          {tab === 'log' && <DesignHistory entry={entry}
            onVersion={selected => onChange({ version: String(selected), tab: 'preview', run: '' })}
            onRun={(selected, run) => onChange({ version: String(selected), tab: 'accept', run })} />}
        </>}
      </> : <>
        <header className="dw-head dw-row dw-library-heading">
          <h1>设计</h1>
          <select aria-label="设计项目" value={project} onChange={event => setParams(new URLSearchParams({ project: event.target.value }))}>
            {options.map(option => <option key={option.id} value={option.id}>{option.aliasName || option.name}</option>)}
          </select>
          <div className="dw-tools dw-right">
            <details className="ep-new" data-design-panel="cli" open={panel === 'cli' || undefined}
              onToggle={event => { if (!event.currentTarget.open) dismissPanel('cli'); }}>
              <summary className="ep-button" data-action="design-cli"><Terminal />CLI</summary>
              <div className="dw-cli"><code>cdscli design list</code><code>cdscli design preview --dir .</code><code>cdscli design publish --dir .</code></div>
            </details>
            <button className="ep-button" type="button" onClick={() => requestAgentAccess('design-publish')}>接入 Agent</button>
            {permissions?.write && <button className="ep-button ep-button--primary" type="button" onClick={() => setUpload(true)}><Upload />发布稿件</button>}
          </div>
        </header>
        <DesignLibrary workspace={workspace} query={query} onChange={changeLibrary} mode={mode} theme={canvasTheme}
          read={read?.key === readKey && read ? read.data : {}} frameworkList={frameworkList} onFramework={selectFramework}
          onReview={openReview} onLarge={openLarge} />
      </>}
    </Workspace>
    {upload && <DesignUpload project={project} entries={workspace?.designs ?? []} close={() => setUpload(false)}
      onPublished={id => { setUpload(false); refresh(value => value + 1); selectEntry(id); }} />}
    {assignment && <DesignReviewerDialog key={`${project}/${assignment.id}`} project={project} entry={assignment} command={command}
      busy={busy} close={() => setAssignReviewers(undefined)} />}
    {largeEntry && largeVersion && <Dialog open onOpenChange={open => { if (!open) closeLarge(); }}>
      <DialogContent className="dw-stage ep-dialog" frame onCloseAutoFocus={event => { event.preventDefault(); replayFocus(); }}>
        <header><DialogTitle>{largeVersion.title} · V{largeVersion.version}</DialogTitle><button className="ep-button" type="button" onClick={closeLarge}><X />退出大屏</button></header>
        <DialogDescription className="sr-only">方向键切换画面，按 C 显示评论，按 Esc 退出。</DialogDescription>
        <DesignCanvas {...canvasCommon} entry={largeEntry} version={largeVersion} comparing={false} active={!review} full onEscape={closeLarge}
          onReview={(comment, sourceVersion) => openReview(largeEntry, comment, sourceVersion)} />
      </DialogContent>
    </Dialog>}
    {modalEntry && reviewComment && reviewVersion && <DesignReviewDialog entry={modalEntry} comment={reviewComment} version={reviewVersion}
      canReview={Boolean(permissions?.review && (permissions.steward || permissions.actorId === reviewComment.author.id))}
      command={command} busy={busy} onClose={closeReview} />}
    {showCandidates && entry && version && workspace && <ExtractFramework key={`${entry.id}/${version.version}`} entry={entry} version={version} workspace={workspace} command={command}
      busy={busy} issue={issue} close={() => { setIssue(''); setExtract(false); dismissPanel('framework-candidates'); }} />}
    {draftVisible && canFreeze && entry && version && freezeTarget?.id === entry.id && freezeTarget.version === version.version
      && version.version === currentVersion && entry.frozen !== version.version && <Dialog open onOpenChange={open => { if (!open && !busy) setFreezeTarget(undefined); }}>
      <DialogContent className="dw-modal dw-surface">
        <DialogTitle>将 V{version.version} 定为实施基线</DialogTitle>
        <DialogDescription>{entry.frozen === undefined ? '实现方将以此版本作为对照。' : `此操作会将实施基线从 V${entry.frozen} 移到 V${version.version}。`}
          历史版本可以继续查看，续版可以继续发布。</DialogDescription>
        <footer className="dw-row">
          <button className="ep-button" type="button" disabled={busy} onClick={() => setFreezeTarget(undefined)}>取消</button>
          <button className="ep-button ep-button--primary" type="button" disabled={busy} onClick={async () => {
            if (await command('design.freeze', { designId: entry.id, version: version.version })) setFreezeTarget(undefined);
          }}>确认实施基线</button>
        </footer>
      </DialogContent>
    </Dialog>}
    {draftVisible && canUnfreeze && unfreeze && entry?.id === unfreeze.id && entry.frozen === unfreeze.version
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
  </AppShell>;
}

const recordTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
type DesignHistoryRow = {
  key: string; at: string; title: string; details: string; note?: string; failedRules?: string[]; action: () => void; label: string; state: string;
};

function DesignHistory({ entry, onVersion, onRun }: { entry: DesignEntry; onVersion: (version: number) => void; onRun: (version: number, run: string) => void }) {
  const rows: DesignHistoryRow[] = [
    ...entry.versions.map(version => {
      const resolved = Object.keys(version.resolves);
      const checks = version.checks;
      const failedRules = designFailureGroups(version).map(group =>
        `${group.label} · ${group.rules.map(row => `${row.id} ${row.name}`).join('、')}`);
      return { key: `v${version.version}`, at: version.createdAt, title: `V${version.version} · ${version.note || '发布稿件'}`,
        details: `${version.publisher.label} · ${version.sourceCommit.slice(0, 8)}`,
        note: [resolved.length ? `声明处理 ${resolved.length} 条评论` : '', typeof checks?.total === 'number' && typeof checks.passed === 'number'
          ? `自检 ${checks.passed}/${checks.total}` : '本版未附自检结果'].filter(Boolean).join(' · '),
        failedRules,
        action: () => onVersion(version.version), label: '查看版本', state: 'release' };
    }),
    ...(entry.freezes ?? []).map((freeze, index) => ({ key: `freeze-${index}`, at: freeze.at, title: `定稿 V${freeze.version}`, details: freeze.by,
      action: () => onVersion(freeze.version), label: '查看定稿', state: 'freeze' })),
    ...(entry.unfreezes ?? []).map((event, index) => ({ key: `unfreeze-${index}`, at: event.at, title: `撤销 V${event.version} 定稿`, details: event.by,
      action: () => onVersion(event.version), label: '查看版本', state: 'unfreeze' })),
    ...entry.comments.flatMap(comment => comment.reviews.map((review, index) => ({ key: `${comment.id}/${index}`, at: review.at,
      title: review.decision === 'resolved' ? `确认评论已处理 · V${review.version}` : `退回评论 · V${review.version}`,
      details: comment.body, note: review.body, action: () => onVersion(comment.version), label: '查看原版', state: review.decision }))),
    ...entry.runs.flatMap(run => {
      const details = `V${run.version} · PR #${run.pullRequest} · ${run.commit.slice(0, 8)}`;
      const action = () => onRun(run.version, run.id);
      const started = { key: run.id, at: run.createdAt, title: `做法验收 · ${verdictNames[run.verdict]}`, details, action, label: '查看证据', state: run.verdict };
      return run.signed ? [started, { key: `signed-${run.id}`, at: run.signed.at, title: `签收 · ${verdictNames[run.signed.verdict]}`,
        details, action, label: '查看签收', state: 'signed' }] : [started];
    }),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return <section className="dw-surface dw-history-card"><h3>记录</h3><ol className="dw-design-timeline">
    {rows.map(row => <li key={row.key} data-result={row.state}>
      <div><div className="dw-history-summary"><strong>{row.title}</strong><time dateTime={row.at}>{recordTime.format(new Date(row.at))}</time></div>
        <small>{row.details}</small>{row.note && <p>{row.note}</p>}
        {row.failedRules?.map(failure => <p key={failure}>{failure}</p>)}</div>
      <button type="button" className="ep-text-button" onClick={row.action}>{row.label}</button>
    </li>)}
  </ol></section>;
}

function DesignSpec({ version, baseline }: { version: DesignVersion; baseline?: DesignMaterial }) {
  const [tab, select] = useState<keyof typeof materialNames>(version.spec.tokens ? 'tokens' : 'rules');
  const changes = compareDesignMaterial(baseline ?? {}, version.spec).filter(row => row.kind !== '移除');
  const unresolved = designCheckRows(version).filter(row => row.status !== '通过');
  const frameworkCheck = version.frameworkCheck;
  return <>
    <div className="dw-row dw-spec-tabs" role="group" aria-label="规范资料">{Object.entries(materialNames).map(([key, name]) => <button type="button" className="ep-button" aria-pressed={tab === key}
      onClick={() => select(key as keyof typeof materialNames)} key={key}>{name}</button>)}</div>
    <DesignMaterialView material={version.spec} tab={tab} />
    <div className="dw-spec-cards">
      {!!frameworkCheck?.items.length && <section className="dw-surface dw-markdown"><h3>发布规则检查</h3>
        <small>{frameworkCheck.framework} · v{frameworkCheck.frameworkVersion}</small>
        <ul>{frameworkCheck.items.map(row => <li key={row.ruleId}>
          <strong>{cellNames[row.status]}</strong> · <code>{row.ruleId}</code> {row.name}
          <small>{row.actual}</small>
        </li>)}</ul>
      </section>}
      {version.checks && <section className="dw-surface dw-markdown"><h3>规则检查与自检</h3>
        {typeof version.checks.passed === 'number' && typeof version.checks.total === 'number' && <p>已报告通过 {version.checks.passed} / {version.checks.total}</p>}
        {!!unresolved.length && <ul>{unresolved.map(row => <li key={row.id}><strong>{row.status}</strong> · <code>{row.id}</code> {row.name}</li>)}</ul>}
      </section>}
      <section className="dw-surface dw-markdown"><h3>相对框架的规范变化</h3>
        <small>{baseline ? `${version.framework} · v${version.frameworkVersion}` : '本版未绑定已验证的框架版本，显示稿件声明'}</small>
        {changes.length ? <ul>{changes.map(row => <li key={row.id}><b>{row.kind} · {row.label}</b> {row.text.slice(0, 200)}</li>)}</ul> : <p>本版没有单独附加或修改的规则、组件、骨架或令牌。</p>}
      </section>
      <section className="dw-surface dw-markdown"><h3>画面清单</h3>{version.screens.length ? <div className="dw-notes-table" role="region" aria-label="画面清单" tabIndex={0}>
        <table><thead><tr><th scope="col">画面</th><th scope="col">视口</th><th scope="col">原型路由</th><th scope="col">实现地址</th></tr></thead>
          <tbody>{version.screens.map(screen => <tr key={screen.id}><td>{screen.name}</td><td>{screen.viewport === 'phone' ? '手机' : '桌面'}</td>
            <td><code>{screen.route}</code></td><td>{screen.impl ? <code>{screen.impl}</code> : '未声明'}</td></tr>)}</tbody></table>
      </div> : <p>本版未声明画面，预览可打开独立原型。</p>}</section>
      <section className="dw-surface dw-markdown"><h3>验收项</h3>{version.acceptance.length ? <ul>{version.acceptance.map(rule =>
        <li key={rule.id}><code>{rule.id}</code> {rule.rule}</li>)}</ul> : <p>本版未声明验收项。</p>}</section>
    </div>
  </>;
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
  const [id, setId] = useState(derivedId);
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
