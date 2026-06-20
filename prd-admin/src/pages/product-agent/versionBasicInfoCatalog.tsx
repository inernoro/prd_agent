/** 版本详情「基础信息」字段 — 与历史导入 Excel（立项语雀 / 上线语雀）列对齐 */
import type { ReactNode } from 'react';
import type { ProductInitiation, ProductRelease } from './types';

export type VersionBasicInfoRow = { label: string; value: ReactNode };

const DASH = '—';

const SCALE_LABEL: Record<string, string> = { major: '大版本', medium: '中版本', minor: '小版本' };

export function formatVersionBasicDate(value?: string | null) {
  if (!value) return DASH;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return DASH;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function formatVersionBasicBool(value?: boolean | null) {
  if (value == null) return DASH;
  return value ? '是' : '否';
}

function projectTypeLabel(projectType: string, customerSource?: string | null) {
  if (projectType === 'custom') return customerSource?.trim() ? `定制项目 · ${customerSource.trim()}` : '定制项目';
  return '非定制项目';
}

function scaleLabel(versionType: string) {
  return SCALE_LABEL[versionType] ?? (versionType?.trim() || DASH);
}

function externalLink(url?: string | null, text = '打开链接') {
  const href = url?.trim();
  if (!href) return DASH;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-cyan-300 hover:underline break-all">
      {text}
    </a>
  );
}

function multiline(value?: string | null) {
  const text = value?.trim();
  if (!text) return DASH;
  return <span className="whitespace-pre-wrap">{text}</span>;
}

/** 版本流程表格/详情中的「产品」展示（合并 legacy 系统/应用列）。 */
export function resolveVersionProductLabel(
  item: Pick<ProductInitiation | ProductRelease, 'systemName' | 'appName' | 'legacyData'>,
  fallbackProductName?: string | null,
): string {
  const fromLegacy = item.legacyData?.['产品']?.trim();
  if (fromLegacy) return fromLegacy;
  const app = item.appName?.trim();
  const system = item.systemName?.trim();
  if (app) return app;
  if (system) return system;
  const fallback = fallbackProductName?.trim();
  if (fallback) return fallback;
  return DASH;
}

/** 上线语雀.xlsx 列顺序 */
export function buildReleaseBasicInfoRows(
  release: ProductRelease,
  resolveUserName: (userId?: string | null) => string,
  productName?: string | null,
): VersionBasicInfoRow[] {
  const legacy = release.legacyData ?? {};
  const owner = legacy['产品负责人']?.trim() || resolveUserName(release.ownerId);
  const teamFromIds = release.teamMemberIds
    .map((id) => resolveUserName(id))
    .filter((name) => name && name !== DASH);
  const teamMembers = teamFromIds.length > 0
    ? teamFromIds.join('、')
    : legacy['项目组成员']?.trim() || DASH;

  return [
    { label: '产品', value: resolveVersionProductLabel(release, productName) },
    { label: '正式版本号', value: <span className="font-mono text-cyan-200">{release.vCode?.trim() || DASH}</span> },
    {
      label: '内部版本号',
      value: (
        <span className="font-mono text-white/75">
          {release.tCode?.trim() || (release.isTemporaryOptimization ? '临时优化需求' : DASH)}
        </span>
      ),
    },
    { label: '项目类别', value: projectTypeLabel(release.projectType) },
    { label: '版本类别', value: scaleLabel(release.versionType) },
    { label: '产品立项方案名称', value: release.planName?.trim() || DASH },
    { label: '所属部门', value: release.departmentName?.trim() || DASH },
    { label: '产品负责人', value: owner || DASH },
    { label: '项目组成员', value: teamMembers },
    { label: '方案地址', value: externalLink(release.planUrl) },
    { label: '上线时间', value: formatVersionBasicDate(release.releasedAt ?? release.plannedReleaseAt) },
    { label: '合同签订方', value: legacy['合同签订方']?.trim() || DASH },
    { label: '当前开放品牌', value: release.openBrandScope?.trim() || DASH },
    { label: '备注', value: multiline(legacy['备注']) },
  ];
}

/** 立项语雀.xlsx 列顺序 */
export function buildInitiationBasicInfoRows(
  initiation: ProductInitiation,
  resolveUserName: (userId?: string | null) => string,
  productName?: string | null,
): VersionBasicInfoRow[] {
  const legacy = initiation.legacyData ?? {};
  const owner = legacy['产品负责人']?.trim() || resolveUserName(initiation.primaryOwnerId ?? initiation.createdBy);

  return [
    { label: '产品', value: resolveVersionProductLabel(initiation, productName) },
    { label: '项目类别', value: projectTypeLabel(initiation.projectType, initiation.customerSource) },
    { label: '立项号', value: <span className="font-mono text-cyan-200">{initiation.tCode?.trim() || DASH}</span> },
    { label: '版本类别', value: scaleLabel(initiation.versionType) },
    { label: '产品立项方案名称', value: initiation.planName?.trim() || DASH },
    { label: '项目需求描述', value: multiline(initiation.requirementDescription) },
    { label: '所属部门', value: initiation.departmentName?.trim() || DASH },
    { label: '产品负责人', value: owner || DASH },
    { label: '第一稿会议时间', value: formatVersionBasicDate(initiation.firstDraftMeetingAt) },
    { label: '第二稿会议时间', value: formatVersionBasicDate(initiation.secondDraftMeetingAt) },
    { label: '第三稿会议时间', value: formatVersionBasicDate(initiation.thirdDraftMeetingAt) },
    { label: '立项时间（三稿通过）', value: formatVersionBasicDate(initiation.projectAt) },
    { label: '是否需要 UI 设计', value: formatVersionBasicBool(initiation.needUiDesign) },
    { label: '方案地址', value: externalLink(initiation.planUrl) },
    { label: '开发状态', value: initiation.developmentStatus?.trim() || DASH },
    { label: '备注', value: multiline(initiation.remark ?? legacy['备注']) },
  ];
}
