import type { CdsConfig } from '../types.js';
import type { PlanningPreviewTarget, PlanningPullRequest, PlanningPullRequestPreview } from '../shared/engineering-planning.js';
import { normalizePlanningPreviewPath, planningGitHubPullRequest, planningPreviewTargetUrl } from '../shared/engineering-planning-links.js';
import { computePublishedBranchWebEntries, publicPreviewHost } from './branch-web-entrypoints.js';
import { resolveEffectiveProfile } from './container.js';
import type { PlanningState } from './engineering-planning-domain.js';
import type { EngineeringPlanningService } from './engineering-planning.js';
import { isSafeGitRef } from './github-webhook-dispatcher.js';
import { ROUTABLE_SERVICE_STATUSES, resolveMainDomainRoutes } from './route-conventions.js';
import { servingRuntime } from './service-runtime.js';
import type { StateService } from './state.js';
import { mainDomainEntryPath } from './web-entry.js';

type Observation = { action: string; deliveryId?: string };
type CheckState = NonNullable<PlanningPullRequest['checks']>;
type StoredCheck = Observation & { id: number; state: CheckState };
export type PlanningPullRequestSnapshot = Omit<PlanningPullRequest, 'projectId' | 'decisionIds' | 'debtIds' | 'preview' | 'checks'> & {
  headSha: string; headBranch: string; headRepository?: string; closedAt?: string;
  mergeCommitSha?: string; baseRef?: string; mergeDeliveryId?: string;
  decisionRefs: string[]; debtRefs: string[]; observation: Observation; checks: Record<string, StoredCheck>;
};
export type PlanningGitHubObservation =
  | { type: 'pull_request'; pullRequest: PlanningPullRequestSnapshot }
  | { type: 'check_run'; repository: string; numbers: number[]; headSha: string; checkKey: string; check: StoredCheck };

export type PlanningPreviewResolver = (projectId: string, pullRequest: PlanningPullRequestSnapshot, now: Date) => PlanningPullRequestPreview | undefined;
export type PlanningGithubObserver = (event: string, payload: unknown, deliveryId?: string) => Promise<void>;

const prActions = new Set(['opened', 'edited', 'synchronize', 'ready_for_review', 'converted_to_draft', 'reopened', 'closed']);
const failedChecks = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
const passedChecks = new Set(['success', 'neutral', 'skipped']);
const runningChecks = new Set(['queued', 'in_progress', 'requested', 'waiting', 'pending']);
const recordPattern = /(?:^|[^a-z0-9])((?:ADR|DEBT|ATL)-(?:[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}|[a-z0-9]{1,36}))(?=$|[^a-z0-9])/gi;
const PREVIEW_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const positiveInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const repositoryKey = (value: string) => value.toLowerCase();
const sha = (value: unknown) => typeof value === 'string' && /^[\da-f]{40}$/i.test(value) ? value.toLowerCase() : undefined;
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
const recordRefs = (text: string) => [...text.matchAll(recordPattern)].map(match => match[1].toUpperCase());
export const planningPullRequestKey = (repository: string, number: number) => `${repositoryKey(repository)}#${number}`;

function prMetadata(body: string, branchName: string) {
  const branchRefs = recordRefs(branchName);
  const decisionRefs = branchRefs.filter(ref => ref.startsWith('ADR-'));
  const debtRefs = branchRefs.filter(ref => ref.startsWith('DEBT-') || ref.startsWith('ATL-'));
  let target: PlanningPreviewTarget | undefined;
  for (const line of body.slice(0, 65536).split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[-*]\s+)?(ADR|Debt|Preview)\s*[:：]\s*(.+?)\s*$/i);
    if (!match) continue;
    const category = match[1].toLowerCase();
    if (category === 'adr') decisionRefs.push(...recordRefs(match[2]).filter(ref => ref.startsWith('ADR-')));
    if (category === 'debt') debtRefs.push(...recordRefs(match[2]).filter(ref => ref.startsWith('DEBT-') || ref.startsWith('ATL-')));
    if (category === 'preview' && !target) {
      const path = normalizePlanningPreviewPath(match[2]);
      if (path) target = { label: path, path };
    }
  }
  return { decisionRefs: [...new Set(decisionRefs)].slice(0, 32), debtRefs: [...new Set(debtRefs)].slice(0, 32), ...(target ? { target } : {}) };
}

function parsePullRequest(payload: Record<string, unknown>, repository: string, observation: Observation): PlanningGitHubObservation | undefined {
  if (!prActions.has(observation.action)) return undefined;
  const pr = object(payload.pull_request);
  const link = planningGitHubPullRequest(pr.html_url);
  const head = object(pr.head);
  const headSha = sha(head.sha);
  const headBranch = string(head.ref);
  const headRepository = string(object(head.repo).full_name);
  const openedAt = date(pr.created_at);
  const updatedAt = date(pr.updated_at);
  const title = string(pr.title).trim().slice(0, 512);
  const author = string(object(pr.user).login).trim().slice(0, 120);
  if (!link || repositoryKey(link.repository) !== repositoryKey(repository) || link.number !== pr.number || !headSha || !isSafeGitRef(headBranch)
    || !openedAt || !updatedAt || !title || !author || (pr.state !== 'open' && pr.state !== 'closed')) return undefined;
  const state = pr.state === 'closed' ? (pr.merged === true ? 'merged' : 'closed') : (pr.draft === true ? 'draft' : 'open');
  const closedAt = state === 'closed' || state === 'merged' ? date(pr.closed_at) : undefined;
  const mergedAt = state === 'merged' ? date(pr.merged_at) : undefined;
  const mergeCommitSha = mergedAt && observation.action === 'closed' ? sha(pr.merge_commit_sha) : undefined;
  const baseRef = string(object(pr.base).ref);
  return { type: 'pull_request', pullRequest: { number: link.number, repository, url: link.url, title, author, openedAt, updatedAt, state,
    headSha, headBranch, ...(headRepository ? { headRepository } : {}), ...(closedAt ? { closedAt } : {}), ...(mergedAt ? { mergedAt } : {}),
    ...(mergeCommitSha && isSafeGitRef(baseRef) && observation.deliveryId ? { mergeCommitSha, baseRef, mergeDeliveryId: observation.deliveryId } : {}),
    ...prMetadata(string(pr.body), headBranch), observation, checks: {} } };
}

function parseCheckRun(payload: Record<string, unknown>, repository: string, observation: Observation): PlanningGitHubObservation | undefined {
  const run = object(payload.check_run);
  const suite = object(run.check_suite);
  const appId = object(run.app).id;
  const name = string(run.name).trim().slice(0, 256);
  const headSha = sha(run.head_sha);
  const pulls = Array.isArray(run.pull_requests) && run.pull_requests.length ? run.pull_requests : suite.pull_requests;
  const numbers = Array.isArray(pulls) ? [...new Set(pulls.map(pr => object(pr).number).filter(positiveInt))].slice(0, 64) : [];
  if (!headSha || !name || !positiveInt(appId) || !positiveInt(run.id) || !numbers.length) return undefined;
  const status = string(run.status);
  const conclusion = string(run.conclusion);
  const state = status === 'completed' ? (failedChecks.has(conclusion) ? 'fail' : passedChecks.has(conclusion) ? 'pass' : undefined)
    : runningChecks.has(status) ? 'running' : undefined;
  if (!state) return undefined;
  return { type: 'check_run', repository, numbers, headSha, checkKey: `${appId}:${name}`, check: { id: run.id, state, ...observation } };
}

export function createPlanningGithubObserver(state: StateService, planning: Pick<EngineeringPlanningService, 'recordGithubObservation'>): PlanningGithubObserver {
  return async (event, raw, deliveryId) => {
    const payload = object(raw);
    const repository = string(object(payload.repository).full_name);
    if (!repository) return;
    const observation = { action: string(payload.action), ...(deliveryId ? { deliveryId } : {}) };
    const parsed = event === 'pull_request' ? parsePullRequest(payload, repository, observation)
      : event === 'check_run' ? parseCheckRun(payload, repository, observation) : undefined;
    if (!parsed) return;
    const installation = object(payload.installation).id;
    for (const project of state.findProjectsByRepoFullName(repository)) {
      if (!project.mirror && (project.githubInstallationId === undefined || project.githubInstallationId === installation)) {
        await planning.recordGithubObservation(project.id, parsed);
      }
    }
  };
}

export function applyPullRequestObservation(current: ReadonlyMap<string, PlanningPullRequestSnapshot>, observation: PlanningGitHubObservation): PlanningPullRequestSnapshot[] {
  if (observation.type === 'pull_request') {
    const incoming = observation.pullRequest;
    const previous = current.get(planningPullRequestKey(incoming.repository, incoming.number));
    if (!previous) return [incoming];
    const row = previous.mergeCommitSha && incoming.state === 'merged'
      ? { ...incoming, mergeCommitSha: previous.mergeCommitSha, mergeDeliveryId: previous.mergeDeliveryId, baseRef: previous.baseRef }
      : incoming;
    const reopening = row.state === 'open' || row.state === 'draft';
    if (previous.updatedAt > row.updatedAt || (previous.state === 'merged' && row.state !== 'merged')
      || (previous.updatedAt === row.updatedAt && (row.observation.action === 'opened'
        || (previous.state === 'closed' && reopening && row.observation.action !== 'reopened')))) return [];
    const { observation: _priorDelivery, mergeDeliveryId: _priorMergeDelivery, checks: previousChecks, ...priorFields } = previous;
    const { observation: _delivery, mergeDeliveryId: _mergeDelivery, checks: _checks, ...fields } = row;
    if (JSON.stringify(priorFields) === JSON.stringify(fields)) return [];
    return [{ ...row, checks: previous.headSha === row.headSha ? previousChecks : {} }];
  }
  return observation.numbers.flatMap(number => {
    const row = current.get(planningPullRequestKey(observation.repository, number));
    if (!row || row.headSha !== observation.headSha) return [];
    const prior = row.checks[observation.checkKey];
    const check = observation.check;
    if (prior && (prior.id > check.id || (prior.id === check.id && (prior.state === check.state || check.state === 'running')))) return [];
    return [{ ...row, checks: { ...row.checks, [observation.checkKey]: check } }];
  });
}

function refIndex(rows: Iterable<{ id: string; source: { ref: string } }>) {
  const index = new Map<string, string | null>();
  for (const row of rows) {
    const full = row.id.toUpperCase();
    const short = full.split('-').slice(0, 2).join('-');
    const imported = recordRefs(row.source.ref).find(ref => ref === row.source.ref.toUpperCase());
    for (const ref of new Set([full, short, ...(imported ? [imported] : [])])) {
      if (!index.has(ref)) index.set(ref, row.id);
      else if (index.get(ref) !== row.id) index.set(ref, null);
    }
  }
  return index;
}

function checkStatus(row: PlanningPullRequestSnapshot): CheckState | undefined {
  const checks = Object.values(row.checks);
  if (checks.some(check => check.state === 'fail')) return 'fail';
  if (checks.some(check => check.state === 'running')) return 'running';
  if (checks.length) return 'pass';
  return undefined;
}

export function projectPlanningPullRequests(projectId: string, repository: string, state: Pick<PlanningState, 'pullRequests' | 'decisions' | 'debts'>,
  now: Date, previewFor?: PlanningPreviewResolver): PlanningPullRequest[] {
  const decisionRefs = refIndex(state.decisions.values());
  const debtRefs = refIndex(state.debts.values());
  const keyFor = (url: string | undefined) => {
    const pr = planningGitHubPullRequest(url);
    return pr ? planningPullRequestKey(pr.repository, pr.number) : undefined;
  };
  const decisionsByPr = new Map<string, Map<string, PlanningPreviewTarget | undefined>>();
  for (const decision of state.decisions.values()) {
    const source = keyFor(decision.source.url);
    const reference = keyFor(decision.pullRequest?.url);
    for (const key of new Set([source, reference])) {
      if (!key) continue;
      const matches = decisionsByPr.get(key) ?? new Map();
      matches.set(decision.id, key === reference ? decision.pullRequest?.target : undefined);
      decisionsByPr.set(key, matches);
    }
  }
  const debtsByPr = new Map<string, string[]>();
  for (const debt of state.debts.values()) {
    const key = keyFor(debt.source.url);
    if (key) debtsByPr.set(key, [...(debtsByPr.get(key) ?? []), debt.id]);
  }
  const result: PlanningPullRequest[] = [];
  for (const [key, row] of state.pullRequests) {
    if (repositoryKey(row.repository) !== repositoryKey(repository)) continue;
    const debtIds = new Set([...(debtsByPr.get(key) ?? []), ...row.debtRefs.map(id => debtRefs.get(id)).filter((id): id is string => !!id)]);
    const decisionIds = new Set(row.decisionRefs.map(id => decisionRefs.get(id)).filter((id): id is string => !!id));
    const suggestedTargets = new Map<string, PlanningPreviewTarget>();
    for (const [id, target] of decisionsByPr.get(key) ?? []) {
      decisionIds.add(id);
      if (target) suggestedTargets.set(JSON.stringify(target), target);
    }
    for (const id of debtIds) {
      const decisionId = state.debts.get(id)?.decisionId;
      if (decisionId) decisionIds.add(decisionId);
    }
    if (!decisionIds.size && !debtIds.size) continue;
    const suggested = suggestedTargets.size === 1 ? suggestedTargets.values().next().value : undefined;
    const target = row.target ? (suggested?.path === row.target.path ? suggested : row.target) : suggested;
    const checks = checkStatus(row);
    const preview = previewFor?.(projectId, row, now);
    result.push({ projectId, repository: row.repository, number: row.number, url: row.url, title: row.title, author: row.author,
      state: row.state, openedAt: row.openedAt, updatedAt: row.updatedAt, decisionIds: [...decisionIds], debtIds: [...debtIds],
      ...(row.mergedAt ? { mergedAt: row.mergedAt } : {}), ...(checks ? { checks } : {}), ...(target ? { target } : {}), ...(preview ? { preview } : {}) });
  }
  return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number);
}

export function createPlanningPreviewResolver(state: StateService, config: Pick<CdsConfig, 'previewDomain' | 'rootDomains'>): PlanningPreviewResolver {
  const host = publicPreviewHost(config);
  return (projectId, pullRequest, now) => {
    const { headSha, headBranch, headRepository, repository, closedAt, mergedAt } = pullRequest;
    const project = state.getProject(projectId);
    if (!project || project.mirror || !project.githubRepoFullName || repositoryKey(project.githubRepoFullName) !== repositoryKey(repository)
      || !headRepository || repositoryKey(headRepository) !== repositoryKey(repository) || headBranch === state.getDefaultBranchFor(projectId)) return undefined;
    const branch = state.findBranchByProjectAndName(projectId, headBranch);
    const ended = mergedAt ?? closedAt;
    const expiresAt = ended ? Date.parse(ended) + PREVIEW_LIFETIME_MS : undefined;
    if (expiresAt !== undefined && now.getTime() >= expiresAt) {
      const tombstone = state.listRemovedBranches(projectId).find(row => row.branch === headBranch && row.prNumber === pullRequest.number);
      const branchId = branch?.id ?? tombstone?.branchId;
      const built = branchId && state.getDeploymentVersions({ projectId, branchId, commitSha: headSha })
        .some(version => Date.parse(version.createdAt) <= expiresAt);
      return built ? { status: 'expired', commit: headSha } : undefined;
    }
    if (!branch || branch.deleting || branch.archive || branch.mirror || !host) return undefined;

    const primary = computePublishedBranchWebEntries(state, branch, host)[0];
    const effectiveProfiles = state.getEffectiveProfilesForBranch(branch).map(profile => resolveEffectiveProfile(profile, branch));
    const routable = effectiveProfiles.filter(profile => {
      const service = branch.services[profile.id];
      return servingRuntime(service) || (service?.hostPort && ROUTABLE_SERVICE_STATUSES.has(service.status));
    });
    const profileId = primary?.serviceId ?? resolveMainDomainRoutes(routable).shellId;
    const service = profileId ? branch.services[profileId] : undefined;
    const runtime = servingRuntime(service);
    const current = branch.currentVersionId ? state.getDeploymentVersion(branch.currentVersionId) : undefined;
    const version = current && current.projectId === projectId && current.branchId === branch.id && sha(current.commitSha) === headSha ? current : undefined;
    const currentProfile = version?.profiles.find(profile => profile.profileId === profileId);
    const runningSha = sha(runtime?.sourceCommitSha);
    const artifactMatches = currentProfile?.reusable && runtime?.deployedImage && currentProfile.artifactImage === runtime.deployedImage;
    const ready = runtime && (runningSha ? runningSha === headSha : artifactMatches) && (!branch.currentVersionId || currentProfile);
    const replicas = profileId ? branch.replicaSets?.[profileId] : undefined;
    if (ready && primary?.url && !(replicas?.enabled && replicas.members.length)) {
      const entry = URL.canParse(primary.url) ? new URL(primary.url) : undefined;
      const profile = effectiveProfiles.find(profile => profile.id === profileId);
      const rootPath = primary.subdomain || !profile ? '/' : mainDomainEntryPath(profile, '/');
      const builtAt = version?.createdAt ?? branch.lastReadyAt;
      const root = entry && (rootPath === '/' ? entry.origin : planningPreviewTargetUrl(entry.href, rootPath));
      if (entry && root) return { status: 'ready', url: root, path: `${entry.pathname}${entry.search}${entry.hash}`, commit: headSha,
        ...(builtAt ? { builtAt } : {}) };
    }
    const run = branch.lastDeploymentRunId ? state.getDeploymentRun(branch.lastDeploymentRunId) : undefined;
    if (run && run.projectId === projectId && run.branchId === branch.id && sha(run.commitSha) === headSha) {
      if (run.status === 'failed') return { status: 'failed', commit: headSha };
      if (run.status !== 'running' && run.status !== 'cancelled') return { status: 'building', commit: headSha };
    }
    if (sha(branch.ciTargetSha) === headSha) {
      if (branch.ciImageStatus === 'failed') return { status: 'failed', commit: headSha };
      if (branch.ciImageStatus === 'waiting') return { status: 'building', commit: headSha };
    }
    return undefined;
  };
}
