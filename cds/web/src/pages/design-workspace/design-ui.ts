import { apiUrl } from '@/lib/api';
import type { DesignEntry, DesignVersion } from '../../../../src/shared/design-workspace';

export const designPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/design`;
export const designArtifact = (projectId: string, artifactId: string) => apiUrl(`${designPath(projectId)}/artifacts/${encodeURIComponent(artifactId)}`);
export const latestDesign = (entry: DesignEntry): DesignVersion => entry.versions[entry.versions.length - 1];
export const designDate = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric' }).format(new Date(value));
export const materialNames = { tokens: '令牌', components: '组件', skeleton: '页面骨架', rules: '规则' } as const;
export const statusNames = { review: '待评审', active: '实现中', draft: '设计中', frozen: '已定稿', signed: '已验收' } as const;
export const verdictNames = { passed: '通过', conditional: '有条件通过', failed: '不通过', needs_evidence: '待补证据' } as const;
export const cellNames = { passed: '通过', failed: '不通过', missing: '证据缺失', unverified: '未验证' } as const;
export const slotNames = { 'desktop-light': '桌面浅色', 'desktop-dark': '桌面深色', 'phone-light': '手机浅色', 'phone-dark': '手机深色' } as const;
export const ruleModes = { measure: '测量', screenshot: '截图', human: '人工' } as const;

export function designStatus(entry: DesignEntry): keyof typeof statusNames {
  if (entry.reviewRequested) return 'review';
  if (entry.runs.at(-1)?.signed) return 'signed';
  if (entry.pullRequest) return 'active';
  return entry.frozen ? 'frozen' : 'draft';
}

export function openReviews(entry: DesignEntry) {
  return entry.comments.flatMap(comment => {
    if (comment.closed) return [];
    const version = [...entry.versions].reverse().find(version => Object.hasOwn(version.resolves, comment.id));
    return version && !comment.reviews.some(review => review.version === version.version) ? [{ comment, version }] : [];
  });
}

export type DesignCommand = (type: string, fields: Record<string, unknown>) => Promise<boolean>;
