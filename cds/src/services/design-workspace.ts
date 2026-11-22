import { randomUUID } from 'node:crypto';
import type {
  DesignCell, DesignComment, DesignEntry, DesignFramework, DesignFrameworkCheck, DesignMaterial, DesignReviewer, DesignReviewNotice, DesignRun, DesignSlot, DesignVersion, DesignWorkspace,
  DesignDelivery, DesignDeliveryFile, DesignFeedback, DesignFrameworkCharter, DesignImplementation, DesignIntake, DesignRequirement, DesignScope, DesignSharePreparation, DesignSystem, DesignViewerState, FrameworkResolutions,
} from '../shared/design-workspace.js';
import type { PlanningActor, PlanningDesignLink } from '../shared/engineering-planning.js';
import { currentDesignRun, designAcceptanceTarget, designFeedbackCategories, designMaterialKeys, designSlots, frameworkInUse, frameworkMaterialCandidates, latestDesignFeedbackAt } from '../shared/design-workspace.js';
import { evaluateDesignAcceptance } from './design-acceptance.js';
import { checkDesignFramework, type DesignFrameworkProbe } from './design-framework-check.js';
import { issueDesignShareHandoff, type DesignShareHandoffConfig } from './design-share-handoff.js';
import {
  designCommit, designDigest, designId, designPngDimensions, designRecord, designScopeId, designSourcePath, invalidDesign, localDesignPath,
  parseDesignScope, parseFrameworkCharter, readArchivedDesignFile, readDesignFrameworkSource, readDesignPackage,
} from './design-package.js';
import { planningText, rejectPlanning } from './engineering-planning-input.js';
import type { ProjectRevisionAsset, ProjectRevisionStore } from './project-revision-store.js';

export type DesignActor = PlanningActor & { steward?: boolean; gitPublishOnly?: boolean; feedback?: boolean };
type Receipt = {
  projectId: string; reused: boolean;
  result: { type: string; designId?: string; version?: number; id?: string; frameworkId?: string; runId?: string;
    state?: DesignSharePreparation['state']; sourceCommit?: string; designKey?: string; planId?: string; artifactId?: string };
};
type RequestReceipt = { key: string; fingerprint: string; result: Receipt['result'] };
export type DesignWorkspaceCommit = {
  projectId: string; revision: number; request: RequestReceipt; assets?: ProjectRevisionAsset[];
  design?: { id: string; designKey?: string; scope?: DesignScope; version?: DesignVersion; comment?: DesignComment; run?: DesignRun; feedback?: DesignFeedback;
    frozen?: number; freeze?: NonNullable<DesignEntry['freezes']>[number]; unfreeze?: NonNullable<DesignEntry['unfreezes']>[number];
    pullRequest?: number; reviewRequested?: boolean;
    reviewers?: DesignReviewer[]; notifyReviewersAt?: string; sharePreparation?: DesignSharePreparation;
    implementation?: { version: number; screens: DesignImplementation[] } };
  framework?: DesignFramework;
  system?: DesignSystem;
  viewing?: { actorId: string; state: DesignViewerState };
  brief?: { designKey: string; value: DesignRequirement | null };
};
type Changes = Pick<DesignWorkspaceCommit, 'assets' | 'design' | 'framework' | 'system' | 'brief' | 'viewing'>;
type Preview = { commit: string; url: string };
type WorkspaceState = {
  revision: number; designs: Map<string, DesignEntry>; frameworks: Map<string, DesignFramework>;
  requests: Map<string, RequestReceipt>; assets: Map<string, number>;
  reviewNotices: Map<string, DesignReviewNotice[]>;
  requirements: Map<string, DesignRequirement>;
  systems: Map<string, DesignSystem>;
  viewers: Map<string, DesignViewerState>;
  deliveryFiles: Map<string, { archiveId: string; root: string; file: DesignDeliveryFile }>;
};
type Context = { projectId: string; actor: DesignActor; state: WorkspaceState; now: string };
type Update = { result: Receipt['result']; changes: Changes };
type DesignArtifact = { bytes: Buffer; mime: string; file?: DesignDeliveryFile; attachment?: string };

const missing = (message: string): never => rejectPlanning(404, 'design_not_found', message);
const conflict = (message: string): never => rejectPlanning(409, 'design_conflict', message);
const intakeConflict = (message: string): never => rejectPlanning(409, 'design_intake_conflict', message);
const forbidden = (message: string): never => rejectPlanning(403, 'design_forbidden', message);
const identity = ({ id, label }: DesignActor) => ({ id, label });
const reviewNoticeWindow = 60 * 60_000;
const reviewNoticeLimit = 50;
const write = (actor: DesignActor) => {
  if (!actor.permissions.includes('write')) forbidden('当前身份无权写入稿件');
};
const canLeaveFeedback = (actor: DesignActor) => actor.feedback === true || actor.permissions.includes('write');
const writeFeedback = (actor: DesignActor) => {
  if (!canLeaveFeedback(actor)) forbidden('当前身份无权提交设计反馈，请使用本项目实施反馈或发布权限');
};
const review = (actor: DesignActor) => {
  if (actor.kind !== 'human' || !actor.permissions.includes('approve')) forbidden('此操作需要项目成员确认');
};
const authored = (actor: DesignActor, resource: { id: string }) => {
  if (resource.id !== actor.id && !actor.steward) forbidden('需要原作者或项目管理者确认');
};
const number = (value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) return invalidDesign(`请填写有效的${label}`);
  return value;
};
const optionalText = (value: unknown, label: string, max: number) => value === undefined ? undefined : planningText(value, label, max);
const requireProjectRead = (actor: DesignActor) => {
  if (!actor.permissions.includes('read')) missing('没有可访问的设计项目');
};
const replace = <T extends { id: string }>(rows: T[], row: T) => {
  const index = rows.findIndex(item => item.id === row.id);
  if (index < 0) rows.push(row);
  else rows[index] = row;
};

function configuredModule(state: WorkspaceState, scope: DesignScope) {
  const system = state.systems.get(scope.systemId);
  const module = system?.modules.find(row => row.id === scope.moduleId);
  if (!module) return invalidDesign('所选系统或模块未在当前项目登记，请先回读设计接入清单');
  return { system: system!, module };
}

function validateScope(state: WorkspaceState, scope: DesignScope) {
  const configured = configuredModule(state, scope);
  for (const related of scope.related ?? []) configuredModule(state, related);
  return configured;
}

function adoptedFrameworkVersion(framework?: DesignFramework): number | undefined {
  return framework?.versions.filter(revision => !revision.charter || revision.charter.status === 'adopted').at(-1)?.version;
}

function visibleRequirements(state: WorkspaceState) {
  const scopes = new Map([...state.designs.values()].filter(row => row.designKey && row.scope).map(row => [row.designKey, row.scope!]));
  return structuredClone([...state.requirements.values()].map(row =>
    !row.scope && scopes.has(row.designKey) ? { ...row, scope: scopes.get(row.designKey) } : row));
}

function apply(state: WorkspaceState, commit: DesignWorkspaceCommit) {
  state.revision = commit.revision;
  state.requests.set(commit.request.key, commit.request);
  for (const asset of commit.assets ?? []) state.assets.set(asset.id, commit.revision);
  if (commit.framework) state.frameworks.set(commit.framework.id, commit.framework);
  if (commit.system) state.systems.set(commit.system.id, commit.system);
  if (commit.viewing) state.viewers.set(commit.viewing.actorId, commit.viewing.state);
  if (commit.brief) {
    if (commit.brief.value) state.requirements.set(commit.brief.designKey, commit.brief.value);
    else state.requirements.delete(commit.brief.designKey);
  }
  if (commit.design) {
    const update = commit.design;
    const previous = state.designs.get(update.id);
    const design: DesignEntry = previous ? { ...previous, versions: [...previous.versions], comments: [...previous.comments], runs: [...previous.runs] }
      : { id: update.id, projectId: commit.projectId, versions: [], comments: [], runs: [] };
    state.designs.set(update.id, design);
    if (update.designKey !== undefined) design.designKey = update.designKey;
    if (update.scope) design.scope = update.scope;
    if (update.version) {
      design.versions.push(update.version);
      const delivery = update.version.delivery;
      for (const file of delivery?.files ?? []) {
        state.deliveryFiles.set(file.id, { archiveId: delivery!.archiveId, root: delivery!.archiveRoot, file });
      }
    }
    if (update.feedback) {
      design.feedback = [...(previous?.feedback ?? [])];
      replace(design.feedback, update.feedback);
    }
    if (update.implementation) {
      const { version, screens } = update.implementation;
      const bindings = new Map(previous?.implementations?.[version]?.map(row => [row.screenId, row]));
      for (const screen of screens) bindings.set(screen.screenId, screen);
      design.implementations = { ...previous?.implementations, [version]: [...bindings.values()] };
    }
    if (update.comment) replace(design.comments, update.comment);
    if (update.run) replace(design.runs, update.run);
    if (update.frozen !== undefined) design.frozen = update.frozen;
    if (update.freeze) design.freezes = [...(design.freezes ?? []), update.freeze];
    if (update.unfreeze) {
      delete design.frozen;
      design.unfreezes = [...(design.unfreezes ?? []), update.unfreeze];
    }
    if (update.pullRequest !== undefined) design.pullRequest = update.pullRequest;
    if (update.reviewRequested !== undefined) {
      design.reviewRequested = update.reviewRequested && design.frozen !== design.versions.at(-1)?.version;
    }
    if (update.reviewers !== undefined) design.reviewers = update.reviewers;
    if (update.sharePreparation) design.sharePreparations = [...(design.sharePreparations ?? []), update.sharePreparation];
    if (update.notifyReviewersAt && design.reviewRequested) {
      const at = update.notifyReviewersAt;
      const version = design.versions.at(-1)!;
      for (const reviewer of design.reviewers ?? []) {
        const rows = [...(state.reviewNotices.get(reviewer.id) ?? [])];
        const index = rows.findIndex(row => row.designId === design.id);
        const mostRecent = rows[index];
        const merge = mostRecent && Date.parse(at) - Date.parse(mostRecent.createdAt) < reviewNoticeWindow;
        if (merge) rows.splice(index, 1);
        rows.unshift({ id: merge ? mostRecent.id : `${design.id}@${commit.revision}`, projectId: commit.projectId,
          designId: design.id, version: version.version, title: version.title, createdAt: merge ? mostRecent.createdAt : at,
          updatedAt: merge && mostRecent.updatedAt > at ? mostRecent.updatedAt : at, occurrences: merge ? mostRecent.occurrences + 1 : 1 });
        state.reviewNotices.set(reviewer.id, rows.slice(0, reviewNoticeLimit));
      }
    }
  }
}

function registeredDesignPaths(design: DesignEntry): string[] {
  return [...new Set(design.versions.flatMap(version =>
    version.sourcePath && (version.sourceVerification === 'git' || version.sourceVerification === 'private-upload')
      ? [version.sourcePath] : []))];
}

function designIntakeKey(value: unknown) {
  const key = planningText(value, '设计接入标识', 129);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key)) {
    return invalidDesign('设计接入标识须使用 module/draft 形式的小写字母、数字和连字符');
  }
  return key;
}

function readPublicationIntent(params: Record<string, unknown>, targetId: string | undefined, sourcePath: string | undefined) {
  const intent = params.intent;
  if (intent !== undefined && intent !== 'create' && intent !== 'revise') return invalidDesign('请明确选择新建 create 或续版 revise');
  const designKey = params.designKey === undefined ? undefined : designIntakeKey(params.designKey);
  let expectedVersion: number | undefined;
  if (params.expectedVersion !== undefined) {
    if (typeof params.expectedVersion !== 'string' || !/^[1-9][0-9]*$/.test(params.expectedVersion)) {
      return invalidDesign('续版须提交正整数 expectedVersion');
    }
    expectedVersion = number(Number(params.expectedVersion), '当前稿件版本');
  }
  if (!intent && (designKey || expectedVersion)) return invalidDesign('使用接入标识或基线版本时，须明确新建或续版');
  if (intent && sourcePath === undefined) return invalidDesign('设计接入须提供稿件的仓库相对目录 sourcePath');
  if (intent === 'create' && (!designKey || targetId || expectedVersion)) {
    return invalidDesign('新建须提供 designKey，稿件 ID 由 CDS 分配');
  }
  if (intent === 'revise' && (!targetId || !expectedVersion)) {
    return invalidDesign('续版须提供实际稿件 designId 和读取到的 expectedVersion');
  }
  return { intent, designKey, expectedVersion };
}

function versionOf(design: DesignEntry, value: unknown): DesignVersion {
  const version = number(value, '稿件版本');
  return design.versions.find(row => row.version === version) ?? missing('该稿件版本不存在');
}

function implementationVersion(entry: DesignEntry, version: DesignVersion): DesignVersion {
  const rows = entry.implementations?.[version.version];
  if (!rows?.length) return version;
  const bindings = new Map(rows.map(row => [row.screenId, row]));
  return { ...version, screens: version.screens.map(screen => {
    const binding = bindings.get(screen.id);
    return binding ? { ...screen, impl: binding.path, readySelector: binding.readySelector } : screen;
  }) };
}

function runOf(design: DesignEntry, value: unknown): DesignRun {
  const id = designId(value, '验收运行');
  return design.runs.find(row => row.id === id) ?? missing('该验收运行不存在');
}

function screenPath(version: DesignVersion, itemId: string, slot: DesignSlot) {
  const rule = version.acceptance.find(item => item.id === itemId)!;
  return designAcceptanceTarget(version, rule, slot)?.impl ?? null;
}

function ratio(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return invalidDesign('评论坐标须在画面内');
  return value;
}

function image(value: unknown): ProjectRevisionAsset {
  const encoded = typeof value === 'string' ? value.match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/) : null;
  if (!encoded || encoded[1].length > 1024 * 1024 * 2) return invalidDesign('截图须为 1.5 MiB 以内的 PNG');
  const data = Buffer.from(encoded[1], 'base64');
  if (!designPngDimensions(data)) return invalidDesign('截图内容不是有效的 PNG');
  return { id: randomUUID(), mime: 'image/png', base64: data.toString('base64') };
}

function parseMaterial(value: unknown): DesignMaterial {
  const input = designRecord(value, '框架材料', [...designMaterialKeys]);
  const tokens = input.tokens === undefined ? undefined : designRecord(input.tokens, '设计令牌');
  if (tokens && JSON.stringify(tokens).length > 120_000) invalidDesign('设计令牌超过字数限制');
  return { tokens, rules: optionalText(input.rules, '规则', 64 * 1024),
    components: optionalText(input.components, '组件', 64 * 1024), skeleton: optionalText(input.skeleton, '骨架', 64 * 1024) };
}

function draftCharter(projectId: string, version: DesignVersion): DesignFrameworkCharter | undefined {
  if (version.frameworkCharter) return version.frameworkCharter;
  const intent = version.rationale.match(/^#{2,6}[ \t]+这(?:一)?版(?:要)?解决什么[^\r\n]*\r?\n(?:[ \t]*\r?\n)*[ \t]*(?:>[ \t]*)?([^\r\n#][^\r\n]*)/mu)?.[1]?.trim();
  return intent ? { status: 'draft', intent: intent.slice(0, 400), problems: [], nonGoals: [],
    scope: { system: projectId, modules: version.group ? [version.group] : [] }, owner: version.publisher.label } : undefined;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const object = item as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]]));
  });
}

export class DesignWorkspaceService {
  private readonly latest = new Map<string, WorkspaceState>();

  constructor(private readonly store: ProjectRevisionStore<DesignWorkspaceCommit>, private readonly deps: {
    reviewer?: (projectId: string, actorId: string) => Promise<DesignReviewer | undefined>;
    sourcePackage?: (projectId: string, commit: string, sourcePath: string) => Promise<Buffer | undefined>;
    frameworkProbe?: DesignFrameworkProbe;
    resolvePreview?: (projectId: string, pullRequest: number, commit?: string) => Promise<Preview | undefined>;
    approvedPlanFor?: (projectId: string, planId: string) => Promise<Omit<DesignRequirement, 'designKey' | 'planId' | 'sharedAt'> | undefined>;
    findDebt?: (projectId: string, debtId: string, sourceRef: string) => Promise<boolean>;
    resolveDebtProposal?: (projectId: string, proposalId: string, sourceRef: string) => Promise<string | undefined>;
    createDebt?: (context: { projectId: string; actor: DesignActor; sourceRef: string; title: string; actual: string;
      version: number; pullRequest: number; commit: string; expected: string; high: boolean }) =>
      Promise<{ id: string; pending: boolean }>;
    now?: () => Date;
  } = {}) {}

  private async load(projectId: string): Promise<WorkspaceState> {
    const base = this.latest.get(projectId);
    const commits = await this.store.read(projectId, base?.revision ?? 0);
    if (base && !commits.length) return base;
    const state: WorkspaceState = { revision: base?.revision ?? 0, requests: new Map(base?.requests),
      designs: new Map(base?.designs), frameworks: new Map(base?.frameworks), assets: new Map(base?.assets), reviewNotices: new Map(base?.reviewNotices),
      requirements: new Map(base?.requirements), systems: new Map(base?.systems), viewers: new Map(base?.viewers), deliveryFiles: new Map(base?.deliveryFiles) };
    for (const commit of commits) {
      if (commit.projectId !== projectId || commit.revision !== state.revision + 1) throw new Error('Design revision history is inconsistent');
      apply(state, commit);
    }
    const cached = this.latest.get(projectId);
    if (cached && cached.revision > state.revision) return cached;
    this.latest.set(projectId, state);
    return state;
  }

  private async mutate(projectId: string, actor: DesignActor, requestId: string, input: unknown,
    build: (context: Context) => Update | Promise<Update>, authorize = write): Promise<Receipt> {
    requireProjectRead(actor);
    authorize(actor);
    const key = designDigest(JSON.stringify([actor.kind, actor.id, requestId]));
    const fingerprint = designDigest(stableJson(input));
    const at = (this.deps.now ?? (() => new Date()))().toISOString();
    for (let attempt = 0; attempt < 8; attempt++) {
      const state = await this.load(projectId);
      const former = state.requests.get(key);
      if (former) {
        if (former.fingerprint !== fingerprint) conflict('同一请求编号已经用于不同的内容');
        return { projectId, reused: true, result: former.result };
      }
      const { changes, result } = await build({ projectId, actor, state, now: at });
      if (await this.store.append({ projectId, revision: state.revision + 1, ...changes, request: { key, fingerprint, result } })) {
        return { projectId, reused: false, result };
      }
    }
    return rejectPlanning(503, 'design_conflict', '稿件正在并发更新，请沿用原请求编号重试');
  }

  private async currentSignoffs(projectId: string, designs: readonly DesignEntry[]) {
    const previews = new Map<number, Promise<Preview | undefined>>();
    const signoffs = new Map<string, DesignRun | null>();
    await Promise.all(designs.map(async entry => {
      const run = currentDesignRun(entry);
      if (!run?.signed) return;
      let target = previews.get(run.pullRequest);
      if (!target) {
        target = this.deps.resolvePreview?.(projectId, run.pullRequest).catch(() => undefined) ?? Promise.resolve(undefined);
        previews.set(run.pullRequest, target);
      }
      const preview = await target;
      signoffs.set(entry.id, preview?.commit === run.commit && preview.url === run.previewUrl ? run : null);
    }));
    return signoffs;
  }

  async workspace(projectId: string, actor: DesignActor): Promise<DesignWorkspace> {
    requireProjectRead(actor);
    const state = await this.load(projectId);
    const designs = structuredClone([...state.designs.values()].sort((a, b) =>
      b.versions.at(-1)!.createdAt.localeCompare(a.versions.at(-1)!.createdAt)));
    const signoffs = await this.currentSignoffs(projectId, designs);
    for (const entry of designs) {
      entry.versions = entry.versions.map(version => implementationVersion(entry, version));
      const run = signoffs.get(entry.id);
      if (run !== undefined) entry.currentSignoffRunId = run?.id ?? null;
    }
    return { projectId, designs, frameworks: structuredClone([...state.frameworks.values()]),
      requirements: visibleRequirements(state),
      ...(state.systems.size ? { systems: structuredClone([...state.systems.values()]) } : {}),
      ...(actor.kind === 'human' ? { viewer: structuredClone(state.viewers.get(actor.id) ?? { designs: {}, briefs: {} }) } : {}),
      permissions: { write: actor.permissions.includes('write'), feedback: canLeaveFeedback(actor), review: actor.kind === 'human' && actor.permissions.includes('approve'),
        sign: actor.kind === 'human' && actor.permissions.includes('write'),
        steward: actor.steward === true, actorId: actor.id } };
  }

  async intake(projectId: string, actor: DesignActor): Promise<DesignIntake> {
    requireProjectRead(actor);
    const state = await this.load(projectId);
    const canWrite = actor.permissions.includes('write');
    return {
      protocolVersion: 1, projectId, permissions: { write: canWrite, feedback: canLeaveFeedback(actor) }, keyFormat: 'module/draft', intents: ['create', 'revise'],
      requirements: visibleRequirements(state),
      ...(state.systems.size ? { systems: structuredClone([...state.systems.values()]) } : {}),
      designs: [...state.designs.values()].map(entry => {
        const latest = entry.versions.at(-1)!;
        return { designId: entry.id, designKey: entry.designKey, title: latest.title, latestVersion: latest.version,
          sourceCommit: latest.sourceCommit, sourcePaths: registeredDesignPaths(entry),
          ...(entry.scope ? { scope: structuredClone(entry.scope) } : {}),
          canRevise: canWrite && (actor.steward === true || latest.publisher.id === actor.id),
          openFeedbackCount: entry.feedback?.filter(item => item.status !== 'closed').length ?? 0 };
      }),
      frameworks: [...state.frameworks.values()].map(frame => {
        const latest = frame.versions.at(-1)!;
        const adoptedVersion = adoptedFrameworkVersion(frame);
        return { id: frame.id, title: latest.title, latestVersion: latest.version,
          ...(adoptedVersion ? { adoptedVersion } : {}) };
      }),
    };
  }

  async viewed(projectId: string, actor: DesignActor, value: unknown) {
    requireProjectRead(actor);
    if (actor.kind !== 'human') forbidden('只有当前登录成员可以保存自己的阅读进度');
    const input = designRecord(value, '设计阅读进度');
    const kind = input.kind;
    const now = (this.deps.now ?? (() => new Date()))();
    const base = await this.load(projectId);
    const previous = base.viewers.get(actor.id);
    let build: (state: WorkspaceState, next: DesignViewerState) => void;
    let identity: string[];
    if (kind === 'library') {
      designRecord(input, '设计库阅读进度', ['kind']);
      if (previous?.lastVisitAt && now.getTime() - Date.parse(previous.lastVisitAt) < 60 * 60_000) {
        return { projectId, viewer: structuredClone(previous) };
      }
      identity = ['library', String(Math.floor(now.getTime() / (60 * 60_000)))];
      build = (_state, next) => { next.firstVisitAt ??= now.toISOString(); next.lastVisitAt = [next.lastVisitAt ?? '', now.toISOString()].sort().at(-1); };
    } else if (kind === 'design') {
      designRecord(input, '稿件阅读进度', ['kind', 'designId', 'version', 'feedbackAt']);
      const id = designId(input.designId, '稿件编号');
      const version = number(input.version, '稿件版本');
      const at = input.feedbackAt === undefined ? undefined : planningText(input.feedbackAt, '反馈时间', 30);
      if (at && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(at) || !Number.isFinite(Date.parse(at))
        || new Date(at).toISOString() !== at)) invalidDesign('反馈时间不正确');
      identity = ['design', id, String(version), at ?? ''];
      build = (state, next) => {
        const draft = state.designs.get(id) ?? missing('该稿件不存在');
        versionOf(draft, version);
        if (at && at > latestDesignFeedbackAt(draft)) invalidDesign('反馈阅读时间超出当前稿件记录');
        const stored = next.designs[id];
        next.designs[id] = { version: Math.max(version, stored?.version ?? 0),
          ...(at || stored?.feedbackAt ? { feedbackAt: [at ?? '', stored?.feedbackAt ?? ''].sort().at(-1) } : {}) };
      };
    } else if (kind === 'brief') {
      designRecord(input, '需求阅读进度', ['kind', 'designKey', 'sharedAt']);
      const designKey = designIntakeKey(input.designKey);
      const at = planningText(input.sharedAt, '交接时间', 30);
      const visible = base.requirements.get(designKey) ?? missing('该需求不存在');
      if (visible.sharedAt !== at) conflict('需求已重新交接，请刷新后阅读');
      identity = ['brief', designKey, at];
      build = (state, next) => {
        const brief = state.requirements.get(designKey) ?? missing('该需求不存在');
        if (brief.sharedAt !== at) conflict('需求已重新交接，请刷新后阅读');
        next.briefs[designKey] = at;
      };
    } else {
      return invalidDesign('请选择设计库、稿件或需求阅读记录');
    }
    await this.mutate(projectId, actor, 'read-' + designDigest(JSON.stringify(identity)), input, ({ state }) => {
      const next = structuredClone(state.viewers.get(actor.id) ?? { designs: {}, briefs: {} });
      build(state, next);
      return { result: { type: 'viewed' }, changes: { viewing: { actorId: actor.id, state: next } } };
    }, requireProjectRead);
    const state = await this.load(projectId);
    return { projectId, viewer: structuredClone(state.viewers.get(actor.id) ?? { designs: {}, briefs: {} }) };
  }

  async reviewNotices(projectId: string, actor: DesignActor): Promise<DesignReviewNotice[]> {
    if (actor.kind !== 'human' || !actor.permissions.includes('read') || !actor.permissions.includes('approve')
      || !await this.deps.reviewer?.(projectId, actor.id)) return [];
    const state = await this.load(projectId);
    return (state.reviewNotices.get(actor.id) ?? []).filter(notice =>
      state.designs.get(notice.designId)?.reviewers?.some(reviewer => reviewer.id === actor.id));
  }

  private async reviewers(projectId: string, value: unknown): Promise<DesignReviewer[]> {
    if (!Array.isArray(value) || value.length > 20) return invalidDesign('请选择最多 20 位项目成员作为评审人');
    const ids = [...new Set(value.map(id => designId(id, '评审账号')))].sort();
    return Promise.all(ids.map(async id => {
      const person = await this.deps.reviewer?.(projectId, id);
      return person?.id === id ? person : invalidDesign('评审人必须是当前项目的有效人类成员');
    }));
  }

  async planningLinks(projectId: string): Promise<PlanningDesignLink[]> {
    const state = await this.load(projectId);
    const entries = [...state.designs.values()];
    const signoffs = await this.currentSignoffs(projectId, entries);
    return entries.map(entry => {
      const latest = entry.versions.at(-1)!;
      const run = signoffs.get(entry.id);
      return { id: entry.id, title: latest.title, version: latest.version, decisionIds: [...latest.decisionIds],
        frozen: entry.frozen, ...(run ? { signed: { runId: run.id, pullRequest: run.pullRequest, commit: run.commit } } : {}) };
    });
  }

  async artifact(projectId: string, actor: DesignActor, artifactId: string): Promise<DesignArtifact> {
    requireProjectRead(actor);
    const state = await this.load(projectId);
    const archived = state.deliveryFiles.get(artifactId);
    const storedId = archived?.archiveId ?? artifactId;
    const revision = state.assets.get(storedId) ?? missing('该稿件附件不存在');
    const asset = await this.store.readAsset?.(projectId, revision, storedId);
    if (!asset?.base64) return missing('该稿件附件不存在');
    const bytes = Buffer.from(asset.base64, 'base64');
    if (!archived) return { mime: asset.mime, bytes, ...(asset.mime === 'application/zip' ? { attachment: 'design-package.zip' } : {}) };

    const { file } = archived;
    const content = await readArchivedDesignFile(bytes, archived.root + file.path);
    if (!content || designDigest(content) !== file.sha256) return missing('该版本附件不可读');
    if (file.kind === 'prototype') return { mime: 'text/html; charset=utf-8', bytes: content, file };
    if (file.kind === 'render') return { mime: 'image/png', bytes: content, file };
    return { mime: file.text ? 'text/plain; charset=utf-8' : 'application/octet-stream', bytes: content, file,
      attachment: file.path.split('/').at(-1)! };
  }

  async publish(projectId: string, actor: DesignActor, query: Record<string, unknown>, bytes: Buffer) {
    requireProjectRead(actor);
    write(actor);
    const params = designRecord(query, '发布参数', ['requestId', 'designId', 'sourceCommit', 'sourcePath', 'note',
      'resolves', 'review', 'reviewerIds', 'requireGit', 'intent', 'designKey', 'expectedVersion', 'sourceMode']);
    const requestId = designId(params.requestId, '请求编号');
    const sourceCommit = designCommit(params.sourceCommit);
    const sourcePath = params.sourcePath === undefined ? undefined : designSourcePath(params.sourcePath);
    const targetId = params.designId === undefined ? undefined : designId(params.designId, '稿件编号');
    const { intent, designKey, expectedVersion } = readPublicationIntent(params, targetId, sourcePath);
    if (params.sourceMode !== undefined && params.sourceMode !== 'private') invalidDesign('私有归档须使用 sourceMode=private');
    const privateUpload = params.sourceMode === 'private';
    if (privateUpload && (!intent || sourcePath === undefined || sourcePath === '.')) {
      invalidDesign('私有归档须明确新稿或续版，并指定稿件子目录');
    }
    if (params.requireGit !== undefined && params.requireGit !== 'true') invalidDesign('Git 来源校验须使用 requireGit=true');
    if (privateUpload && params.requireGit === 'true') invalidDesign('私有归档和 Git 来源校验请选择一种');
    const requireGit = !privateUpload && Boolean(intent || actor.gitPublishOnly || params.requireGit === 'true');
    const note = optionalText(params.note, '发布说明', 1000);
    const loaded = await readDesignPackage(bytes);
    if (loaded.project !== projectId) invalidDesign('稿件包项目与当前 CDS 项目不符');
    if (intent === 'create' && loaded.packageId) invalidDesign('新稿的清单须省略稿件 id，由 CDS 分配');
    const selectedId = targetId ?? loaded.packageId;
    if (selectedId && loaded.packageId && selectedId !== loaded.packageId) invalidDesign('稿件包编号与目标稿件不符');
    let resolves: Record<string, string> = {};
    if (params.resolves !== undefined) {
      try { resolves = designRecord(JSON.parse(planningText(params.resolves, '评论处理声明', 12_000)), '评论处理声明') as Record<string, string>; }
      catch { return invalidDesign('评论处理声明须为评论编号和说明组成的 JSON 对象'); }
      if (Object.keys(resolves).length > 30) invalidDesign('一次发布最多处理 30 条评论');
      resolves = Object.fromEntries(Object.entries(resolves).map(([id, explanation]) =>
        [designId(id, '评论编号'), planningText(explanation, '处理说明', 1000)]));
    }
    if (params.review !== undefined && params.review !== 'true') invalidDesign('请求评审须使用 review=true');
    let reviewerIds: unknown;
    if (params.reviewerIds !== undefined) {
      try { reviewerIds = JSON.parse(planningText(params.reviewerIds, '评审账号', 3500)); }
      catch { return invalidDesign('评审账号须是 JSON 数组'); }
    }
    const archiveId = randomUUID();
    const frameworkChecks = new Map<string, DesignFrameworkCheck>();
    // Legacy receipts fingerprinted the ZIP bytes. Intake v1 reuses the Git package's file digest across repacking.
    const packageFingerprint = intent ? loaded.filesSha256 : loaded.sha256;
    return this.mutate(projectId, actor, requestId, { type: 'package', selectedId, sourceCommit, sourcePath, note, sha256: packageFingerprint, resolves,
      review: params.review, reviewerIds, ...(intent ? { intent, designKey, expectedVersion } : {}),
      ...(requireGit ? { requireGit } : {}), ...(privateUpload ? { sourceMode: 'private' } : {}) },
      async ({ state, now }) => {
        const id = selectedId ?? `DSN-${randomUUID().slice(0, 8).toUpperCase()}`;
        const existing = state.designs.get(id);
        const previous = existing?.versions.at(-1);
        if (targetId && !existing) missing('需要更新的稿件不存在，请先读设计接入清单');
        if (previous) authored(actor, previous.publisher);
        if (expectedVersion !== undefined && previous?.version !== expectedVersion) {
          intakeConflict(`稿件 ${id} 当前是 V${previous?.version}。请回读新版并确认基线后再续版`);
        }
        if (designKey && existing?.designKey && existing.designKey !== designKey) {
          intakeConflict(`稿件 ${id} 已绑定设计接入标识 ${existing.designKey}`);
        }
        if (designKey) {
          const keyOwner = [...state.designs.values()].find(entry => entry.id !== id && entry.designKey === designKey);
          if (keyOwner) intakeConflict(`接入标识已登记为稿件 ${keyOwner.id}。请先读取并按当前版本续发`);
        }
        if (sourcePath !== undefined && (!existing || !registeredDesignPaths(existing).includes(sourcePath))) {
          const matches = [...state.designs.values()].filter(entry => entry.id !== id && registeredDesignPaths(entry).includes(sourcePath));
          if (matches.length) {
            const candidates = matches.slice(0, 5).map(entry => `${entry.id}@V${entry.versions.at(-1)!.version}`).join('、');
            intakeConflict(`稿件目录已登记为 ${candidates}。请先读设计接入清单并确认目标版本`);
          }
        }
        if (!existing && !intent && actor.kind === 'agent' && state.designs.size > 0) {
          intakeConflict('项目已有设计稿。请先读设计接入清单，按稿件 ID 续版，或用 intent=create 和独立设计接入标识新建');
        }
        if (existing?.versions.some(version => version.sourceCommit === sourceCommit)) conflict('该稿件已经发布过此提交');
        const reviewers = reviewerIds === undefined ? existing?.reviewers : await this.reviewers(projectId, reviewerIds);
        const brief = state.requirements.get(designKey ?? existing?.designKey ?? '');
        if (!existing && brief?.assignee && brief.assignee.id !== actor.id && !actor.steward) {
          intakeConflict('此需求已分配给出稿人，请先在原需求完成交接');
        }
        const sharedScope = brief?.scope;
        const registeredScope = existing?.scope ?? sharedScope;
        if (loaded.scope && registeredScope && (loaded.scope.systemId !== registeredScope.systemId || loaded.scope.moduleId !== registeredScope.moduleId)) {
          intakeConflict('稿件已有主归属。请沿用该系统和模块，或请项目管理者调整归属后再续版');
        }
        const scope = loaded.scope ?? registeredScope;
        const configured = scope && validateScope(state, scope);
        const framework = loaded.framework ?? previous?.framework ?? configured?.module.framework ?? configured?.system.framework;
        const frame = framework ? state.frameworks.get(framework) : undefined;
        const revisions = frame?.versions;
        const inheritedVersion = adoptedFrameworkVersion(frame);
        const frameworkVersion = loaded.frameworkVersion ?? (previous?.framework === framework ? previous?.frameworkVersion : undefined)
          ?? (loaded.framework ? revisions?.at(-1)?.version : inheritedVersion);
        const frameworkRevision = revisions?.find(revision => revision.version === frameworkVersion);
        if (framework && !frameworkRevision) invalidDesign('稿件引用的框架版本不在当前项目');
        if (Object.keys(resolves).some(commentId => !existing?.comments.some(comment => comment.id === commentId && !comment.closed))) {
          invalidDesign('只能声明处理此稿件仍开放的评论');
        }
        const { title, sha256, rationale, screens, acceptance, spec, checks, group, tags, decisionIds } = loaded;
        const source = !privateUpload && sourcePath && await this.deps.sourcePackage?.(projectId, sourceCommit, sourcePath);
        if (requireGit && !source) rejectPlanning(409, 'design_git_source_required', '项目 Git 尚无法核验此稿件的提交和目录，请同步已提交的稿件再发布。');
        if (source && (await readDesignPackage(source)).filesSha256 !== loaded.filesSha256) conflict('上传内容与项目 Git 中的提交和目录不一致');
        let frameworkCheck: DesignFrameworkCheck | undefined;
        if (framework && frameworkRevision) {
          const key = framework + '/' + frameworkRevision.version;
          frameworkCheck = frameworkChecks.get(key) ?? await checkDesignFramework(framework,
            frameworkRevision, sourceCommit, loaded.prototype, screens, this.deps.frameworkProbe);
          frameworkChecks.set(key, frameworkCheck);
        }
        // Keep one private archive per revision. Preview and screenshot IDs point into
        // this archive, so large packages do not store the same bytes twice.
        const { index, prototype, ...manifest } = loaded.delivery;
        const files = index.map(file => ({ ...file, id: randomUUID() }));
        const byPath = new Map(files.map(file => [file.path, file]));
        const prototypeId = byPath.get(prototype)!.id;
        const delivery: DesignDelivery = { archiveId, files, ...manifest };
        const assets: ProjectRevisionAsset[] = [{ id: archiveId, mime: 'application/zip', base64: bytes.toString('base64') }];
        const renders: NonNullable<DesignVersion['renders']> = {};
        for (const capture of loaded.renders) {
          const { id } = byPath.get(`screens/${capture.screenId}.${capture.theme}.png`)!;
          const themes = renders[capture.screenId] ??= {};
          themes[capture.theme] = { id, sha256: capture.sha256 };
        }
        const version: DesignVersion = { version: (previous?.version ?? 0) + 1, title, sourceCommit, sha256, prototypeId,
          prototypeSha256: byPath.get(prototype)!.sha256, delivery,
          sourcePath, sourceVerification: privateUpload ? 'private-upload' : source ? 'git' : 'declared',
          createdAt: now, publisher: identity(actor), rationale, screens, acceptance, spec, checks, framework, frameworkVersion, group, tags, decisionIds, resolves, note,
          ...(scope ? { scope } : {}),
          ...(loaded.frameworkCharter ? { frameworkCharter: loaded.frameworkCharter } : {}),
          ...(frameworkCheck ? { frameworkCheck } : {}),
          ...(loaded.renders.length ? { renders } : {}) };
        return { result: { type: 'package', designId: id, version: version.version },
          changes: { design: { id, version, reviewers, ...(scope ? { scope } : {}), ...(designKey && !existing?.designKey ? { designKey } : {}),
            reviewRequested: Boolean(reviewers?.length) || params.review === 'true' || Boolean(existing?.frozen),
            ...(reviewers?.length ? { notifyReviewersAt: now } : {}) }, assets } };
      });
  }

  async feedback(projectId: string, actor: DesignActor, value: unknown): Promise<Receipt> {
    const input = designRecord(value, '设计反馈');
    const type = input.type;
    if (type === 'brief.claim' || type === 'brief.release') {
      designRecord(input, '设计需求认领', ['type', 'requestId', 'designKey', 'expectedVersion']);
      const requestId = designId(input.requestId, '请求编号');
      const designKey = designIntakeKey(input.designKey);
      const expectedVersion = number(input.expectedVersion, '需求版本');
      return this.mutate(projectId, actor, requestId, input, ({ state }) => {
        const brief = state.requirements.get(designKey) ?? missing('请先读取接入清单中的设计需求');
        if (brief.planVersion !== expectedVersion) conflict('需求已更新，请重新读取接入清单');
        if (type === 'brief.claim' && brief.assignee && brief.assignee.id !== actor.id) {
          conflict('此需求已有出稿人，请先在原需求说明交接');
        }
        if (type === 'brief.release' && brief.assignee?.id !== actor.id && !actor.steward) {
          forbidden('出稿人或项目管理者可以交回这条需求');
        }
        if ([...state.designs.values()].some(row => row.designKey === designKey)) conflict('此需求已出稿，请回读原稿');
        const assignee = type === 'brief.claim' ? identity(actor) : undefined;
        return { result: { type, id: 'BCL-' + designDigest(designKey).slice(0, 24), designKey, planId: brief.planId, version: expectedVersion },
          changes: { brief: { designKey, value: { ...brief, assignee } } } };
      });
    }
    if (type === 'brief.reply') {
      designRecord(input, '回复设计需求', ['type', 'requestId', 'designKey', 'expectedVersion', 'body']);
      const requestId = designId(input.requestId, '请求编号');
      const designKey = designIntakeKey(input.designKey);
      const expectedVersion = number(input.expectedVersion, '需求版本');
      const body = planningText(input.body, '需求回复', 4_000);
      return this.mutate(projectId, actor, requestId, input, ({ state, now }) => {
        const requirement = state.requirements.get(designKey) ?? missing('请先读取接入清单中的设计需求');
        if (requirement.planVersion !== expectedVersion) conflict('需求已更新，请重新读取接入清单');
        const id = `BRP-${randomUUID()}`;
        const reply = { id, author: identity(actor), body, at: now, planVersion: expectedVersion };
        return { result: { type, id, designKey, planId: requirement.planId, version: expectedVersion },
          changes: { brief: { designKey, value: { ...requirement, replies: [...(requirement.replies ?? []), reply] } } } };
      }, writeFeedback);
    }
    if (type !== 'feedback.create' && type !== 'feedback.reply' && type !== 'feedback.resolve' && type !== 'feedback.attach') {
      return invalidDesign('请选择提交反馈、回复、附图或确认处理');
    }
    const requestId = designId(input.requestId, '请求编号');
    const designIdValue = designId(input.designId, '稿件编号');
    const common = ['type', 'requestId', 'designId'];
    return this.mutate(projectId, actor, requestId, input, ({ state, now }) => {
      const entry = state.designs.get(designIdValue) ?? missing('该稿件不存在');
      if (type === 'feedback.create') {
        designRecord(input, '提交设计反馈', [...common, 'version', 'category', 'title', 'body', 'screenId', 'filePath', 'evidence']);
        const version = versionOf(entry, input.version);
        const category = designFeedbackCategories.find(kind => kind === input.category) ?? invalidDesign('请选择有效的反馈分类');
        const screenId = input.screenId === undefined ? undefined : designId(input.screenId, '反馈画面');
        if (screenId && !version.screens.some(screen => screen.id === screenId)) invalidDesign('所选版本没有这个画面');
        const filePath = input.filePath === undefined ? undefined : designSourcePath(input.filePath);
        if (filePath && !version.delivery?.files.some(file => file.path === filePath)) invalidDesign('所选版本没有这个交付文件');
        if (input.evidence !== undefined && (!Array.isArray(input.evidence) || input.evidence.length > 8)) invalidDesign('证据最多八条');
        const evidence = (input.evidence as unknown[] | undefined)?.map(row => planningText(row, '反馈证据', 1_000)) ?? [];
        const feedback: DesignFeedback = { id: `FDB-${randomUUID()}`, version: version.version, screenId, category, evidence,
          ...(filePath ? { filePath } : {}),
          title: planningText(input.title, '反馈标题', 180), body: planningText(input.body, '反馈正文', 4_000),
          author: identity(actor), createdAt: now, status: 'open', replies: [], decisions: [] };
        return { result: { type, designId: entry.id, id: feedback.id, version: version.version },
          changes: { design: { id: entry.id, feedback } } };
      }
      const feedbackId = designId(input.feedbackId, '反馈编号');
      const thread = entry.feedback?.find(item => item.id === feedbackId) ?? missing('该反馈不存在');
      if (type === 'feedback.attach') {
        designRecord(input, '添加反馈附件', [...common, 'feedbackId', 'title', 'image', 'version', 'screenId', 'slot']);
        const attachments = thread.attachments ?? [];
        const title = planningText(input.title, '附件说明', 180);
        const version = versionOf(entry, input.version ?? thread.version);
        const screenId = input.screenId === undefined
          ? version.version === thread.version ? thread.screenId : undefined
          : designId(input.screenId, '证据画面');
        const screen = version.screens.find(row => row.id === screenId);
        if (screenId && !screen) invalidDesign('所选版本没有这个画面');
        const slot = input.slot === undefined ? undefined : designSlots.find(value => value === input.slot) ?? invalidDesign('不支持的证据视口和主题');
        if (slot && (!screen || !screen.themes.some(theme => slot === `${screen.viewport}-${theme}`))) invalidDesign('证据视口和主题不适用于所选画面');
        const asset = image(input.image);
        const content = Buffer.from(asset.base64!, 'base64');
        const sha256 = designDigest(content);
        const existing = attachments.find(row => row.sha256 === sha256 && row.title === title && (row.version ?? thread.version) === version.version
          && (row.screenId ?? ((row.version ?? thread.version) === thread.version ? thread.screenId : undefined)) === screenId && row.slot === slot);
        const result = { type, designId: entry.id, id: feedbackId, version: version.version, artifactId: existing?.id ?? asset.id };
        if (existing) return { result, changes: {} };
        if (attachments.length >= 32) conflict('此反馈已有 32 张证据图');
        return { result, changes: { assets: [asset], design: { id: entry.id, feedback: { ...thread, attachments: [...attachments,
          { id: asset.id, title, size: content.length, sha256, author: identity(actor), at: now, version: version.version, screenId, slot }] } } } };
      }
      const body = planningText(input.body, '处理说明', 4_000);
      const feedback = { ...thread };
      if (type === 'feedback.reply') {
        designRecord(input, '回复设计反馈', [...common, 'feedbackId', 'body', 'revision']);
        if (thread.status === 'closed') conflict('请由反馈者或项目管理者重开后再回复');
        const revision = input.revision === undefined ? undefined : versionOf(entry, input.revision);
        if (revision) {
          authored(actor, revision.publisher);
          if (revision.version < thread.version) invalidDesign('回复引用的版本不能早于反馈版本');
        }
        feedback.replies = [...thread.replies, { body, revision: revision?.version, author: identity(actor), at: now }];
        if (actor.id !== thread.author.id) feedback.status = 'responded';
      } else {
        designRecord(input, '确认设计反馈', [...common, 'feedbackId', 'body', 'decision']);
        authored(actor, thread.author);
        const decision = input.decision;
        if (decision !== 'close' && decision !== 'reopen') return invalidDesign('请选择确认关闭或重新打开');
        if ((decision === 'close') === (thread.status === 'closed')) conflict('反馈已是所选状态，请先回读当前反馈');
        feedback.status = decision === 'close' ? 'closed' : 'open';
        feedback.decisions = [...thread.decisions, { decision, body, author: identity(actor), at: now }];
      }
      return { result: { type, designId: entry.id, id: feedbackId, version: thread.version },
        changes: { design: { id: entry.id, feedback } } };
    }, writeFeedback);
  }

  async command(projectId: string, actor: DesignActor, value: unknown) {
    const input = designRecord(value, '设计命令');
    const type = planningText(input.type, '命令类型', 60);
    const requestId = designId(input.requestId, '请求编号');
    if (type === 'brief.share' || type === 'brief.revoke') {
      review(actor);
      if (!actor.steward) forbidden('请由项目管理者确认将此需求交给设计');
      return this.mutate(projectId, actor, requestId, input, context => this.updateRequirement(type, input, context));
    }
    if (type === 'scope.register' || type === 'scope.assign') {
      review(actor);
      if (!actor.steward) forbidden('请由项目管理者配置设计归属');
      return this.mutate(projectId, actor, requestId, input, context => this.updateScope(type, input, context));
    }
    if (type === 'share.prepare') {
      requireProjectRead(actor);
      review(actor);
    }
    return this.mutate(projectId, actor, requestId, input, async context => {
      if (type === 'framework.import' || type === 'framework.extract') return this.framework(type, input, context);
      const id = designId(input.designId, '稿件编号');
      const entry = context.state.designs.get(id) ?? missing('该稿件不存在');
      if (type.startsWith('comment.')) return this.comment(type, input, context, entry);
      if (type.startsWith('acceptance.')) return this.acceptance(type, input, context, entry);
      if (type === 'implementation.bind') return this.bindImplementation(input, context, entry);
      if (type === 'share.prepare') return this.prepareShare(input, context, entry);
      const result = { type, designId: id };
      if (type === 'design.review') {
        designRecord(input, '稿件评审请求', ['type', 'requestId', 'designId', 'reviewerIds']);
        authored(actor, entry.versions.at(-1)!.publisher);
        const reviewers = await this.reviewers(projectId, input.reviewerIds);
        const currentVersion = entry.versions.at(-1)!.version;
        const reviewRequested = entry.frozen !== currentVersion && reviewers.length > 0;
        return { result: { ...result, version: currentVersion }, changes: { design: { id, reviewers, reviewRequested,
          ...(reviewRequested ? { notifyReviewersAt: context.now } : {}) } } };
      }
      if (type === 'design.freeze') {
        designRecord(input, '定稿请求', ['type', 'requestId', 'designId', 'version']);
        review(actor);
        if (entry.reviewers?.length && (!entry.reviewers.some(reviewer => reviewer.id === actor.id) || !await this.deps.reviewer?.(projectId, actor.id))) {
          forbidden('请由此稿件的指定评审人定稿');
        }
        const version = versionOf(entry, input.version).version;
        if (entry.versions.at(-1)!.version !== version) conflict('请切到最新稿件版本后定稿');
        if (entry.frozen === version) return { result: { ...result, version }, changes: {} };
        return { result: { ...result, version }, changes: { design: { id, frozen: version,
          freeze: { version, at: context.now, by: actor.label }, reviewRequested: false } } };
      }
      if (type === 'design.unfreeze') {
        designRecord(input, '撤销定稿请求', ['type', 'requestId', 'designId', 'version']);
        review(actor);
        const assigned = entry.reviewers?.length;
        if (!actor.steward && assigned && (!entry.reviewers?.some(reviewer => reviewer.id === actor.id)
          || !await this.deps.reviewer?.(projectId, actor.id))) forbidden('请由此稿件的指定评审人或系统所有者撤销定稿');
        const version = versionOf(entry, input.version).version;
        if (entry.frozen !== version) conflict('当前定稿已变化，请刷新稿件后再操作');
        return { result: { ...result, version }, changes: { design: { id,
          unfreeze: { version, at: context.now, by: actor.label }, reviewRequested: Boolean(entry.reviewers?.length) } } };
      }
      if (type === 'design.link') {
        designRecord(input, '关联 PR 请求', ['type', 'requestId', 'designId', 'pullRequest']);
        review(actor);
        const pullRequest = number(input.pullRequest, '拉取请求');
        if (!(await this.deps.resolvePreview?.(projectId, pullRequest))) conflict('当前项目的该拉取请求没有可验证的预览');
        return { result, changes: { design: { id, pullRequest } } };
      }
      return invalidDesign('不支持的设计命令');
    });
  }

  private bindImplementation(input: Record<string, unknown>, { actor, now }: Context, entry: DesignEntry): Update {
    review(actor);
    designRecord(input, '实现画面定位', ['type', 'requestId', 'designId', 'version', 'screens']);
    const version = versionOf(entry, input.version);
    if (entry.runs.some(run => run.version === version.version)) conflict('已有验收记录，请在新版本更新画面定位');
    if (!Array.isArray(input.screens) || !input.screens.length || input.screens.length > version.screens.length) {
      return invalidDesign('请选择这一版的画面并填写实际页面地址');
    }
    const seen = new Set<string>();
    const screens = input.screens.map(value => {
      const row = designRecord(value, '实现画面', ['screenId', 'path', 'readySelector']);
      const screenId = designId(row.screenId, '画面编号');
      if (seen.has(screenId)) invalidDesign('同一次操作不能重复指定画面');
      if (!version.screens.some(screen => screen.id === screenId)) missing('该版本没有此画面');
      seen.add(screenId);
      return { screenId, path: localDesignPath(row.path), readySelector: planningText(row.readySelector, '画面就绪选择器', 300), by: actor.label, at: now };
    });
    return { result: { type: 'implementation.bind', designId: entry.id, version: version.version },
      changes: { design: { id: entry.id, implementation: { version: version.version, screens } } } };
  }

  private updateScope(type: 'scope.register' | 'scope.assign', input: Record<string, unknown>, { state }: Context): Update {
    if (type === 'scope.assign') {
      designRecord(input, '稿件归属', ['type', 'requestId', 'designId', 'systemId', 'moduleId', 'related']);
      const id = designId(input.designId, '稿件编号');
      const entry = state.designs.get(id) ?? missing('该稿件不存在');
      const scope = parseDesignScope({ systemId: input.systemId, moduleId: input.moduleId, related: input.related });
      validateScope(state, scope);
      const shared = entry.designKey && state.requirements.get(entry.designKey)?.scope;
      if (shared && (scope.systemId !== shared.systemId || scope.moduleId !== shared.moduleId)) {
        conflict('同一接入标识的稿件与已交接需求须归到同一模块');
      }
      return { result: { type, designId: id }, changes: { design: { id, scope } } };
    }
    designRecord(input, '登记设计归属', ['type', 'requestId', 'systemId', 'systemName', 'moduleId', 'moduleName', 'framework', 'note']);
    const id = designScopeId(input.systemId, '系统编号');
    const prior = state.systems.get(id);
    const name = input.systemName === undefined && prior ? prior.name : planningText(input.systemName, '系统名称', 80);
    const framework = input.framework == null ? undefined : designId(input.framework, '框架编号');
    if (framework && adoptedFrameworkVersion(state.frameworks.get(framework)) === undefined) {
      invalidDesign('默认框架须在当前项目有可采用版本');
    }
    const modules = [...(prior?.modules ?? [])];
    const system: DesignSystem = { id, name, modules, ...(prior?.framework ? { framework: prior.framework } : {}) };
    if (input.moduleId === undefined) {
      if (input.moduleName !== undefined || input.note !== undefined) invalidDesign('请提供模块编号');
      if (input.framework !== undefined) system.framework = framework;
    } else {
      const moduleId = designScopeId(input.moduleId, '模块编号');
      const former = modules.find(row => row.id === moduleId);
      const moduleName = input.moduleName === undefined && former ? former.name : planningText(input.moduleName, '模块名称', 80);
      const note = input.note === null ? undefined : optionalText(input.note, '模块适用说明', 1000) ?? former?.note;
      replace(modules, { id: moduleId, name: moduleName,
        framework: input.framework === undefined ? former?.framework : framework, ...(note ? { note } : {}) });
    }
    return { result: { type, id }, changes: { system } };
  }

  private async updateRequirement(type: 'brief.share' | 'brief.revoke', input: Record<string, unknown>,
    { projectId, actor, state, now }: Context): Promise<Update> {
    designRecord(input, '设计需求交接', ['type', 'requestId', 'planId', 'designKey', 'expectedVersion',
      ...(type === 'brief.share' ? ['systemId', 'moduleId'] : [])]);
    const designKey = designIntakeKey(input.designKey);
    const planId = designId(input.planId, '计划编号');
    const expectedVersion = number(input.expectedVersion, '计划版本');
    const prior = state.requirements.get(designKey);
    const result = { type, designKey, planId, version: expectedVersion };
    if (type === 'brief.revoke') {
      if (!prior || prior.planId !== planId) return missing('未找到这条已交给设计的需求');
      if (prior.planVersion !== expectedVersion) return conflict('共享需求的版本已更新，请刷新后再操作');
      return { result, changes: { brief: { designKey, value: null } } };
    }
    if (prior && prior.planId !== planId) return conflict('此设计接入标识已关联另一条需求，请先核对原交接记录');
    if ([...state.requirements.values()].some(row => row.planId === planId && row.designKey !== designKey)) {
      return conflict('此计划已经交给设计，请沿用已有的接入标识');
    }
    const approved = await this.deps.approvedPlanFor?.(projectId, planId);
    if (!approved) return missing('此项目没有已确认并附原文的计划');
    if (approved.planVersion !== expectedVersion) return conflict('计划已更新，请刷新计划并核对要共享的版本');
    const draftScope = [...state.designs.values()].find(row => row.designKey === designKey)?.scope;
    const selected = input.systemId === undefined && input.moduleId === undefined ? undefined
      : parseDesignScope({ systemId: input.systemId, moduleId: input.moduleId });
    const scope = selected ?? prior?.scope ?? draftScope;
    if (scope) validateScope(state, scope);
    if (draftScope && scope && (scope.systemId !== draftScope.systemId || scope.moduleId !== draftScope.moduleId)) {
      conflict('同一接入标识的稿件与已交接需求须归到同一模块');
    }
    if (prior?.planVersion === expectedVersion && !selected) return { result, changes: {} };
    return { result, changes: { brief: { designKey, value: { ...prior, ...approved, designKey, planId,
      sharedAt: prior?.planVersion === expectedVersion ? prior.sharedAt : now, owner: prior?.owner ?? identity(actor),
      ...(scope ? { scope } : {}) } } } };
  }

  private prepareShare(input: Record<string, unknown>, { actor, now }: Context, entry: DesignEntry): Update {
    designRecord(input, '准备分享', ['type', 'requestId', 'designId', 'version', 'sourceCommit', 'packageSha256', 'audience', 'expiresInHours']);
    const version = versionOf(entry, input.version);
    if (entry.frozen !== version.version && !entry.freezes?.some(row => row.version === version.version)) {
      conflict('请先定稿要分享的版本');
    }
    if (version.sourceVerification !== 'git' || version.sourceCommit !== designCommit(input.sourceCommit)
      || version.sha256 !== input.packageSha256) conflict('请使用 Git 已核实的稿件提交与内容摘要');
    const audience = input.audience;
    if (audience !== 'public' && audience !== 'password') return invalidDesign('请选择分享受众');
    const expiresInHours = number(input.expiresInHours, '分享有效小时数', 365 * 24);
    const prepared: DesignSharePreparation = {
      id: `SHARE-${randomUUID()}`, version: version.version, sourceCommit: version.sourceCommit, packageSha256: version.sha256,
      audience, expiresInHours, state: 'awaiting_human_confirmation', preparedAt: now, preparedBy: identity(actor),
    };
    return { result: { type: 'share.prepare', designId: entry.id, id: prepared.id, version: prepared.version,
      sourceCommit: prepared.sourceCommit, state: prepared.state },
      changes: { design: { id: entry.id, sharePreparation: prepared } } };
  }

  async shareHandoff(projectId: string, actor: DesignActor, preparationId: string, body: unknown,
    config: DesignShareHandoffConfig | undefined) {
    requireProjectRead(actor);
    review(actor);
    const input = designRecord(body, '分享交接', ['designId']);
    const id = designId(input.designId, '稿件编号');
    const state = await this.load(projectId);
    const design = state.designs.get(id) ?? missing('该稿件不存在');
    const preparation = design.sharePreparations?.find(row => row.id === preparationId) ?? missing('没有这条分享准备记录');
    const version = versionOf(design, preparation.version);
    if (design.reviewers?.length && !design.reviewers.some(reviewer => reviewer.id === actor.id)) forbidden('请由稿件的指定评审人交接');
    if (version.sourceVerification !== 'git' || version.sourceCommit !== preparation.sourceCommit || version.sha256 !== preparation.packageSha256
      || (design.frozen !== version.version && !design.freezes?.some(row => row.version === version.version))) {
      conflict('要分享的版本已不符合原定稿记录');
    }
    if (!config) return rejectPlanning(503, 'design_share_unavailable', '当前实例尚未接入 MAP 真人确认');
    const binding = config.resolve(projectId, id, version.version, actor.id) ?? forbidden('该版本与当前评审人暂无 MAP 对应授权');
    const prototype = await this.artifact(projectId, actor, version.prototypeId);
    return issueDesignShareHandoff(config, binding, projectId, id, preparation, designDigest(prototype.bytes));
  }

  private comment(type: string, input: Record<string, unknown>, { actor, now }: Context, entry: DesignEntry): Update {
    let comment: DesignComment;
    if (type === 'comment.create') {
      designRecord(input, '评论请求', ['type', 'requestId', 'designId', 'version', 'screenId', 'body', 'x', 'y']);
      review(actor);
      const version = versionOf(entry, input.version);
      const screenId = designId(input.screenId, '画面编号');
      if (!version.screens.some(screen => screen.id === screenId)) missing('该版本没有此画面');
      comment = { id: `C-${randomUUID()}`, version: version.version, screenId, body: planningText(input.body, '评论正文', 4000),
        x: ratio(input.x), y: ratio(input.y), createdAt: now, author: identity(actor), closed: false, replies: [], reviews: [] };
    } else {
      const id = designId(input.commentId, '评论编号');
      const original = entry.comments.find(row => row.id === id) ?? missing('该评论不存在');
      if (original.closed) conflict('该评论已经关闭');
      comment = structuredClone(original);
      if (type === 'comment.reply') {
        designRecord(input, '回复请求', ['type', 'requestId', 'designId', 'commentId', 'body']);
        if (comment.replies.length >= 100) conflict('这条评论已有 100 条回复');
        comment.replies.push({ body: planningText(input.body, '回复正文', 4000), author: identity(actor), createdAt: now });
      } else if (type === 'comment.review') {
        designRecord(input, '核对评论请求', ['type', 'requestId', 'designId', 'commentId', 'version', 'decision', 'body']);
        review(actor);
        authored(actor, comment.author);
        const version = versionOf(entry, input.version);
        const declaration = entry.versions.slice().reverse().find(row => Object.hasOwn(row.resolves, id));
        if (!declaration || declaration.version !== version.version || comment.reviews.some(row => row.version === version.version)) {
          conflict('请核对最新声明处理此评论的版本');
        }
        const decision = input.decision;
        if (decision !== 'resolved' && decision !== 'rejected') return invalidDesign('请选择关闭或退回评论');
        const body = optionalText(input.body, '核对说明', 2000) ?? '';
        if (decision === 'rejected' && !body) invalidDesign('退回时请写明仍需修改的地方');
        comment.reviews.push({ version: version.version, decision, body, at: now, by: actor.id });
        comment.closed = decision === 'resolved';
      } else return invalidDesign('不支持的评论命令');
    }
    return { result: { type, designId: entry.id, id: comment.id }, changes: { design: { id: entry.id, comment } } };
  }

  private async acceptance(type: string, input: Record<string, unknown>, context: Context, entry: DesignEntry): Promise<Update> {
    const { actor, projectId, now } = context;
    const id = entry.id;
    let run: DesignRun;
    const assets: ProjectRevisionAsset[] = [];
    if (type === 'acceptance.start') {
      designRecord(input, '发起验收请求', ['type', 'requestId', 'designId', 'version', 'pullRequest', 'commit']);
      const version = implementationVersion(entry, versionOf(entry, input.version));
      if (entry.frozen !== version.version) conflict('请先定稿要验收的版本');
      if (!version.acceptance.length) conflict('这一版尚未声明验收项');
      const pullRequest = number(input.pullRequest ?? entry.pullRequest, '拉取请求');
      const commit = input.commit === undefined ? undefined : designCommit(input.commit);
      const preview = await this.deps.resolvePreview?.(projectId, pullRequest, commit);
      if (!preview || (commit && commit !== preview.commit)) return conflict('当前预览没有部署到指定提交');
      const cells = version.acceptance.flatMap(item => item.slots.map((slot): DesignCell => {
        const hasRoute = screenPath(version, item.id, slot);
        return { itemId: item.id, slot, status: hasRoute ? 'unverified' : 'missing',
          actual: hasRoute ? '尚未执行' : '画面清单没有声明唯一匹配的实现地址' };
      }));
      run = { id: `RUN-${randomUUID()}`, version: version.version, pullRequest, commit: preview.commit,
        previewUrl: preview.url, createdAt: now, cells, verdict: 'needs_evidence', issues: {} };
    } else {
      run = structuredClone(runOf(entry, input.runId));
      const version = implementationVersion(entry, versionOf(entry, run.version));
      if (run.signed) conflict('该运行已经签收，请创建新运行');
      if (type === 'acceptance.record') {
        designRecord(input, '验收回填', ['type', 'requestId', 'designId', 'runId', 'commit', 'cells']);
        if (run.pullRequest !== entry.pullRequest) conflict('关联 PR 已变更，请对当前 PR 重新运行。');
        if (designCommit(input.commit) !== run.commit) conflict('验收证据的提交与冻结运行不符');
        const current = await this.deps.resolvePreview?.(projectId, run.pullRequest, run.commit);
        if (!current || current.commit !== run.commit || current.url !== run.previewUrl) conflict('预览已经变化，请对新提交重跑');
        if (!Array.isArray(input.cells) || input.cells.length < 1 || input.cells.length > 4) return invalidDesign('请提交 1 至 4 个验收结果');
        const seen = new Set<string>();
        for (const value of input.cells) {
          const next = designRecord(value, '验收格', ['itemId', 'slot', 'status', 'actual', 'image', 'debtId', 'measured']);
          const itemId = designId(next.itemId, '验收项编号');
          const rule = version.acceptance.find(row => row.id === itemId) ?? missing('验收项不存在');
          const cell = run.cells.find(row => row.itemId === itemId && row.slot === next.slot) ?? missing('此验收项未声明这个视口或主题');
          const key = `${cell.itemId}/${cell.slot}`;
          if (seen.has(key)) invalidDesign('不能重复写入同一验收格');
          seen.add(key);
          const status = next.status;
          if (status !== 'passed' && status !== 'failed' && status !== 'missing' && status !== 'unverified') return invalidDesign('验收状态无效');
          const previousActual = cell.actual;
          cell.actual = planningText(next.actual, '实际结果或缺失原因', 2000);
          const expectedPath = screenPath(version, itemId, cell.slot);
          const assessed = status === 'passed' || status === 'failed';
          if (assessed && rule.how === 'human') review(actor);
          const reuseShot = assessed && next.image === undefined && next.measured === undefined && cell.imageId && cell.measured?.path === expectedPath;
          if (reuseShot) {
            cell.recordedBy = actor.label;
          } else if (assessed || (status === 'unverified' && next.image !== undefined)) {
            if (!expectedPath) conflict('请为当前验收格绑定实现地址后重跑');
            const screenshot = image(next.image);
            const measured = designRecord(next.measured, '实测视口', ['width', 'height', 'theme', 'path']);
            const width = number(measured.width, '视口宽度', 8192), height = number(measured.height, '视口高度', 8192);
            const theme = cell.slot.endsWith('-light') ? 'light' : 'dark';
            const png = Buffer.from(screenshot.base64!, 'base64');
            if (png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height
              || measured.theme !== theme || localDesignPath(measured.path) !== expectedPath
              || (cell.slot.startsWith('phone-') ? width < 320 || width > 479 : width < 900)) invalidDesign('证据路径、视口或主题与验收格不符');
            assets.push(screenshot);
            cell.imageId = screenshot.id;
            cell.measured = { width, height, theme, path: expectedPath! };
            if (assessed) cell.recordedBy = actor.label;
            else delete cell.recordedBy;
          } else {
            delete cell.imageId;
            delete cell.measured;
            delete cell.recordedBy;
          }
          const debtId = next.debtId === undefined ? (status === cell.status && previousActual === cell.actual ? cell.debtId : undefined)
            : designId(next.debtId, '债务编号');
          if (debtId && !(await this.deps.findDebt?.(projectId, debtId, `${id}/${run.id}/${itemId}`))) {
            invalidDesign('请引用此验收项关联的已入账债务');
          }
          cell.debtId = status === 'passed' ? undefined : debtId;
          cell.status = status;
        }
      } else if (type === 'acceptance.debt') {
        designRecord(input, '记债请求', ['type', 'requestId', 'designId', 'runId', 'itemId']);
        const itemId = designId(input.itemId, '验收项编号');
        const rule = version.acceptance.find(row => row.id === itemId) ?? missing('验收项不存在');
        const issues = run.cells.filter(cell => cell.itemId === itemId && cell.status !== 'passed');
        if (!issues.length) conflict('本验收项全部适用场景已通过');
        const sourceRef = `${id}/${run.id}/${itemId}`;
        let issue = run.issues[itemId];
        if (!issue) {
          if (!this.deps.createDebt) return rejectPlanning(503, 'design_unavailable', '工程债务暂不可用');
          issue = await this.deps.createDebt({ projectId, actor, sourceRef, title: `设计验收 ${rule.rule}`.slice(0, 120),
            actual: issues.map(cell => `${cell.slot} ${cell.actual}`).join('\n').slice(0, 3400),
            version: run.version, pullRequest: run.pullRequest, commit: run.commit, expected: rule.expected ?? rule.rule, high: rule.priority === 'high' });
          run.issues[itemId] = issue;
        }
        const debtId = issue.pending ? await this.deps.resolveDebtProposal?.(projectId, issue.id, sourceRef) : issue.id;
        if (debtId && await this.deps.findDebt?.(projectId, debtId, sourceRef)) {
          for (const cell of issues) cell.debtId = debtId;
          run.issues[itemId] = { id: debtId, pending: false };
        }
      } else if (type === 'acceptance.sign') {
        designRecord(input, '签收请求', ['type', 'requestId', 'designId', 'runId']);
        if (actor.kind !== 'human') forbidden('此操作需要有写权限的项目成员签收');
        if (run.pullRequest !== entry.pullRequest || run.version !== entry.frozen || run.version !== entry.versions.at(-1)!.version || run.id !== entry.runs.at(-1)?.id) {
          conflict('签收须对应最新已定稿版本及其最新运行');
        }
        const current = await this.deps.resolvePreview?.(projectId, run.pullRequest, run.commit);
        if (!current || current.commit !== run.commit || current.url !== run.previewUrl) conflict('预览提交已经变化，请重跑后签收');
        if (run.verdict !== 'passed' && run.verdict !== 'conditional') return conflict('验收通过或有条件通过后才能签收');
        for (const cell of run.cells) {
          if (cell.debtId && !(await this.deps.findDebt?.(projectId, cell.debtId, `${id}/${run.id}/${cell.itemId}`))) {
            conflict('关联的正式债务已经变化，请重新核对');
          }
        }
        run.signed = { at: now, by: actor.id, verdict: run.verdict };
      } else return invalidDesign('不支持的验收命令');
      run.verdict = evaluateDesignAcceptance(version.acceptance.map(rule => ({ id: rule.id, priority: rule.priority,
        cells: run.cells.filter(cell => cell.itemId === rule.id).map(cell => ({ ...cell, applicable: true })) })));
    }
    return { result: { type, designId: id, runId: run.id }, changes: {
      assets, design: { id, run, ...(type === 'acceptance.start' ? { pullRequest: run.pullRequest } : {}) },
    } };
  }

  private async framework(type: string, input: Record<string, unknown>, { projectId, actor, state, now }: Context): Promise<Update> {
    review(actor);
    const id = designId(input.frameworkId, '框架编号');
    const previous = state.frameworks.get(id);
    const current = previous?.versions.at(-1);
    if (input.expectedVersion !== (current?.version ?? 0)) conflict('框架已经变化，请重新读取当前版本');
    const sourcePath = input.sourcePath === undefined ? undefined : designSourcePath(input.sourcePath);
    const note = optionalText(input.note, '框架变更说明', 1000);
    let material: DesignMaterial;
    let from: { designId: string; version: number } | undefined;
    let sourceCommit: string;
    let derivedTitle: string | undefined;
    let charter = current?.charter;
    const resolutions: FrameworkResolutions = {};
    if (type === 'framework.import') {
      designRecord(input, '框架导入', ['type', 'requestId', 'frameworkId', 'expectedVersion', 'sourceCommit', 'sourcePath', 'title', 'material', 'charter', 'note']);
      material = parseMaterial(input.material);
      sourceCommit = designCommit(input.sourceCommit);
      if (input.charter !== undefined) charter = parseFrameworkCharter(input.charter);
    } else {
      designRecord(input, '提取框架', ['type', 'requestId', 'frameworkId', 'expectedVersion', 'sourceCommit', 'sourcePath', 'title', 'designId', 'version', 'keys', 'resolutions', 'note']);
      const designIdValue = designId(input.designId, '稿件编号');
      const design = state.designs.get(designIdValue) ?? missing('该稿件不存在');
      const version = versionOf(design, input.version);
      if (design.frozen !== version.version) conflict('只能提取定稿版本');
      sourceCommit = input.sourceCommit === undefined ? version.sourceCommit : designCommit(input.sourceCommit);
      derivedTitle = `${version.title.slice(0, 140)}框架`;
      const keys = input.keys ?? designMaterialKeys;
      if (!Array.isArray(keys) || !keys.length || keys.some(key => !designMaterialKeys.some(item => item === key))) return invalidDesign('请选择要提取的令牌、组件、规则或骨架');
      const candidates = frameworkMaterialCandidates(version.spec, current?.material);
      const conflicts = candidates.filter(row => row.state === 'conflict').map(row => row.key);
      const choices = input.resolutions === undefined ? {} : designRecord(input.resolutions, '候选冲突选择', conflicts);
      for (const key of conflicts) {
        const choice = choices[key];
        if (choice === undefined) continue;
        if (choice !== 'keep' && choice !== 'adopt') return invalidDesign('请选择保留现有或采用候选');
        if (choice === 'adopt' && !keys.includes(key)) return invalidDesign('选择采用的冲突项必须包含在本次材料里');
        resolutions[key] = choice;
      }
      if (frameworkInUse(id, current, state.designs.values()) && conflicts.some(key => !resolutions[key])) {
        conflict('框架正在使用，请逐项确认保留现有或采用候选');
      }
      material = { ...current?.material };
      const selected = candidates.filter(({ key, state }) => state !== 'same' && keys.includes(key) && resolutions[key] !== 'keep');
      if (!selected.length) conflict('勾选的条目已存在，或稿件没有这些材料');
      for (const { key } of selected) {
        Object.assign(material, { [key]: version.spec[key] });
      }
      from = { designId: designIdValue, version: version.version };
      if (!current) charter = draftCharter(projectId, version);
    }
    if (previous?.versions.some(version => version.sourceCommit === sourceCommit
      && (input.sourceCommit !== undefined || stableJson(version.material) === stableJson(material)))) {
      conflict('该框架已经导入过此提交');
    }
    if (!designMaterialKeys.some(key => material[key] !== undefined)) invalidDesign('框架至少需要一种设计材料');
    const version = (current?.version ?? 0) + 1;
    const title = planningText(input.title === undefined ? current?.title ?? derivedTitle : input.title, '框架名称', 150);
    const archive = sourcePath && await this.deps.sourcePackage?.(projectId, sourceCommit, sourcePath);
    if (archive) {
      let reference: Awaited<ReturnType<typeof readDesignFrameworkSource>>;
      try { reference = await readDesignFrameworkSource(archive); }
      catch { return conflict('项目 Git 中的目录缺少可读取的框架材料'); }
      const normalize = (spec: DesignMaterial) => stableJson(Object.fromEntries(Object.entries(spec).map(([key, value]) =>
        [key, typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : value])));
      if (normalize(reference.material) !== normalize(material)) conflict('框架材料与项目 Git 中的提交和目录不一致');
      if (type === 'framework.import') {
        if (input.charter !== undefined && stableJson(reference.charter) !== stableJson(charter)) {
          conflict('框架初衷与范围和项目 Git 中的文件不一致');
        }
        if (reference.charter) charter = reference.charter;
      }
    }
    const exampleRef = charter?.example;
    if (exampleRef) {
      const example = state.designs.get(exampleRef.designId);
      if (!example?.versions.some(row => row.version === exampleRef.version)) missing('当前项目没有该示意稿版本');
    }
    const revision = { version, title, sourceCommit, sourcePath, sourceVerification: archive ? 'git' as const : 'declared' as const,
      at: now, by: actor.id, from, material, note, ...(charter ? { charter } : {}),
      ...(Object.keys(resolutions).length ? { resolutions } : {}) };
    return { result: { type, frameworkId: id, version },
      changes: { framework: { id, projectId, versions: [...(previous?.versions ?? []), revision] } } };
  }
}
