import type { VersionRegistration } from '@/services/real/productVersionRegistry';
import { VersionCopyActions } from './VersionCopyActions';
import { formatVersionBasicBool, formatVersionBasicDate, formatVersionTrainingMinutes } from './versionBasicInfoCatalog';
import { VERSION_SCALE_LABEL } from './versionWorkflowExport';

export function LegacyVersionDetail({ record }: { record: VersionRegistration }) {
  const fields = [
    ['系统', record.systemName], ['应用', record.applicationName],
    ['版本号', record.code], ['内部版本号', record.tCode],
    ['产品方案名称', record.planName], ['产品负责人', record.ownerName || record.createdByName],
    ['项目类别', record.projectType === 'custom' ? '定制' : '非定制'],
    ['版本类别', VERSION_SCALE_LABEL[record.versionType]],
    ['项目组成员', record.projectMemberNames.join('、')],
    ['需求来源', record.demandSource], ['所属部门', record.departmentName],
    ['方案地址', record.planUrl],
    ['计划立项时间', formatVersionBasicDate(record.plannedProjectAt)],
    ['上线日期', formatVersionBasicDate(record.plannedReleaseAt)],
    ...(record.kind === 'formal' ? [
      ['预计培训时长', formatVersionTrainingMinutes(record.plannedTrainingMinutes)],
      ['是否全域开放', formatVersionBasicBool(record.isGlobalOpen)],
    ] : [
      ['是否需要 UI 设计', formatVersionBasicBool(record.needUiDesign)],
      ['是否 AI POC', formatVersionBasicBool(record.isAiPoc)],
    ]),
    ['项目需求描述', record.requirementDescription], ['合同签订方', record.contractParty],
    ['开发状态', record.developmentStatus], ['备注', record.remark],
  ];
  return <section className="space-y-4">
    <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {fields.map(([label, value]) => <div key={label} className="min-w-0">
        <dt className="text-xs text-token-muted">{label}</dt>
        <dd className="mt-1 whitespace-pre-wrap break-words text-sm text-token-primary">{value || '-'}</dd>
      </div>)}
    </dl>
    <VersionCopyActions kind={record.kind === 'formal' ? 'release' : 'initiation'} id={record.id} code={record.code} legacy />
  </section>;
}
