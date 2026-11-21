import { randomUUID } from 'node:crypto';
import type {
  DesignCell, DesignComment, DesignEntry, DesignFramework, DesignFrameworkCheck, DesignMaterial, DesignReviewer, DesignReviewNotice, DesignRun, DesignSlot, DesignVersion, DesignWorkspace,
  DesignSharePreparation,
} from '../shared/design-workspace.js';
import type { PlanningActor, PlanningDesignLink } from '../shared/engineering-planning.js';
import { currentDesignRun, designSlots } from '../shared/design-workspace.js';
import { evaluateDesignAcceptance } from './design-acceptance.js';
import { checkDesignFramework, type DesignFrameworkProbe } from './design-framework-check.js';
import { issueDesignShareHandoff, type DesignShareHandoffConfig } from './design-share-handoff.js';
import {
  designCommit, designDigest, designId, designPngDimensions, designRecord, designSourcePath, invalidDesign, localDesignPath,
  readDesignFrameworkSource, readDesignPackage,
} from './design-package.js';
import { planningText, rejectPlanning } from './engineering-planning-input.js';
import type { ProjectRevisionAsset, ProjectRevisionStore } from './project-revision-store.js';

export type DesignActor = PlanningActor & { steward?: boolean; gitPublishOnly?: boolean };
type Receipt = {
  projectId: string; reused: boolean;
  result: { type: string; designId?: string; version?: number; id?: string; frameworkId?: string; runId?: string;
    state?: DesignSharePreparation['state']; sourceCommit?: string };
};
type RequestReceipt = { key: string; fingerprint: string; result: Receipt['result'] };
export type DesignWorkspaceCommit = {
  projectId: string; revision: number; request: RequestReceipt; assets?: ProjectRevisionAsset[];
  design?: { id: string; version?: DesignVersion; comment?: DesignComment; run?: DesignRun;
    frozen?: number; freeze?: NonNullable<DesignEntry['freezes']>[number]; pullRequest?: number; reviewRequested?: boolean;
    reviewers?: DesignReviewer[]; notifyReviewersAt?: string; sharePreparation?: DesignSharePreparation };
  framework?: DesignFramework;
};
type Changes = Pick<DesignWorkspaceCommit, 'assets' | 'design' | 'framework'>;
type Preview = { commit: string; url: string };
type WorkspaceState = {
  revision: number; designs: Map<string, DesignEntry>; frameworks: Map<string, DesignFramework>;
  requests: Map<string, RequestReceipt>; assets: Map<string, number>;
  reviewNotices: Map<string, DesignReviewNotice[]>;
};
type Context = { projectId: string; actor: DesignActor; state: WorkspaceState; now: string };
type Update = { result: Receipt['result']; changes: Changes };

const missing = (message: string): never => rejectPlanning(404, 'design_not_found', message);
const conflict = (message: string): never => rejectPlanning(409, 'design_conflict', message);
const forbidden = (message: string): never => rejectPlanning(403, 'design_forbidden', message);
const identity = ({ id, label }: DesignActor) => ({ id, label });
const reviewNoticeWindow = 60 * 60_000;
const reviewNoticeLimit = 50;
const write = (actor: DesignActor) => {
  if (!actor.permissions.includes('write')) forbidden('当前身份无权写入稿件');
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

function apply(state: WorkspaceState, commit: DesignWorkspaceCommit) {
  state.revision = commit.revision;
  state.requests.set(commit.request.key, commit.request);
  for (const asset of commit.assets ?? []) state.assets.set(asset.id, commit.revision);
  if (commit.framework) state.frameworks.set(commit.framework.id, commit.framework);
  if (commit.design) {
    const update = commit.design;
    const previous = state.designs.get(update.id);
    const design: DesignEntry = previous ? { ...previous, versions: [...previous.versions], comments: [...previous.comments], runs: [...previous.runs] }
      : { id: update.id, projectId: commit.projectId, versions: [], comments: [], runs: [] };
    state.designs.set(update.id, design);
    if (update.version) design.versions.push(update.version);
    if (update.comment) replace(design.comments, update.comment);
    if (update.run) replace(design.runs, update.run);
    if (update.frozen !== undefined) design.frozen = update.frozen;
    if (update.freeze) design.freezes = [...(design.freezes ?? []), update.freeze];
    if (update.pullRequest !== undefined) design.pullRequest = update.pullRequest;
    if (update.reviewRequested !== undefined) design.reviewRequested = update.reviewRequested;
    if (update.reviewers !== undefined) design.reviewers = update.reviewers;
    if (update.sharePreparation) design.sharePreparations = [...(design.sharePreparations ?? []), update.sharePreparation];
    if (update.notifyReviewersAt) {
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

function versionOf(design: DesignEntry, value: unknown): DesignVersion {
  const version = number(value, '稿件版本');
  return design.versions.find(row => row.version === version) ?? missing('该稿件版本不存在');
}

function runOf(design: DesignEntry, value: unknown): DesignRun {
  const id = designId(value, '验收运行');
  return design.runs.find(row => row.id === id) ?? missing('该验收运行不存在');
}

function screenPath(version: DesignVersion, itemId: string, slot: DesignSlot) {
  const rule = version.acceptance.find(item => item.id === itemId)!;
  const [viewport, theme] = slot.split('-') as ['desktop' | 'phone', 'light' | 'dark'];
  const screens = rule.screenId ? version.screens.filter(screen => screen.id === rule.screenId)
    : version.screens.filter(screen => screen.viewport === viewport);
  const targets = new Map<string, string>();
  for (const screen of screens) {
    if (screen.impl && screen.themes.includes(theme)) {
      targets.set(JSON.stringify([screen.impl, screen.readySelector ?? null]), screen.impl);
    }
  }
  return targets.size === 1 ? targets.values().next().value ?? null : null;
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

const materialKeys = ['tokens', 'rules', 'components', 'skeleton'] as const;
function parseMaterial(value: unknown): DesignMaterial {
  const input = designRecord(value, '框架材料', [...materialKeys]);
  const tokens = input.tokens === undefined ? undefined : designRecord(input.tokens, '设计令牌');
  if (tokens && JSON.stringify(tokens).length > 120_000) invalidDesign('设计令牌超过字数限制');
  return { tokens, rules: optionalText(input.rules, '规则', 64 * 1024),
    components: optionalText(input.components, '组件', 64 * 1024), skeleton: optionalText(input.skeleton, '骨架', 64 * 1024) };
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
      designs: new Map(base?.designs), frameworks: new Map(base?.frameworks), assets: new Map(base?.assets), reviewNotices: new Map(base?.reviewNotices) };
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
    build: (context: Context) => Update | Promise<Update>): Promise<Receipt> {
    requireProjectRead(actor);
    write(actor);
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

  async workspace(projectId: string, actor: DesignActor): Promise<DesignWorkspace> {
    requireProjectRead(actor);
    const state = await this.load(projectId);
    const designs = structuredClone([...state.designs.values()].sort((a, b) =>
      b.versions.at(-1)!.createdAt.localeCompare(a.versions.at(-1)!.createdAt)));
    const previews = new Map<number, Promise<Preview | undefined>>();
    await Promise.all(designs.map(async entry => {
      const run = currentDesignRun(entry);
      if (!run?.signed) return;
      let target = previews.get(run.pullRequest);
      if (!target) {
        target = this.deps.resolvePreview?.(projectId, run.pullRequest).catch(() => undefined) ?? Promise.resolve(undefined);
        previews.set(run.pullRequest, target);
      }
      const preview = await target;
      entry.currentSignoffRunId = preview?.commit === run.commit && preview.url === run.previewUrl ? run.id : null;
    }));
    return { projectId, designs, frameworks: structuredClone([...state.frameworks.values()]),
      permissions: { write: actor.permissions.includes('write'), review: actor.kind === 'human' && actor.permissions.includes('approve'),
        sign: actor.kind === 'human' && actor.permissions.includes('write'),
        steward: actor.steward === true, actorId: actor.id } };
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
    return [...state.designs.values()].map(entry => {
      const latest = entry.versions.at(-1)!;
      const run = entry.runs.slice().reverse().find(row => row.signed && row.version === entry.frozen && row.pullRequest === entry.pullRequest);
      return { id: entry.id, title: latest.title, version: latest.version, decisionIds: [...latest.decisionIds],
        frozen: entry.frozen, ...(run ? { signed: { runId: run.id, pullRequest: run.pullRequest, commit: run.commit } } : {}) };
    });
  }

  async artifact(projectId: string, actor: DesignActor, artifactId: string) {
    requireProjectRead(actor);
    const state = await this.load(projectId);
    const revision = state.assets.get(artifactId) ?? missing('该稿件附件不存在');
    const asset = await this.store.readAsset?.(projectId, revision, artifactId);
    if (!asset?.base64) return missing('该稿件附件不存在');
    return { mime: asset.mime, bytes: Buffer.from(asset.base64, 'base64') };
  }

  async publish(projectId: string, actor: DesignActor, query: Record<string, unknown>, bytes: Buffer) {
    requireProjectRead(actor);
    write(actor);
    const params = designRecord(query, '发布参数', ['requestId', 'designId', 'sourceCommit', 'sourcePath', 'note', 'resolves', 'review', 'reviewerIds', 'requireGit']);
    const requestId = designId(params.requestId, '请求编号');
    const sourceCommit = designCommit(params.sourceCommit);
    const sourcePath = params.sourcePath === undefined ? undefined : designSourcePath(params.sourcePath);
    if (params.requireGit !== undefined && params.requireGit !== 'true') invalidDesign('Git 来源校验须使用 requireGit=true');
    const requireGit = Boolean(actor.gitPublishOnly || params.requireGit === 'true');
    const note = optionalText(params.note, '发布说明', 1000);
    const loaded = await readDesignPackage(bytes);
    if (loaded.project !== projectId) invalidDesign('稿件包项目与当前 CDS 项目不符');
    const selectedId = params.designId === undefined ? loaded.packageId : designId(params.designId, '稿件编号');
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
    const prototypeId = randomUUID();
    const frameworkChecks = new Map<number, DesignFrameworkCheck>();
    return this.mutate(projectId, actor, requestId, { type: 'package', selectedId, sourceCommit, sourcePath, note, sha256: loaded.sha256, resolves,
      review: params.review, reviewerIds, ...(requireGit ? { requireGit } : {}) },
      async ({ state, now }) => {
        const id = selectedId ?? `DSN-${randomUUID().slice(0, 8).toUpperCase()}`;
        const existing = state.designs.get(id);
        const previous = existing?.versions.at(-1);
        if (params.designId !== undefined && !existing) missing('需要更新的稿件不存在');
        if (previous) authored(actor, previous.publisher);
        if (existing?.versions.some(version => version.sourceCommit === sourceCommit)) conflict('该稿件已经发布过此提交');
        const reviewers = reviewerIds === undefined ? existing?.reviewers : await this.reviewers(projectId, reviewerIds);
        const revisions = loaded.framework ? state.frameworks.get(loaded.framework)?.versions : undefined;
        const frameworkVersion = loaded.frameworkVersion ?? (previous?.framework === loaded.framework ? previous?.frameworkVersion : undefined)
          ?? revisions?.at(-1)?.version;
        const frameworkRevision = revisions?.find(revision => revision.version === frameworkVersion);
        if (loaded.framework && !frameworkRevision) invalidDesign('稿件引用的框架版本不在当前项目');
        if (Object.keys(resolves).some(commentId => !existing?.comments.some(comment => comment.id === commentId && !comment.closed))) {
          invalidDesign('只能声明处理此稿件仍开放的评论');
        }
        const { title, sha256, rationale, screens, acceptance, spec, checks, framework, group, tags, decisionIds } = loaded;
        const source = sourcePath && await this.deps.sourcePackage?.(projectId, sourceCommit, sourcePath);
        if (requireGit && !source) rejectPlanning(409, 'design_git_source_required', '项目 Git 尚无法核验此稿件的提交和目录，请同步已提交的稿件再发布。');
        if (source && (await readDesignPackage(source)).filesSha256 !== loaded.filesSha256) conflict('上传内容与项目 Git 中的提交和目录不一致');
        let frameworkCheck: DesignFrameworkCheck | undefined;
        if (framework && frameworkRevision) {
          frameworkCheck = frameworkChecks.get(frameworkRevision.version) ?? await checkDesignFramework(framework,
            frameworkRevision, sourceCommit, loaded.prototype, screens, this.deps.frameworkProbe);
          frameworkChecks.set(frameworkRevision.version, frameworkCheck);
        }
        const assets: ProjectRevisionAsset[] = [{ id: prototypeId, mime: 'text/html; charset=utf-8', base64: loaded.prototype.toString('base64') }];
        const renders: NonNullable<DesignVersion['renders']> = {};
        for (const capture of loaded.renders) {
          const id = randomUUID();
          const themes = renders[capture.screenId] ??= {};
          themes[capture.theme] = { id, sha256: capture.sha256 };
          assets.push({ id, mime: 'image/png', base64: capture.content.toString('base64') });
        }
        const version: DesignVersion = { version: (previous?.version ?? 0) + 1, title, sourceCommit, sha256, prototypeId,
          prototypeSha256: designDigest(loaded.prototype),
          sourcePath, sourceVerification: source ? 'git' : 'declared',
          createdAt: now, publisher: identity(actor), rationale, screens, acceptance, spec, checks, framework, frameworkVersion, group, tags, decisionIds, resolves, note,
          ...(frameworkCheck ? { frameworkCheck } : {}),
          ...(loaded.renders.length ? { renders } : {}) };
        return { result: { type: 'package', designId: id, version: version.version },
          changes: { design: { id, version, reviewers,
            reviewRequested: Boolean(reviewers?.length) || params.review === 'true' || Boolean(existing?.frozen),
            ...(reviewers?.length ? { notifyReviewersAt: now } : {}) }, assets } };
      });
  }

  async command(projectId: string, actor: DesignActor, value: unknown) {
    const input = designRecord(value, '设计命令');
    const type = planningText(input.type, '命令类型', 60);
    const requestId = designId(input.requestId, '请求编号');
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
      if (type === 'share.prepare') return this.prepareShare(input, context, entry);
      const result = { type, designId: id };
      if (type === 'design.review') {
        designRecord(input, '稿件评审请求', ['type', 'requestId', 'designId', 'reviewerIds']);
        authored(actor, entry.versions.at(-1)!.publisher);
        const reviewers = await this.reviewers(projectId, input.reviewerIds);
        const currentVersion = entry.versions.at(-1)!.version;
        return { result: { ...result, version: currentVersion }, changes: { design: { id, reviewers, reviewRequested: reviewers.length > 0,
          ...(reviewers.length ? { notifyReviewersAt: context.now } : {}) } } };
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
    const existing = entry.sharePreparations?.find(row =>
      row.version === version.version && row.audience === audience && row.expiresInHours === expiresInHours);
    const prepared: DesignSharePreparation = existing ?? {
      id: `SHARE-${randomUUID()}`, version: version.version, sourceCommit: version.sourceCommit, packageSha256: version.sha256,
      audience, expiresInHours, state: 'awaiting_human_confirmation', preparedAt: now, preparedBy: identity(actor),
    };
    return { result: { type: 'share.prepare', designId: entry.id, id: prepared.id, version: prepared.version,
      sourceCommit: prepared.sourceCommit, state: prepared.state },
      changes: existing ? {} : { design: { id: entry.id, sharePreparation: prepared } } };
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
      const version = versionOf(entry, input.version);
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
      const version = versionOf(entry, run.version);
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
    const sourceCommit = designCommit(input.sourceCommit);
    const sourcePath = input.sourcePath === undefined ? undefined : designSourcePath(input.sourcePath);
    if (previous?.versions.some(version => version.sourceCommit === sourceCommit)) conflict('该框架已经导入过此提交');
    const note = optionalText(input.note, '框架变更说明', 1000);
    let material: DesignMaterial;
    let from: { designId: string; version: number } | undefined;
    if (type === 'framework.import') {
      designRecord(input, '框架导入', ['type', 'requestId', 'frameworkId', 'expectedVersion', 'sourceCommit', 'sourcePath', 'title', 'material', 'note']);
      material = parseMaterial(input.material);
    } else {
      designRecord(input, '提取框架', ['type', 'requestId', 'frameworkId', 'expectedVersion', 'sourceCommit', 'sourcePath', 'title', 'designId', 'version', 'keys', 'note']);
      const designIdValue = designId(input.designId, '稿件编号');
      const design = state.designs.get(designIdValue) ?? missing('该稿件不存在');
      const version = versionOf(design, input.version);
      if (design.frozen !== version.version) conflict('只能提取定稿版本');
      const keys = input.keys;
      if (!Array.isArray(keys) || !keys.length || keys.some(key => !materialKeys.some(item => item === key))) return invalidDesign('请选择要提取的令牌、组件、规则或骨架');
      material = { ...current?.material };
      let changed = false;
      for (const key of materialKeys) {
        const proposed = version.spec[key], existing = material[key];
        const comparable = (value: unknown) => typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : stableJson(value);
        if (!keys.includes(key) || proposed === undefined || comparable(proposed) === comparable(existing)) continue;
        Object.assign(material, { [key]: version.spec[key] });
        changed = true;
      }
      if (!changed) conflict('勾选的条目已存在，或稿件没有这些材料');
      from = { designId: designIdValue, version: version.version };
    }
    if (!materialKeys.some(key => material[key] !== undefined)) invalidDesign('框架至少需要一种设计材料');
    const version = (current?.version ?? 0) + 1;
    const title = input.title === undefined && current ? current.title : planningText(input.title, '框架名称', 150);
    const archive = sourcePath && await this.deps.sourcePackage?.(projectId, sourceCommit, sourcePath);
    if (archive) {
      let reference: DesignMaterial;
      try { reference = await readDesignFrameworkSource(archive); }
      catch { return conflict('项目 Git 中的目录缺少可读取的框架材料'); }
      const normalize = (spec: DesignMaterial) => stableJson(Object.fromEntries(Object.entries(spec).map(([key, value]) =>
        [key, typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : value])));
      if (normalize(reference) !== normalize(material)) conflict('框架材料与项目 Git 中的提交和目录不一致');
    }
    const revision = { version, title, sourceCommit, sourcePath, sourceVerification: archive ? 'git' as const : 'declared' as const,
      at: now, by: actor.id, from, material, note };
    return { result: { type, frameworkId: id, version },
      changes: { framework: { id, projectId, versions: [...(previous?.versions ?? []), revision] } } };
  }
}
