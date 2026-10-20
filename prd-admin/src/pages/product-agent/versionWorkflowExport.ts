import type { ProductInitiation, ProductRelease, Requirement } from './types';
import { formatVersionBasicBool, formatVersionBasicDate, resolveVersionProductLabel } from './versionBasicInfoCatalog';

export const VERSION_WORKFLOW_STATUS_LABEL: Record<string, string> = {
  draft: '草稿', review_pending: 'Agent 评审中', review_failed: '评审未通过',
  decision_pending: '待确认评审方式', owner_pending: '待负责人同意', approved: '已取得立项号',
  announcement_pending: '待填写上线公告', released: '已上线',
};
const SCALE = { major: '大版本', medium: '中版本', minor: '小版本' };
// 用户填写的文本作为单元格文字导出，不交给表格软件执行公式。
const safeRow = (cells: string[]) => cells.map((cell) => /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell);

export function initiationExportConfig(productId: string, productName: string, names: ReadonlyMap<string, string>, productNames?: ReadonlyMap<string, string>) {
  return {
    filename: `内部版本-T-${productId}.csv`,
    headers: ['产品', '内部版本号', '项目类别', '客户来源', '版本类别', '产品立项方案名称', '需求来源', '项目需求描述', '所属部门', '产品负责人', '项目组成员', '第一稿会议时间', '第二稿会议时间', '第三稿会议时间', '立项时间', '计划立项时间', '是否需要 UI 设计', '是否属于 AI POC 项目', '方案地址', '开发状态', '备注', '关联需求ID', '状态'],
    mapRow: (item: ProductInitiation) => safeRow([
      resolveVersionProductLabel(item, productNames?.get(item.productId) ?? productName), item.tCode ?? '',
      item.projectType === 'custom' ? '定制项目' : '非定制项目', item.customerSource ?? '',
      SCALE[item.versionType], item.planName, item.demandSource ?? '', item.requirementDescription ?? '',
      item.departmentName ?? '', item.ownerName || names.get(item.createdBy) || item.createdBy,
      item.projectMemberNames?.join('、') ?? '',
      formatVersionBasicDate(item.firstDraftMeetingAt), formatVersionBasicDate(item.secondDraftMeetingAt),
      formatVersionBasicDate(item.thirdDraftMeetingAt), formatVersionBasicDate(item.projectAt),
      formatVersionBasicDate(item.plannedProjectAt), formatVersionBasicBool(item.needUiDesign),
      formatVersionBasicBool(item.isAiPoc), item.planUrl ?? '', item.developmentStatus ?? '', item.remark ?? '',
      item.requirementIds.join('、'), VERSION_WORKFLOW_STATUS_LABEL[item.status] ?? item.status,
    ]),
  };
}

export function releaseExportConfig(productId: string, productName: string, names: ReadonlyMap<string, string>, requirements: Requirement[], productNames?: ReadonlyMap<string, string>, requirementTitles?: ReadonlyMap<string, string>) {
  const requirementNames = new Map(requirementTitles);
  requirements.forEach((item) => requirementNames.set(item.id, item.title));
  return {
    filename: `正式版本-V-${productId}.csv`,
    headers: ['产品', '正式版本号', '内部版本号', '项目类别', '版本类别', '产品立项方案名称', '需求来源', '项目需求描述', '所属部门', '产品负责人', '项目组成员', '方案地址', '上线日期', '预计培训时长（分钟）', '是否全域开放', '当前开放品牌', '合同签订方', '备注', '关联需求', '关联需求ID', '上线公告地址', '状态'],
    mapRow: (item: ProductRelease) => safeRow([
      resolveVersionProductLabel(item, productNames?.get(item.productId) ?? productName), item.vCode, item.tCode ?? '',
      item.projectType === 'custom' ? '定制项目' : '非定制项目', SCALE[item.versionType], item.planName,
      item.demandSource ?? '', item.requirementDescription ?? '', item.departmentName ?? '',
      item.ownerName || names.get(item.ownerId ?? '') || item.legacyData?.['产品负责人'] || item.ownerId || '',
      item.projectMemberNames?.length ? item.projectMemberNames.join('、') : item.teamMemberIds.map((id) => names.get(id) ?? id).join('、'),
      item.planUrl ?? '', formatVersionBasicDate(item.plannedReleaseAt), item.plannedTrainingMinutes == null ? '' : String(item.plannedTrainingMinutes),
      formatVersionBasicBool(item.isGlobalOpen), item.openBrandScope ?? '', item.contractParty ?? '', item.remark ?? '',
      item.requirementIds.map((id) => requirementNames.get(id) ?? id).join('、'), item.requirementIds.join('、'),
      item.announcementUrl ?? '', VERSION_WORKFLOW_STATUS_LABEL[item.status] ?? item.status,
    ]),
  };
}
