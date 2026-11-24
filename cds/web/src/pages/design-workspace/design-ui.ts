import type { DesignModuleRef, DesignRequirement, DesignViewerState } from '../../../../src/shared/design-workspace';
import { apiUrl } from '@/lib/api';
import { currentDesignRun, type DesignEntry, type DesignVersion } from '../../../../src/shared/design-workspace';

export const designPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/design`;
export function designDetailPath(projectId: string, designId: string, version?: number, fromVersion?: number) {
  const query = new URLSearchParams({ designId });
  if (version !== undefined) query.set('version', String(version));
  if (fromVersion !== undefined && fromVersion !== version) query.set('fromVersion', String(fromVersion));
  return designPath(projectId) + '?' + query;
}
export const designArtifact = (projectId: string, artifactId: string) => apiUrl(`${designPath(projectId)}/artifacts/${encodeURIComponent(artifactId)}`);
export const latestDesign = (entry: DesignEntry): DesignVersion => entry.versions[entry.versions.length - 1];
export const isDesignPhoneViewport = () => typeof window !== 'undefined'
  && window.matchMedia?.('(max-width: 40rem)').matches === true;

export function defaultDesignScreen(version: DesignVersion, requested?: string) {
  const selected = version.screens.find(screen => screen.id === requested);
  if (selected) return selected;
  const demo = version.demo?.flatMap(step => {
    const screen = version.screens.find(candidate => candidate.id === step.screen);
    return screen ? [screen] : [];
  }) ?? [];
  if (isDesignPhoneViewport()) {
    const mobile = demo.find(screen => screen.viewport === 'phone') ?? version.screens.find(screen => screen.viewport === 'phone');
    if (mobile) return mobile;
  }
  return demo[0] ?? version.screens[0];
}
export const designSourceNames: Record<NonNullable<DesignVersion['sourceVerification']>, string> = {
  git: 'Git 已核验', 'private-upload': 'CDS 私有归档', declared: '发布者声明来源',
};
export const designDate = (value?: string) => value && Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric' }).format(new Date(value)) : '时间未记录';
export function designPublisherLabel(value?: string): string {
  if (!value) return '记录人未登记';
  if (!value.startsWith('授权密钥')) return value;
  return value.match(/^授权密钥\s*\(申请\s+[^·]+·\s*(.+)\)$/)?.[1]?.trim() || '设计智能体';
}
export const materialNames = { tokens: '令牌', components: '组件', skeleton: '页面骨架', rules: '规则' } as const;
export const statusNames = { review: '待评审', failed: '未通过', draft: '设计中', passed: '已通过' } as const;
export const verdictNames = { passed: '通过', conditional: '有条件通过', failed: '不通过', needs_evidence: '待补证据' } as const;
export const cellNames = { passed: '通过', failed: '不通过', missing: '证据缺失', unverified: '未验证' } as const;
export const slotNames = { 'desktop-light': '桌面浅色', 'desktop-dark': '桌面深色', 'phone-light': '手机浅色', 'phone-dark': '手机深色' } as const;
export const ruleModes = { measure: '测量', screenshot: '截图', human: '人工' } as const;

export function designCheckRows(version: DesignVersion) {
  return (Array.isArray(version.checks?.items) ? version.checks.items : []).flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const name = item.name ?? item.rule ?? item.label ?? item.title;
    if (typeof name !== 'string') return [];
    const passed = item.pass ?? item.passed ?? item.ok;
    const status = passed === false || item.status === 'failed' ? '不通过' : passed === true || item.status === 'passed' ? '通过' : '未验证';
    return [{ id: typeof item.id === 'string' ? item.id : String(index + 1), name, status }];
  });
}

export function designFailureGroups(version: DesignVersion) {
  return [
    { label: '框架规则不通过', rules: (version.frameworkCheck?.items ?? []).filter(row => row.status === 'failed')
      .map(row => ({ id: row.ruleId, name: row.name })) },
    { label: version.frameworkCheck ? '作者自检不通过' : '自检不通过',
      rules: designCheckRows(version).filter(row => row.status === '不通过') },
  ].filter(group => group.rules.length);
}

export function designStatus(entry: DesignEntry): keyof typeof statusNames {
  if (entry.reviewRequested) return 'review';
  const run = currentDesignRun(entry);
  if (run?.signed && run.version === latestDesign(entry).version
    && (entry.currentSignoffRunId === undefined || entry.currentSignoffRunId === run.id)) return 'passed';
  if (failedBaseline(entry) !== undefined) return 'failed';
  return 'draft';
}

export function failedBaseline(entry: DesignEntry): number | undefined {
  const run = currentDesignRun(entry);
  return run?.verdict === 'failed' ? run.version : undefined;
}

export function designFeedbackAwaitsViewer(entry: DesignEntry, feedback: NonNullable<DesignEntry['feedback']>[number], actorId?: string): boolean {
  if (feedback.status === 'responded') return feedback.author.id === actorId;
  return feedback.status === 'open' && feedback.author.id !== actorId
    && (entry.versions.some(version => version.publisher.id === actorId) || entry.librarySummary?.publisherIds.includes(actorId ?? '') === true);
}

export function openReviews(entry: DesignEntry) {
  return entry.comments.flatMap(comment => {
    if (comment.closed) return [];
    const indexed = entry.librarySummary?.reviewVersions[comment.id];
    const version = [...entry.versions].reverse().find(version => Object.hasOwn(version.resolves, comment.id))
      ?? (indexed === undefined ? undefined : { ...latestDesign(entry), version: indexed });
    return version && !comment.reviews.some(review => review.version === version.version) ? [{ comment, version }] : [];
  });
}

export type DesignCommand = (type: string, fields: Record<string, unknown>) => Promise<boolean>;

export const scopeKey = (ref: DesignModuleRef) => ref.systemId + '/' + ref.moduleId;
export function scopePath(project: string, ref?: DesignModuleRef, group?: string) {
  const params = new URLSearchParams({ project });
  if (ref) {
    params.set('system', ref.systemId);
    params.set('module', ref.moduleId);
  } else if (group) params.set('group', group);
  return '/design?' + params;
}

export const emptyDesignViewer: DesignViewerState = { designs: {}, briefs: {} };

export function legacyRequirementGroup(requirement: DesignRequirement, entries: DesignEntry[]): string {
  const linked = entries.find(row => row.designKey === requirement.designKey);
  if (linked) return latestDesign(linked).group ?? '未分组';
  const moduleKey = requirement.designKey.split('/')[0];
  const groups = new Set(entries.filter(row => !row.scope && row.designKey?.split('/')[0] === moduleKey)
    .map(row => latestDesign(row).group ?? '未分组'));
  return groups.size === 1 ? [...groups][0] : '未分组';
}

export function newDesignLabel(entry: DesignEntry, viewer: DesignViewerState): string | undefined {
  const latest = latestDesign(entry);
  const seen = viewer.designs?.[entry.id];
  const firstVisit = viewer.firstVisitAt ?? viewer.lastVisitAt;
  if (latest.version <= (seen?.version ?? 0) || (!seen && firstVisit && latest.createdAt <= firstVisit)) return;
  return latest.version === 1 ? '新稿' : '新 V' + latest.version;
}

export function isNewDesignRequirement(requirement: DesignRequirement, viewer: DesignViewerState): boolean {
  const seen = viewer.briefs?.[requirement.designKey] ?? viewer.firstVisitAt ?? viewer.lastVisitAt ?? '';
  return requirement.sharedAt > seen;
}
