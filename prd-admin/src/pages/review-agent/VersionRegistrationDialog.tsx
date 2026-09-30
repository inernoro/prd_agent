import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ArrowLeft, ArrowRight, BookOpenCheck, CheckCircle2, FileSpreadsheet, FileUp, History, ListFilter, Plus, Search, Settings2, X } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { uploadAttachment } from '@/services/real/aiToolbox';
import {
  createVersionRegistryApplication,
  createVersionRegistrySystem,
  createCurrentVersionRegistrationSnapshot,
  createFormalVersionRegistration,
  createInternalVersionRegistration,
  findVersionRegistryMatches,
  getPublicVersionRegistrations,
  getVersionRegistrationInternalSources,
  getVersionRegistrationReviewSources,
  getVersionRegistrations,
  getVersionRegistrationSnapshots,
  getVersionRegistry,
  importVersionRegistrations,
  parseVersionRegistrationMessage,
  type VersionRegistration,
  type VersionRegistrationFields,
  type VersionRegistrationImportRow,
  type VersionRegistrationMessageParseResult,
  type VersionRegistrationReviewSource,
  type VersionRegistryApplication,
  type VersionRegistryMatch,
  type VersionRegistrySystem,
  type VersionRegistrationSnapshotSummary,
} from '@/services/real/versionRegistration';
import { parseVersionWorkflowImportFile, type VersionWorkflowImportRow } from '@/pages/product-agent/versionWorkflowImportParse';

interface Props {
  open: boolean;
  onClose: () => void;
}

type ApplyKind = 'internal' | 'formal';
type FormalSourceMode = 'internal_registration' | 'manual_t';
type View = 'apply' | 'records' | 'registry' | 'application-records' | 'archive';

type FormState = {
  projectType: '' | 'standard' | 'custom';
  versionType: '' | 'major' | 'medium' | 'minor';
  needUiDesign: '' | 'yes' | 'no';
  isAiPoc: '' | 'yes' | 'no';
  demandSource: string;
  planName: string;
  planUrl: string;
  requirementDescription: string;
  departmentName: string;
  ownerName: string;
  projectMembers: string;
  plannedProjectAt: string;
  plannedReleaseAt: string;
  isGlobalOpen: '' | 'yes' | 'no';
  contractParty: string;
  developmentStatus: string;
  remark: string;
};

const FIELD_CLASS = 'w-full rounded-lg border border-token-subtle bg-token-nested px-3 py-2 text-sm text-token-primary outline-none transition-colors focus:border-indigo-500/70 placeholder-token-muted';

const PROJECT_TYPE_LABELS: Record<VersionRegistration['projectType'], string> = {
  standard: '非定制',
  custom: '定制',
};

const VERSION_TYPE_LABELS: Record<VersionRegistration['versionType'], string> = {
  minor: '小版本',
  medium: '中版本',
  major: '大版本',
};

function emptyForm(): FormState {
  return {
    projectType: '',
    versionType: '',
    needUiDesign: 'no',
    isAiPoc: '',
    demandSource: '',
    planName: '',
    planUrl: '',
    requirementDescription: '',
    departmentName: '',
    ownerName: '',
    projectMembers: '',
    plannedProjectAt: '',
    plannedReleaseAt: '',
    isGlobalOpen: '',
    contractParty: '',
    developmentStatus: '',
    remark: '',
  };
}

function boolValue(value: FormState['needUiDesign']): boolean | undefined {
  if (value === 'yes') return true;
  if (value === 'no') return false;
  return undefined;
}

function boolToChoice(value?: boolean | null): FormState['needUiDesign'] {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return '';
}

function splitMembers(value: string): string[] {
  return value.split(/[、,，;；]/).map((item) => item.trim()).filter(Boolean);
}

function formPayload(form: FormState): VersionRegistrationFields {
  return {
    projectType: form.projectType || undefined,
    versionType: form.versionType || undefined,
    needUiDesign: boolValue(form.needUiDesign),
    isAiPoc: boolValue(form.isAiPoc),
    demandSource: form.demandSource.trim() || undefined,
    planName: form.planName.trim() || undefined,
    planUrl: form.planUrl.trim() || undefined,
    requirementDescription: form.requirementDescription.trim() || undefined,
    departmentName: form.departmentName.trim() || undefined,
    ownerName: form.ownerName.trim() || undefined,
    projectMemberNames: splitMembers(form.projectMembers),
    plannedProjectAt: form.plannedProjectAt || undefined,
    developmentStatus: form.developmentStatus.trim() || undefined,
    remark: form.remark.trim() || undefined,
  };
}

function formFromRegistration(record: VersionRegistration): FormState {
  return {
    projectType: record.projectType ?? '',
    versionType: record.versionType ?? '',
    needUiDesign: boolToChoice(record.needUiDesign),
    isAiPoc: boolToChoice(record.isAiPoc),
    demandSource: record.demandSource ?? '',
    planName: record.planName ?? '',
    planUrl: record.planUrl ?? '',
    requirementDescription: record.requirementDescription ?? '',
    departmentName: record.departmentName ?? '',
    ownerName: record.ownerName ?? '',
    projectMembers: (record.projectMemberNames ?? []).join('、'),
    plannedProjectAt: dateOnly(record.plannedProjectAt),
    plannedReleaseAt: dateOnly(record.plannedReleaseAt),
    isGlobalOpen: boolToChoice(record.isGlobalOpen),
    contractParty: record.contractParty ?? '',
    developmentStatus: record.developmentStatus ?? '',
    remark: record.remark ?? '',
  };
}

function dateOnly(value?: string | null): string {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10);
}

function formatDate(value?: string | null): string {
  if (!value) return '未记录日期';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('zh-CN');
}

function toGlobalOpen(value?: string): boolean | undefined {
  if (!value) return undefined;
  const text = value.trim().toLowerCase();
  if (['是', 'yes', 'true', '1', '全域', '全域开放'].includes(text)) return true;
  if (['否', 'no', 'false', '0', '非全域'].includes(text)) return false;
  return undefined;
}

function mapHistoryVersionType(value?: string): NonNullable<VersionRegistrationFields['versionType']> {
  const text = value?.trim().toLowerCase() ?? '';
  if (text.includes('大') || text.includes('major')) return 'major';
  if (text.includes('中') || text.includes('medium')) return 'medium';
  return 'minor';
}

function mapHistoryRow(row: VersionWorkflowImportRow, kind: ApplyKind): VersionRegistrationImportRow {
  return {
    systemName: row.systemName,
    applicationName: row.appName,
    kind,
    code: row.code,
    tCode: row.tCode,
    projectType: row.projectType === 'custom' ? 'custom' : 'standard',
    versionType: mapHistoryVersionType(row.versionType),
    needUiDesign: row.needUiDesign,
    isAiPoc: row.isAiPoc,
    isGlobalOpen: toGlobalOpen(row.openBrandScope),
    demandSource: row.legacyData?.['需求来源'],
    planName: row.planName,
    planUrl: row.planUrl,
    requirementDescription: row.requirementDescription,
    departmentName: row.departmentName,
    ownerName: row.ownerId,
    projectMemberNames: row.teamMemberIds,
    plannedProjectAt: row.plannedProjectAt ?? row.projectAt,
    plannedReleaseAt: kind === 'formal' ? row.date : undefined,
    contractParty: row.legacyData?.['合同签订方'],
    developmentStatus: row.developmentStatus,
    remark: row.remark,
    sourceRow: row.sourceRow,
  };
}

function registrationMatchesApplication(record: VersionRegistration, application: VersionRegistryApplication): boolean {
  if (record.applicationId) return record.applicationId === application.id;
  if (record.applicationName) return normalizeMatchText(record.applicationName) === normalizeMatchText(application.name);
  return normalizeMatchText(record.planName).includes(normalizeMatchText(application.name));
}

function formPatchFromMessage(result: VersionRegistrationMessageParseResult): Partial<FormState> {
  const patch: Partial<FormState> = {};
  if (result.projectType) patch.projectType = result.projectType;
  if (result.versionType) patch.versionType = result.versionType;
  if (result.needUiDesign != null) patch.needUiDesign = boolToChoice(result.needUiDesign);
  if (result.isAiPoc != null) patch.isAiPoc = boolToChoice(result.isAiPoc);
  if (result.demandSource) patch.demandSource = result.demandSource;
  if (result.planName) patch.planName = result.planName;
  if (result.planUrl) patch.planUrl = result.planUrl;
  if (result.projectMemberNames?.length) patch.projectMembers = result.projectMemberNames.join('、');
  if (result.plannedProjectAt) patch.plannedProjectAt = dateOnly(result.plannedProjectAt);
  if (result.plannedReleaseAt) patch.plannedReleaseAt = dateOnly(result.plannedReleaseAt);
  if (result.isGlobalOpen != null) patch.isGlobalOpen = boolToChoice(result.isGlobalOpen);
  return patch;
}

function messagePlaceholder(kind: ApplyKind): string {
  return kind === 'internal'
    ? '粘贴企微中的“版本立项”内容，例如：\n项目类别：非定制\n版本类别：小版本\n是否需要UI设计：否\n需求来源：登康\n计划立项时间：2026.09.30'
    : '粘贴企微中的“版本上线”内容，例如：\n项目类别：定制\n版本类别：小版本\n是否全域开放：是\n需求来源：拜耳\n项目组成员：宇凡、火巍\n计划上线时间：2026.09.21';
}

function normalizeMatchText(value?: string | null): string {
  return value?.replace(/\s+/g, '').trim().toLocaleLowerCase('zh-CN') ?? '';
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 block text-xs text-token-secondary">{label}{required ? <span className="ml-1 text-red-400">*</span> : null}</span>
      {children}
    </label>
  );
}

function ApplicationRecordList({ records }: { records: VersionRegistration[] }) {
  if (records.length === 0) {
    return (
      <section className="rounded-xl border border-dashed border-token-subtle px-5 py-10 text-center">
        <h4 className="text-sm font-medium text-token-primary">这个应用还没有版本登记</h4>
        <p className="mt-2 text-sm text-token-muted">后续从“申领版本号”选择该应用完成登记后，T 与 V 记录都会显示在这里。</p>
      </section>
    );
  }

  return (
    <section className="space-y-3" aria-label="应用版本详细记录">
      {records.map((record) => (
        <article key={record.id} className="rounded-xl border border-token-subtle bg-token-nested p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-mono text-base font-semibold text-[color:var(--accent-fg-blue)]">{record.code}</p>
              <p className="mt-1 text-xs text-token-muted">
                {record.kind === 'internal' ? '内部版本号 T' : `正式版本号 V${record.tCode ? ` · 对应 ${record.tCode}` : ''}`}
                {' · '}{PROJECT_TYPE_LABELS[record.projectType]} · {VERSION_TYPE_LABELS[record.versionType]}
              </p>
            </div>
            <p className="text-xs text-token-muted">{formatDate(record.plannedReleaseAt || record.plannedProjectAt || record.createdAt)}</p>
          </div>
          <h4 className="mt-4 text-sm font-medium text-token-primary">{record.planName || '未填写方案名称'}</h4>
          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
            <div><dt className="text-token-muted">需求来源</dt><dd className="mt-0.5 text-token-secondary">{record.demandSource || '未填写'}</dd></div>
            <div><dt className="text-token-muted">产品负责人</dt><dd className="mt-0.5 text-token-secondary">{record.ownerName || record.createdByName || '未填写'}</dd></div>
            <div><dt className="text-token-muted">项目组成员</dt><dd className="mt-0.5 text-token-secondary">{record.projectMemberNames.length > 0 ? record.projectMemberNames.join('、') : '未填写'}</dd></div>
            <div><dt className="text-token-muted">登记来源</dt><dd className="mt-0.5 text-token-secondary">{record.sourceType === 'history_import' ? '历史导入' : '当前申领'}</dd></div>
          </dl>
          {record.planUrl ? <p className="mt-3 break-all text-xs text-[color:var(--accent-fg-blue)]">方案地址：{record.planUrl}</p> : null}
          {record.requirementDescription ? <p className="mt-3 whitespace-pre-wrap rounded-lg border border-token-subtle bg-token-nested px-3 py-2 text-xs leading-5 text-token-secondary">{record.requirementDescription}</p> : null}
          {record.remark ? <p className="mt-2 text-xs leading-5 text-token-muted">备注：{record.remark}</p> : null}
        </article>
      ))}
    </section>
  );
}

function VersionTypeSelect({ value, onChange }: { value: FormState['versionType']; onChange: (value: FormState['versionType']) => void }) {
  return (
    <select className={FIELD_CLASS} value={value} onChange={(event) => onChange(event.target.value as FormState['versionType'])}>
      <option value="">请选择版本类别</option>
      <option value="minor">小版本：末位加 1</option>
      <option value="medium">中版本：中位加 1，末位归 0</option>
      <option value="major">大版本：首位加 1，其余归 0</option>
    </select>
  );
}

function YesNoSelect({ value, onChange, placeholder = '暂不填写' }: { value: FormState['needUiDesign']; onChange: (value: FormState['needUiDesign']) => void; placeholder?: string }) {
  return (
    <select className={FIELD_CLASS} value={value} onChange={(event) => onChange(event.target.value as FormState['needUiDesign'])}>
      <option value="">{placeholder}</option>
      <option value="yes">是</option>
      <option value="no">否</option>
    </select>
  );
}

function InputFields({ form, setForm, mode, strictFormal }: { form: FormState; setForm: (update: Partial<FormState>) => void; mode: ApplyKind; strictFormal: boolean }) {
  const isInternal = mode === 'internal';
  const isFormalRequired = !isInternal && strictFormal;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="项目类别" required>
        <select className={FIELD_CLASS} value={form.projectType} onChange={(event) => setForm({ projectType: event.target.value as FormState['projectType'] })}>
          <option value="">请选择项目类别</option>
          <option value="standard">非定制</option>
          <option value="custom">定制</option>
        </select>
      </Field>
      <Field label="版本类别" required>
        <VersionTypeSelect value={form.versionType} onChange={(versionType) => setForm({ versionType })} />
      </Field>
      {isInternal ? (
        <>
          <Field label="是否需要 UI 设计" required>
            <YesNoSelect value={form.needUiDesign} onChange={(needUiDesign) => setForm({ needUiDesign })} />
          </Field>
          <Field label="是否属于 AI POC 项目" required>
            <YesNoSelect value={form.isAiPoc} onChange={(isAiPoc) => setForm({ isAiPoc })} />
          </Field>
        </>
      ) : (
        <Field label="是否全域开放" required={isFormalRequired}>
          <YesNoSelect value={form.isGlobalOpen} onChange={(isGlobalOpen) => setForm({ isGlobalOpen })} />
        </Field>
      )}
      <Field label="需求来源" required={isInternal || isFormalRequired}>
        <input className={FIELD_CLASS} value={form.demandSource} onChange={(event) => setForm({ demandSource: event.target.value })} placeholder="例如：拜耳、登康、内部" />
      </Field>
      <Field label={isInternal ? '产品立项方案名称' : '产品方案名称'} required={isInternal || isFormalRequired}>
        <input className={FIELD_CLASS} value={form.planName} onChange={(event) => setForm({ planName: event.target.value })} placeholder="从评审记录带入后可补充" />
      </Field>
      <Field label="方案地址" required={isFormalRequired}>
        <input className={FIELD_CLASS} value={form.planUrl} onChange={(event) => setForm({ planUrl: event.target.value })} placeholder="可粘贴方案链接" />
      </Field>
      <Field label="项目组成员" required={isFormalRequired}>
        <input className={FIELD_CLASS} value={form.projectMembers} onChange={(event) => setForm({ projectMembers: event.target.value })} placeholder="用顿号或逗号分隔" />
      </Field>
      <Field label={isInternal ? '计划立项时间' : '计划上线时间'} required={isInternal || isFormalRequired}>
        <input className={FIELD_CLASS} type="date" value={isInternal ? form.plannedProjectAt : form.plannedReleaseAt} onChange={(event) => setForm(isInternal ? { plannedProjectAt: event.target.value } : { plannedReleaseAt: event.target.value })} />
      </Field>
      {isInternal ? (
        <Field label="开发状态">
          <input className={FIELD_CLASS} value={form.developmentStatus} onChange={(event) => setForm({ developmentStatus: event.target.value })} placeholder="可选" />
        </Field>
      ) : (
        <Field label="合同签订方">
          <input className={FIELD_CLASS} value={form.contractParty} onChange={(event) => setForm({ contractParty: event.target.value })} placeholder="特殊情况可留空" />
        </Field>
      )}
      <Field label="所属部门">
        <input className={FIELD_CLASS} value={form.departmentName} onChange={(event) => setForm({ departmentName: event.target.value })} placeholder="可选" />
      </Field>
      <Field label="产品负责人">
        <input className={FIELD_CLASS} value={form.ownerName} onChange={(event) => setForm({ ownerName: event.target.value })} placeholder="可选" />
      </Field>
      <Field label="项目需求描述" >
        <textarea className={`${FIELD_CLASS} min-h-20 resize-y`} value={form.requirementDescription} onChange={(event) => setForm({ requirementDescription: event.target.value })} placeholder="可选" />
      </Field>
      <Field label="备注">
        <textarea className={`${FIELD_CLASS} min-h-20 resize-y`} value={form.remark} onChange={(event) => setForm({ remark: event.target.value })} placeholder="可选" />
      </Field>
    </div>
  );
}

function VersionRegistrySelect({
  systems,
  selectedSystemId,
  selectedApplicationId,
  suggestedApplication,
  onSelectSystem,
  onSelectApplication,
  onOpenRegistry,
}: {
  systems: VersionRegistrySystem[];
  selectedSystemId: string;
  selectedApplicationId: string;
  suggestedApplication?: VersionRegistryApplication;
  onSelectSystem: (systemId: string) => void;
  onSelectApplication: (applicationId: string) => void;
  onOpenRegistry: () => void;
}) {
  const selectedSystem = systems.find((system) => system.id === selectedSystemId);
  const applications = selectedSystem?.applications ?? [];
  return (
    <section className="rounded-xl border border-indigo-500/35 bg-indigo-500/[0.04] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-token-primary">先确定系统和应用</h3>
          <p className="mt-1 text-xs leading-5 text-token-muted">版本号按应用独立分配。粘贴企微内容或选中方案后，系统会优先带出匹配的应用。</p>
        </div>
        <button type="button" onClick={onOpenRegistry} className="inline-flex items-center gap-1.5 text-xs font-medium text-[color:var(--accent-fg-blue)] hover:underline">
          <Settings2 className="h-3.5 w-3.5" />新建系统或应用
        </button>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="系统" required>
          <select className={FIELD_CLASS} value={selectedSystemId} onChange={(event) => onSelectSystem(event.target.value)}>
            <option value="">请选择系统</option>
            {systems.map((system) => <option key={system.id} value={system.id}>{system.name}</option>)}
          </select>
        </Field>
        <Field label="应用" required>
          <select className={FIELD_CLASS} value={selectedApplicationId} disabled={!selectedSystemId} onChange={(event) => onSelectApplication(event.target.value)}>
            <option value="">{selectedSystemId ? '请选择应用' : '请先选择系统'}</option>
            {applications.map((application) => <option key={application.id} value={application.id}>{application.name}</option>)}
          </select>
        </Field>
      </div>
      {suggestedApplication ? (
        <p className="mt-3 text-xs text-[color:var(--accent-fg-blue)]">已从方案匹配到“{suggestedApplication.systemName} / {suggestedApplication.name}”。你仍可手动调整。</p>
      ) : null}
    </section>
  );
}

export function VersionRegistrationDialog({ open, onClose }: Props) {
  const [view, setView] = useState<View>('apply');
  const [kind, setKind] = useState<ApplyKind | null>(null);
  const [formalSourceMode, setFormalSourceMode] = useState<FormalSourceMode>('internal_registration');
  const [wecomMessage, setWecomMessage] = useState('');
  const [messageParsing, setMessageParsing] = useState(false);
  const [messageParseHint, setMessageParseHint] = useState('');
  const [reviewSources, setReviewSources] = useState<VersionRegistrationReviewSource[]>([]);
  const [internalSources, setInternalSources] = useState<VersionRegistration[]>([]);
  const [records, setRecords] = useState<VersionRegistration[]>([]);
  const [snapshots, setSnapshots] = useState<VersionRegistrationSnapshotSummary[]>([]);
  const [registrySystems, setRegistrySystems] = useState<VersionRegistrySystem[]>([]);
  const [registryMatches, setRegistryMatches] = useState<VersionRegistryMatch[]>([]);
  const [selectedSystemId, setSelectedSystemId] = useState('');
  const [selectedApplicationId, setSelectedApplicationId] = useState('');
  const [publicRecords, setPublicRecords] = useState<VersionRegistration[]>([]);
  const [publicKind, setPublicKind] = useState<'' | ApplyKind>('');
  const [publicSystemId, setPublicSystemId] = useState('');
  const [publicApplicationId, setPublicApplicationId] = useState('');
  const [publicPerson, setPublicPerson] = useState('');
  const [publicPlanName, setPublicPlanName] = useState('');
  const [publicLoading, setPublicLoading] = useState(false);
  const [registryDetailApplicationId, setRegistryDetailApplicationId] = useState('');
  const [applicationRecords, setApplicationRecords] = useState<VersionRegistration[]>([]);
  const [applicationRecordsLoading, setApplicationRecordsLoading] = useState(false);
  const [newSystemName, setNewSystemName] = useState('');
  const [newApplicationSystemId, setNewApplicationSystemId] = useState('');
  const [newApplicationName, setNewApplicationName] = useState('');
  const [reviewSubmissionId, setReviewSubmissionId] = useState('');
  const [internalRegistrationId, setInternalRegistrationId] = useState('');
  const [manualTCode, setManualTCode] = useState('');
  const [form, setForm] = useState<FormState>(emptyForm);
  const [historyFile, setHistoryFile] = useState<File | null>(null);
  const [historyKind, setHistoryKind] = useState<ApplyKind>('internal');
  const [snapshotName, setSnapshotName] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const [issuedCode, setIssuedCode] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const messageParseRequestRef = useRef(0);

  const reload = useCallback(async () => {
    setLoading(true);
    setMessage('');
    const [reviewResult, internalResult, recordsResult, snapshotsResult, registryResult, publicResult] = await Promise.all([
      getVersionRegistrationReviewSources(),
      getVersionRegistrationInternalSources(),
      getVersionRegistrations(),
      getVersionRegistrationSnapshots(),
      getVersionRegistry(),
      getPublicVersionRegistrations(),
    ]);
    if (reviewResult.success) setReviewSources(reviewResult.data.items);
    if (internalResult.success) setInternalSources(internalResult.data.items);
    if (recordsResult.success) setRecords(recordsResult.data.items);
    if (snapshotsResult.success) setSnapshots(snapshotsResult.data.items);
    if (registryResult.success) {
      setRegistrySystems(registryResult.data.systems);
      setNewApplicationSystemId((previous) => previous || registryResult.data.systems[0]?.id || '');
    }
    if (publicResult.success) setPublicRecords(publicResult.data.items);
    const failed = [reviewResult, internalResult, recordsResult, snapshotsResult, registryResult, publicResult].find((result) => !result.success);
    if (failed && !failed.success) setMessage(failed.error.message || '登记资料加载失败，请稍后重试');
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    void reload();
  }, [open, reload]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const passedReviewSources = useMemo(() => reviewSources.filter((item) => item.isPassed === true), [reviewSources]);
  const selectedReview = useMemo(() => passedReviewSources.find((item) => item.id === reviewSubmissionId), [passedReviewSources, reviewSubmissionId]);
  const registryApplications = useMemo(() => registrySystems.flatMap((system) => system.applications), [registrySystems]);
  const registryDetailApplication = useMemo(
    () => registryApplications.find((application) => application.id === registryDetailApplicationId),
    [registryApplications, registryDetailApplicationId],
  );
  const suggestedApplication = useMemo(() => {
    const match = registryMatches[0];
    return match ? registryApplications.find((application) => application.id === match.id) : undefined;
  }, [registryApplications, registryMatches]);
  const visibleInternalSources = useMemo(() => {
    if (!selectedApplicationId) return internalSources;
    const application = registryApplications.find((item) => item.id === selectedApplicationId);
    return application
      ? internalSources.filter((source) => registrationMatchesApplication(source, application))
      : [];
  }, [internalSources, registryApplications, selectedApplicationId]);
  const publicApplications = useMemo(
    () => registrySystems.find((system) => system.id === publicSystemId)?.applications ?? registryApplications,
    [publicSystemId, registryApplications, registrySystems],
  );
  const patchForm = (update: Partial<FormState>) => setForm((previous) => ({ ...previous, ...update }));

  const chooseSystem = useCallback((systemId: string) => {
    setSelectedSystemId(systemId);
    setSelectedApplicationId('');
  }, []);

  const chooseApplication = useCallback((applicationId: string) => {
    setSelectedApplicationId(applicationId);
    const application = registryApplications.find((item) => item.id === applicationId);
    if (application) setSelectedSystemId(application.systemId);
  }, [registryApplications]);

  const chooseKind = (nextKind: ApplyKind) => {
    setKind(nextKind);
    setMessage('');
    setIssuedCode('');
    setForm(emptyForm());
    setWecomMessage('');
    setMessageParseHint('');
    messageParseRequestRef.current += 1;
    setReviewSubmissionId('');
    setInternalRegistrationId('');
    setManualTCode('');
    setSelectedSystemId('');
    setSelectedApplicationId('');
    setRegistryMatches([]);
  };

  const parseWecomMessage = useCallback(async (text: string, applyResult: boolean) => {
    if (!kind || text.trim().length < 4) return;
    const requestId = ++messageParseRequestRef.current;
    setMessageParsing(true);
    try {
      const result = await parseVersionRegistrationMessage({ kind, text });
      if (requestId !== messageParseRequestRef.current) return;
      if (result.success) {
        const parsed = result.data.result;
        let sourceMatchHint = '';
        if (applyResult && parsed.matchedFields.length > 0) {
          const parsedFormPatch = formPatchFromMessage(parsed);
          let matchedInternalSource: VersionRegistration | undefined;
          if (kind === 'internal' && parsed.planName) {
            const normalizedPlanName = normalizeMatchText(parsed.planName);
            const matchingReview = passedReviewSources.find((source) => normalizeMatchText(source.title) === normalizedPlanName);
            if (matchingReview) {
              setReviewSubmissionId(matchingReview.id);
              sourceMatchHint = ' 已匹配到产品评审记录。';
            }
          }
          if (kind === 'formal' && parsed.tCode) {
            const matchingInternal = internalSources.find((source) => source.code.toUpperCase() === parsed.tCode?.toUpperCase());
            if (matchingInternal) {
              matchedInternalSource = matchingInternal;
              setFormalSourceMode('internal_registration');
              setInternalRegistrationId(matchingInternal.id);
              if (matchingInternal.applicationId) chooseApplication(matchingInternal.applicationId);
              sourceMatchHint = ' 已匹配到已登记的内部版本号。';
            } else {
              setFormalSourceMode('manual_t');
              setManualTCode(parsed.tCode);
              sourceMatchHint = ' 未找到已登记的内部版本号，已带入手工填写 T。';
            }
          }
          setForm((previous) => ({
            ...previous,
            ...(matchedInternalSource ? formFromRegistration(matchedInternalSource) : {}),
            ...parsedFormPatch,
          }));
        }
        setMessageParseHint(parsed.matchedFields.length > 0
          ? `已识别并回填 ${parsed.matchedFields.length} 项；未识别的字段不会补造内容。${sourceMatchHint}`
          : '没有识别到可回填字段，现有表单内容保持不变。');
      } else {
        setMessageParseHint(result.error.message || '暂时无法识别内容，现有表单内容保持不变。');
      }
    } catch {
      if (requestId === messageParseRequestRef.current)
        setMessageParseHint('暂时无法识别内容，现有表单内容保持不变。');
    } finally {
      if (requestId === messageParseRequestRef.current) setMessageParsing(false);
    }
  }, [chooseApplication, internalSources, kind, passedReviewSources]);

  useEffect(() => {
    if (!kind || wecomMessage.trim().length < 4) {
      setMessageParseHint('');
      return undefined;
    }
    const timer = window.setTimeout(() => { void parseWecomMessage(wecomMessage, true); }, 600);
    return () => window.clearTimeout(timer);
  }, [kind, parseWecomMessage, wecomMessage]);

  useEffect(() => {
    const planName = form.planName.trim();
    if (!kind || planName.length < 2) {
      setRegistryMatches([]);
      return undefined;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void findVersionRegistryMatches(planName).then((result) => {
        if (cancelled || !result.success) return;
        setRegistryMatches(result.data.items);
        const firstMatch = result.data.items[0];
        if (firstMatch && !selectedApplicationId) {
          setSelectedSystemId(firstMatch.systemId);
          setSelectedApplicationId(firstMatch.id);
        }
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [form.planName, kind, selectedApplicationId]);

  useEffect(() => {
    if (!internalRegistrationId || !selectedApplicationId) return;
    const application = registryApplications.find((item) => item.id === selectedApplicationId);
    const source = internalSources.find((item) => item.id === internalRegistrationId);
    if (application && source && !registrationMatchesApplication(source, application))
      setInternalRegistrationId('');
  }, [internalRegistrationId, internalSources, registryApplications, selectedApplicationId]);

  const chooseReview = (id: string) => {
    setReviewSubmissionId(id);
    const source = passedReviewSources.find((item) => item.id === id);
    if (source) patchForm({ planName: source.title });
  };

  const chooseInternalSource = (id: string) => {
    setInternalRegistrationId(id);
    const source = internalSources.find((item) => item.id === id);
    if (source) {
      setForm(formFromRegistration(source));
      if (source.applicationId) chooseApplication(source.applicationId);
    }
  };

  const submitApplication = async () => {
    if (!kind) return;
    setMessage('');
    setIssuedCode('');
    if (!form.projectType || !form.versionType) {
      setMessage('请先选择项目类别和版本类别，或粘贴企微登记内容后自动回填');
      return;
    }
    if (!selectedApplicationId) {
      setMessage('请先选择系统和应用；版本号会按所选应用独立分配');
      return;
    }
    setSubmitting(true);
    const base = { ...formPayload(form), applicationId: selectedApplicationId };
    const result = kind === 'internal'
      ? await createInternalVersionRegistration({ ...base, reviewSubmissionId })
      : await createFormalVersionRegistration({
        ...base,
        sourceMode: formalSourceMode,
        sourceInternalRegistrationId: formalSourceMode === 'internal_registration' ? internalRegistrationId : undefined,
        tCode: formalSourceMode === 'manual_t' ? manualTCode.trim() : undefined,
        isGlobalOpen: boolValue(form.isGlobalOpen),
        plannedReleaseAt: form.plannedReleaseAt || undefined,
        contractParty: form.contractParty.trim() || undefined,
      });
    setSubmitting(false);
    if (!result.success) {
      setMessage(result.error.message || '申领未完成，请检查填写内容');
      return;
    }
    setIssuedCode(result.data.record.code);
    setMessage(`${result.data.record.code} 已完成登记。编号一经生成不会回收。`);
    await reload();
  };

  const importHistory = async () => {
    if (!historyFile) {
      setMessage('请选择要导入的历史登记文件');
      return;
    }
    setMessage('');
    setSubmitting(true);
    try {
      const parsed = await parseVersionWorkflowImportFile(historyFile, historyKind === 'internal' ? 'initiation' : 'release');
      const rows = parsed.map((row) => mapHistoryRow(row, historyKind));
      if (rows.length === 0) {
        setMessage('没有读取到可导入的登记行，请确认表头和版本号列');
        return;
      }
      const uploaded = await uploadAttachment(historyFile);
      if (!uploaded.success) {
        setMessage(uploaded.error.message || '历史文件上传失败');
        return;
      }
      const result = await importVersionRegistrations({
        snapshotName: snapshotName.trim() || undefined,
        sourceAttachmentId: uploaded.data.attachmentId,
        sourceFileName: historyFile.name,
        rows,
      });
      if (!result.success) {
        setMessage(result.error.message || '历史登记导入失败');
        return;
      }
      setMessage(`历史导入已完成：新增 ${result.data.created} 条，跳过 ${result.data.skipped} 条。原文件和本次结果已存为快照。`);
      setHistoryFile(null);
      if (fileRef.current) fileRef.current.value = '';
      await reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '历史登记文件解析失败');
    } finally {
      setSubmitting(false);
    }
  };

  const saveCurrentSnapshot = async () => {
    setMessage('');
    setSubmitting(true);
    const result = await createCurrentVersionRegistrationSnapshot(snapshotName.trim() || undefined);
    setSubmitting(false);
    if (!result.success) {
      setMessage(result.error.message || '当前登记快照保存失败');
      return;
    }
    setMessage(`已保存快照“${result.data.snapshot.name}”，不会覆盖已有登记。`);
    setSnapshotName('');
    await reload();
  };

  const loadPublicRecords = async () => {
    setPublicLoading(true);
    setMessage('');
    const result = await getPublicVersionRegistrations({
      kind: publicKind || undefined,
      systemId: publicSystemId || undefined,
      applicationId: publicApplicationId || undefined,
      person: publicPerson,
      planName: publicPlanName,
    });
    setPublicLoading(false);
    if (!result.success) {
      setMessage(result.error.message || '公共版本记录读取失败，请稍后重试');
      return;
    }
    setPublicRecords(result.data.items);
  };

  const openApplicationRecords = async (application: VersionRegistryApplication) => {
    setRegistryDetailApplicationId(application.id);
    setApplicationRecords([]);
    setApplicationRecordsLoading(true);
    setMessage('');
    setView('application-records');
    const result = await getPublicVersionRegistrations({ applicationId: application.id });
    setApplicationRecordsLoading(false);
    if (!result.success) {
      setMessage(result.error.message || '应用版本记录读取失败，请稍后重试');
      return;
    }
    setApplicationRecords(result.data.items);
  };

  const returnToRegistry = () => {
    setRegistryDetailApplicationId('');
    setApplicationRecords([]);
    setView('registry');
  };

  const createRegistrySystem = async () => {
    const name = newSystemName.trim();
    if (!name) {
      setMessage('请填写要新建的系统名称');
      return;
    }
    setSubmitting(true);
    setMessage('');
    const result = await createVersionRegistrySystem(name);
    setSubmitting(false);
    if (!result.success) {
      setMessage(result.error.message || '系统创建失败，请稍后重试');
      return;
    }
    setNewSystemName('');
    await reload();
    setNewApplicationSystemId(result.data.system.id);
    setMessage(result.data.reused ? `系统“${result.data.system.name}”已存在，已直接复用。` : `已创建系统“${result.data.system.name}”。接下来可在右侧新建应用。`);
  };

  const createRegistryApplication = async () => {
    const name = newApplicationName.trim();
    if (!newApplicationSystemId) {
      setMessage('请先选择应用归属的系统');
      return;
    }
    if (!name) {
      setMessage('请填写要新建的应用名称');
      return;
    }
    setSubmitting(true);
    setMessage('');
    const result = await createVersionRegistryApplication({ systemId: newApplicationSystemId, name });
    setSubmitting(false);
    if (!result.success) {
      setMessage(result.error.message || '应用创建失败，请检查归属系统');
      return;
    }
    setNewApplicationName('');
    await reload();
    setSelectedSystemId(result.data.application.systemId);
    setSelectedApplicationId(result.data.application.id);
    setMessage(result.data.reused ? `应用“${result.data.application.name}”已存在，已直接复用。` : `已创建应用“${result.data.application.name}”，现在可以返回申领页使用。`);
  };

  if (!open) return null;

  const modal = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm" onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="版本号申领"
        className="flex w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-token-subtle shadow-2xl"
        style={{ height: '90vh', maxHeight: '90vh', background: 'var(--bg-primary, #1a1a2e)' }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-token-subtle px-5 py-4 sm:px-6">
          <div>
            <div className="flex items-center gap-2 text-token-primary">
              <BookOpenCheck className="h-5 w-5 text-[color:var(--accent-fg-blue)]" />
              <h2 className="text-base font-semibold">版本号申领</h2>
            </div>
            <p className="mt-1 text-xs text-token-muted">T 与 V 独立编号。小版本末位加 1，中版本中位加 1，大版本首位加 1。</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-token-muted hover-bg-soft hover-text-primary" aria-label="关闭">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex shrink-0 gap-2 border-b border-token-subtle px-5 py-3 sm:px-6">
          <button type="button" onClick={() => setView('apply')} className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${view === 'apply' ? 'bg-indigo-600 text-white' : 'text-token-secondary hover-bg-soft hover-text-primary'}`}>
            申领版本号
          </button>
          <button type="button" onClick={() => setView('records')} className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${view === 'records' ? 'bg-indigo-600 text-white' : 'text-token-secondary hover-bg-soft hover-text-primary'}`}>
            当前 T/V 记录
          </button>
          <button type="button" onClick={returnToRegistry} className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${view === 'registry' || view === 'application-records' ? 'bg-indigo-600 text-white' : 'text-token-secondary hover-bg-soft hover-text-primary'}`}>
            系统与应用
          </button>
          <button type="button" onClick={() => setView('archive')} className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${view === 'archive' ? 'bg-indigo-600 text-white' : 'text-token-secondary hover-bg-soft hover-text-primary'}`}>
            历史导入与快照
          </button>
        </div>

        <main className="flex-1 px-5 py-5 sm:px-6" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {message ? (
            <div className={`mb-4 rounded-lg border px-3 py-2 text-sm ${issuedCode ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/30 bg-amber-500/10 text-[color:var(--accent-fg-amber)]'}`}>
              {message}
            </div>
          ) : null}

          {loading ? <MapSectionLoader text="正在读取可申领资料..." /> : null}

          {!loading && view === 'apply' ? (
            <div className="space-y-5">
              {!kind ? (
                <section aria-label="选择申领类型">
                  <p className="mb-3 text-sm text-token-secondary">请选择适合当前情况的一种申请模式；T 与 V 相互独立，点击卡片开始填写。</p>
                  <div className="grid gap-3 md:grid-cols-2">
                    <button type="button" onClick={() => chooseKind('formal')} aria-label="点击开始申领正式版本号 V" className="group rounded-xl border border-token-subtle bg-token-nested p-5 text-left transition-all hover:border-indigo-500/60 hover-bg-soft focus-visible:border-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40">
                      <span className="block text-xl font-semibold tracking-tight text-token-primary sm:text-2xl">正式版本号 V</span>
                      <span className="mt-5 inline-flex items-center gap-1.5 text-base font-medium text-[color:var(--accent-fg-blue)]">点击开始申领 <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" /></span>
                    </button>
                    <button type="button" onClick={() => chooseKind('internal')} aria-label="点击开始申领内部版本号 T" className="group rounded-xl border border-token-subtle bg-token-nested p-5 text-left transition-all hover:border-indigo-500/60 hover-bg-soft focus-visible:border-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40">
                      <span className="block text-xl font-semibold tracking-tight text-token-primary sm:text-2xl">内部版本号 T</span>
                      <span className="mt-5 inline-flex items-center gap-1.5 text-base font-medium text-[color:var(--accent-fg-blue)]">点击开始申领 <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" /></span>
                    </button>
                  </div>
                </section>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-token-subtle bg-token-nested px-4 py-3">
                    <div>
                      <p className="text-sm font-medium text-token-primary">{kind === 'internal' ? '申领内部版本号 T' : '申领正式版本号 V'}</p>
                      <p className="mt-1 text-xs text-token-muted">{kind === 'internal' ? '评审完成后可直接登记，系统会按 T 序列发号。' : '系统会按独立 V 序列发号，不会把 T 前缀直接替换为 V。'}</p>
                    </div>
                    <button type="button" className="text-xs text-[color:var(--accent-fg-blue)] hover:underline" onClick={() => { messageParseRequestRef.current += 1; setKind(null); setIssuedCode(''); setMessage(''); setWecomMessage(''); setMessageParseHint(''); }}>重新选择</button>
                  </div>

                  <div className="rounded-xl border border-dashed border-indigo-500/40 bg-indigo-500/[0.04] p-4">
                    <Field label="粘贴企微登记内容">
                      <textarea
                        className={`${FIELD_CLASS} min-h-32 resize-y`}
                        value={wecomMessage}
                        onChange={(event) => { messageParseRequestRef.current += 1; setWecomMessage(event.target.value); }}
                        placeholder={messagePlaceholder(kind)}
                      />
                    </Field>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs leading-5 text-token-muted">支持“字段：内容”格式。识别到的内容会自动回填，未匹配字段保持空白。</p>
                      <button type="button" onClick={() => void parseWecomMessage(wecomMessage, true)} disabled={messageParsing || wecomMessage.trim().length < 4} className="inline-flex items-center gap-1.5 text-xs font-medium text-[color:var(--accent-fg-blue)] disabled:cursor-not-allowed disabled:opacity-50">
                        {messageParsing ? <MapSpinner size={13} /> : null}
                        {messageParsing ? '正在识别' : '重新识别'}
                      </button>
                    </div>
                    {messageParseHint ? <p className="mt-2 text-xs text-token-secondary">{messageParseHint}</p> : null}
                  </div>

                  <VersionRegistrySelect
                    systems={registrySystems}
                    selectedSystemId={selectedSystemId}
                    selectedApplicationId={selectedApplicationId}
                    suggestedApplication={suggestedApplication}
                    onSelectSystem={chooseSystem}
                    onSelectApplication={chooseApplication}
                    onOpenRegistry={() => setView('registry')}
                  />

                  {kind === 'internal' ? (
                    <Field label="选择已通过的产品评审记录" required>
                      <select className={FIELD_CLASS} value={reviewSubmissionId} onChange={(event) => chooseReview(event.target.value)}>
                        <option value="">请选择评审记录</option>
                        {passedReviewSources.map((source) => (
                          <option key={source.id} value={source.id}>{source.title} · 已通过 · {formatDate(source.completedAt)}</option>
                        ))}
                      </select>
                      {selectedReview ? <p className="mt-1.5 text-xs text-token-muted">已从“{selectedReview.fileName}”带入方案标题，你可以补充或调整登记信息。</p> : null}
                      {passedReviewSources.length === 0 ? <p className="mt-1.5 text-xs text-token-muted">暂无可用记录。请先完成并通过一条本人提交的产品评审，已申领过 T 的记录不会重复出现。</p> : null}
                    </Field>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => setFormalSourceMode('internal_registration')} className={`rounded-lg border px-3 py-2 text-sm transition-colors ${formalSourceMode === 'internal_registration' ? 'border-indigo-500 bg-indigo-500/15 text-[color:var(--accent-fg-blue)]' : 'border-token-subtle text-token-secondary hover-bg-soft'}`}>选择已登记 T</button>
                        <button type="button" onClick={() => { setFormalSourceMode('manual_t'); if (!wecomMessage.trim()) setForm(emptyForm()); }} className={`rounded-lg border px-3 py-2 text-sm transition-colors ${formalSourceMode === 'manual_t' ? 'border-indigo-500 bg-indigo-500/15 text-[color:var(--accent-fg-blue)]' : 'border-token-subtle text-token-secondary hover-bg-soft'}`}>手工填写 T</button>
                      </div>
                      {formalSourceMode === 'internal_registration' ? (
                        <Field label="选择已登记的内部版本号" required>
                          <select className={FIELD_CLASS} value={internalRegistrationId} onChange={(event) => chooseInternalSource(event.target.value)}>
                            <option value="">请选择 T 号</option>
                            {visibleInternalSources.map((source) => <option key={source.id} value={source.id}>{source.code} · {source.planName || '未命名方案'} · {formatDate(source.createdAt)}</option>)}
                          </select>
                          {visibleInternalSources.length === 0 ? <p className="mt-1.5 text-xs text-token-muted">当前应用还没有可选的公共 T 号。可先申领 T，或选择“手工填写 T”。</p> : null}
                        </Field>
                      ) : (
                        <Field label="已有内部版本号 T" required>
                          <input className={FIELD_CLASS} value={manualTCode} onChange={(event) => setManualTCode(event.target.value.toUpperCase())} placeholder="例如 T3.47.3" />
                          <p className="mt-1.5 text-xs text-token-muted">特殊情况可只提供 T 号和已知资料，其他关联信息可留空。</p>
                        </Field>
                      )}
                    </div>
                  )}

                  <InputFields form={form} setForm={patchForm} mode={kind} strictFormal={kind === 'formal' && formalSourceMode === 'internal_registration'} />

                  <div className="flex justify-end gap-2 border-t border-token-subtle pt-4">
                    <button type="button" onClick={() => { setKind(null); setMessage(''); setIssuedCode(''); }} className="rounded-lg border border-token-subtle px-4 py-2 text-sm text-token-secondary hover-bg-soft">取消</button>
                    <button type="button" disabled={submitting} onClick={() => void submitApplication()} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60">
                      {submitting ? <MapSpinner size={15} /> : <Plus className="h-4 w-4" />}
                      完成申领并生成 {kind === 'internal' ? 'T' : 'V'} 号
                    </button>
                  </div>
                </>
              )}

              {records.length > 0 ? (
                <section className="border-t border-token-subtle pt-5">
                  <h3 className="text-sm font-medium text-token-primary">我的近期登记</h3>
                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    {records.slice(0, 6).map((record) => (
                      <div key={record.id} className="rounded-lg border border-token-subtle bg-token-nested px-3 py-2.5">
                        <div className="flex items-center justify-between gap-3"><span className="font-mono text-sm font-semibold text-[color:var(--accent-fg-blue)]">{record.code}</span><span className="text-[11px] text-token-muted">{record.kind === 'internal' ? '内部 T' : `正式 V · ${record.tCode || '手工 T'}`}</span></div>
                        <p className="mt-1 truncate text-xs text-token-secondary">{record.planName || '未填写方案名称'}</p>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
            </div>
          ) : null}

          {!loading && view === 'records' ? (
            <div className="space-y-5">
              <section className="rounded-xl border border-token-subtle bg-token-nested p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-token-primary"><ListFilter className="h-5 w-5 text-[color:var(--accent-fg-blue)]" /><h3 className="text-sm font-medium">当前 T/V 记录</h3></div>
                    <p className="mt-1 text-xs leading-5 text-token-muted">这是所有申请人共用的只读登记簿。可按人、系统、应用或方案查找，历史记录不会在这里被改写。</p>
                  </div>
                  <button type="button" onClick={() => void loadPublicRecords()} disabled={publicLoading} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-60">
                    {publicLoading ? <MapSpinner size={15} /> : <Search className="h-4 w-4" />}查询记录
                  </button>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label="版本类型">
                    <select className={FIELD_CLASS} value={publicKind} onChange={(event) => setPublicKind(event.target.value as '' | ApplyKind)}>
                      <option value="">T 与 V 全部</option>
                      <option value="internal">仅内部 T</option>
                      <option value="formal">仅正式 V</option>
                    </select>
                  </Field>
                  <Field label="系统">
                    <select className={FIELD_CLASS} value={publicSystemId} onChange={(event) => { setPublicSystemId(event.target.value); setPublicApplicationId(''); }}>
                      <option value="">全部系统</option>
                      {registrySystems.map((system) => <option key={system.id} value={system.id}>{system.name}</option>)}
                    </select>
                  </Field>
                  <Field label="应用">
                    <select className={FIELD_CLASS} value={publicApplicationId} onChange={(event) => setPublicApplicationId(event.target.value)}>
                      <option value="">全部应用</option>
                      {publicApplications.map((application) => <option key={application.id} value={application.id}>{application.name}</option>)}
                    </select>
                  </Field>
                  <Field label="人名">
                    <input className={FIELD_CLASS} value={publicPerson} onChange={(event) => setPublicPerson(event.target.value)} placeholder="申请人或产品负责人" />
                  </Field>
                  <Field label="方案名称">
                    <input className={FIELD_CLASS} value={publicPlanName} onChange={(event) => setPublicPlanName(event.target.value)} placeholder="输入方案关键词" />
                  </Field>
                  <div className="flex items-end">
                    <button type="button" onClick={() => { setPublicKind(''); setPublicSystemId(''); setPublicApplicationId(''); setPublicPerson(''); setPublicPlanName(''); }} className="px-1 py-2 text-sm text-[color:var(--accent-fg-blue)] hover:underline">清空筛选条件</button>
                  </div>
                </div>
              </section>

              {publicLoading ? <MapSectionLoader text="正在筛选公共版本记录..." /> : null}
              {!publicLoading && publicRecords.length === 0 ? (
                <section className="rounded-xl border border-dashed border-token-subtle px-5 py-10 text-center">
                  <h3 className="text-sm font-medium text-token-primary">还没有符合条件的公共记录</h3>
                  <p className="mt-2 text-sm text-token-muted">可以调整筛选条件，或先从“申领版本号”登记第一条 T 或 V 记录。</p>
                  <button type="button" onClick={() => setView('apply')} className="mt-4 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500">去申领版本号</button>
                </section>
              ) : null}
              {!publicLoading && publicRecords.length > 0 ? (
                <section className="overflow-hidden rounded-xl border border-token-subtle">
                  <div className="border-b border-token-subtle px-4 py-3 text-xs text-token-muted">共显示 {publicRecords.length} 条公开记录</div>
                  <div className="divide-y divide-token-subtle">
                    {publicRecords.map((record) => (
                      <article key={record.id} className="grid gap-2 px-4 py-3 sm:grid-cols-[8rem_minmax(0,1fr)_9rem] sm:items-center">
                        <div><p className="font-mono text-sm font-semibold text-[color:var(--accent-fg-blue)]">{record.code}</p><p className="mt-1 text-xs text-token-muted">{record.kind === 'internal' ? '内部 T' : `正式 V${record.tCode ? ` · ${record.tCode}` : ''}`}</p></div>
                        <div className="min-w-0"><p className="truncate text-sm text-token-primary">{record.planName || '未填写方案名称'}</p><p className="mt-1 truncate text-xs text-token-secondary">{record.systemName || '未归类系统'} / {record.applicationName || '未归类应用'} · {record.ownerName || record.createdByName || '未记录人名'}</p></div>
                        <p className="text-xs text-token-muted sm:text-right">{formatDate(record.plannedReleaseAt || record.plannedProjectAt || record.createdAt)}</p>
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}
            </div>
          ) : null}

          {!loading && view === 'application-records' ? (
            <div className="space-y-5">
              <section className="rounded-xl border border-token-subtle bg-token-nested p-4 sm:p-5">
                <button type="button" onClick={returnToRegistry} className="inline-flex items-center gap-1.5 text-sm font-medium text-[color:var(--accent-fg-blue)] hover:underline">
                  <ArrowLeft className="h-4 w-4" />返回系统与应用
                </button>
                <div className="mt-4">
                  <p className="text-xs text-token-muted">{registryDetailApplication?.systemName || '系统与应用'}</p>
                  <h3 className="mt-1 text-xl font-semibold text-token-primary">{registryDetailApplication?.name || '应用'}的版本记录</h3>
                  <p className="mt-2 text-sm leading-6 text-token-secondary">这里展示该应用的公开 T 与 V 登记明细，历史记录只读，不会被这里的操作改写。</p>
                </div>
              </section>
              {applicationRecordsLoading ? <MapSectionLoader text="正在读取应用的版本记录..." /> : <ApplicationRecordList records={applicationRecords} />}
            </div>
          ) : null}

          {!loading && view === 'registry' ? (
            <div className="space-y-5">
              <section className="rounded-xl border border-token-subtle bg-token-nested p-4 sm:p-5">
                <div className="flex items-start gap-3">
                  <Settings2 className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--accent-fg-blue)]" />
                  <div><h3 className="text-sm font-medium text-token-primary">系统与应用</h3><p className="mt-1 text-xs leading-5 text-token-muted">一个系统可包含多个应用，但同名应用只能归属一个系统。这里的变更只影响后续申请，不会改写任何历史登记。</p></div>
                </div>
                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <div className="rounded-lg border border-token-subtle p-3">
                    <p className="text-sm font-medium text-token-primary">新建系统</p>
                    <div className="mt-3 flex gap-2"><input className={FIELD_CLASS} value={newSystemName} onChange={(event) => setNewSystemName(event.target.value)} placeholder="例如：新的业务系统" /><button type="button" disabled={submitting} onClick={() => void createRegistrySystem()} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-token-subtle px-3 py-2 text-sm text-token-secondary hover-bg-soft disabled:opacity-60">{submitting ? <MapSpinner size={14} /> : <Plus className="h-4 w-4" />}创建</button></div>
                  </div>
                  <div className="rounded-lg border border-token-subtle p-3">
                    <p className="text-sm font-medium text-token-primary">在系统下新建应用</p>
                    <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"><select className={FIELD_CLASS} value={newApplicationSystemId} onChange={(event) => setNewApplicationSystemId(event.target.value)}><option value="">选择系统</option>{registrySystems.map((system) => <option key={system.id} value={system.id}>{system.name}</option>)}</select><input className={FIELD_CLASS} value={newApplicationName} onChange={(event) => setNewApplicationName(event.target.value)} placeholder="例如：新的业务应用" /><button type="button" disabled={submitting} onClick={() => void createRegistryApplication()} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-60">{submitting ? <MapSpinner size={14} /> : <Plus className="h-4 w-4" />}创建</button></div>
                  </div>
                </div>
              </section>

              {registrySystems.length === 0 ? <MapSectionLoader text="正在准备系统和应用目录..." /> : (
                <div className="grid gap-3 md:grid-cols-2">
                  {registrySystems.map((system) => (
                    <section key={system.id} className="rounded-xl border border-token-subtle bg-token-nested p-4">
                      <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium text-token-primary">{system.name}</h3><span className="text-xs text-token-muted">{system.applications.length} 个应用</span></div>
                      {system.applications.length === 0 ? <p className="mt-3 text-xs text-token-muted">还没有应用，可以在上方直接添加。</p> : <div className="mt-3 flex flex-wrap gap-2">{system.applications.map((application) => <button type="button" key={application.id} onClick={() => void openApplicationRecords(application)} aria-label={`查看${application.name}的详细版本记录`} className="group rounded-lg border border-token-subtle px-3 py-2 text-left text-sm text-token-secondary transition-colors hover-bg-soft hover-text-primary focus-visible:border-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"><span className="block font-medium text-token-primary">{application.name}</span><span className="mt-1 inline-flex items-center gap-1 text-xs text-[color:var(--accent-fg-blue)]">查看详细记录 <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" /></span></button>)}</div>}
                    </section>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {!loading && view === 'archive' ? (
            <div className="space-y-6">
              <section className="rounded-xl border border-token-subtle bg-token-nested p-4 sm:p-5">
                <div className="flex items-start gap-3">
                  <FileSpreadsheet className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--accent-fg-blue)]" />
                  <div>
                    <h3 className="text-sm font-medium text-token-primary">导入历史登记表</h3>
                    <p className="mt-1 text-xs leading-5 text-token-muted">支持 CSV、XLS、XLSX。系统保留你上传的原文件、解析后的记录和跳过原因，作为不可变历史快照；不会覆盖已有版本号。</p>
                  </div>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <Field label="导入类型">
                    <select className={FIELD_CLASS} value={historyKind} onChange={(event) => setHistoryKind(event.target.value as ApplyKind)}>
                      <option value="internal">内部版本号 T 历史表</option>
                      <option value="formal">正式版本号 V 历史表</option>
                    </select>
                  </Field>
                  <Field label="本次快照名称">
                    <input className={FIELD_CLASS} value={snapshotName} onChange={(event) => setSnapshotName(event.target.value)} placeholder="例如：2026 年历史 T 登记导入" />
                  </Field>
                </div>
                <input ref={fileRef} type="file" accept=".csv,.xls,.xlsx" className="hidden" onChange={(event) => setHistoryFile(event.target.files?.[0] ?? null)} />
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-2 rounded-lg border border-token-subtle px-3 py-2 text-sm text-token-secondary hover-bg-soft hover-text-primary"><FileUp className="h-4 w-4" />选择历史表</button>
                  <span className="min-w-0 truncate text-xs text-token-muted">{historyFile ? historyFile.name : '尚未选择文件'}</span>
                  <button type="button" disabled={submitting || !historyFile} onClick={() => void importHistory()} className="ml-auto inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60">{submitting ? <MapSpinner size={15} /> : <Archive className="h-4 w-4" />}导入并存档</button>
                </div>
              </section>

              <section className="rounded-xl border border-token-subtle bg-token-nested p-4 sm:p-5">
                <div className="flex items-start gap-3">
                  <History className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--accent-fg-blue)]" />
                  <div>
                    <h3 className="text-sm font-medium text-token-primary">保存当前登记快照</h3>
                    <p className="mt-1 text-xs leading-5 text-token-muted">把当前可见的登记数据固化为一个版本，便于日后对账。当前只保存，不提供覆盖或恢复操作。</p>
                  </div>
                </div>
                <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                  <input className={FIELD_CLASS} value={snapshotName} onChange={(event) => setSnapshotName(event.target.value)} placeholder="例如：上线前登记基线" />
                  <button type="button" disabled={submitting} onClick={() => void saveCurrentSnapshot()} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-token-subtle px-3 py-2 text-sm text-token-secondary hover-bg-soft hover-text-primary disabled:opacity-60"><CheckCircle2 className="h-4 w-4" />保存当前快照</button>
                </div>
              </section>

              <section>
                <h3 className="text-sm font-medium text-token-primary">已保存快照</h3>
                {snapshots.length === 0 ? <p className="mt-3 text-sm text-token-muted">还没有历史导入或当前登记快照。</p> : (
                  <div className="mt-3 space-y-2">
                    {snapshots.map((snapshot) => (
                      <div key={snapshot.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-token-subtle bg-token-nested px-3 py-3">
                        <div className="min-w-0"><p className="truncate text-sm text-token-primary">{snapshot.name}</p><p className="mt-1 text-xs text-token-muted">{snapshot.sourceType === 'history_import' ? `历史导入${snapshot.sourceFileName ? ` · ${snapshot.sourceFileName}` : ''}` : '当前登记快照'} · {formatDate(snapshot.createdAt)}</p></div>
                        <div className="text-right text-xs text-token-secondary"><p>{snapshot.recordCount} 条记录</p>{snapshot.sourceType === 'history_import' ? <p className="mt-1 text-token-muted">新增 {snapshot.importedCount}，跳过 {snapshot.skippedCount}</p> : null}</div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          ) : null}
        </main>
      </section>
    </div>
  );

  return createPortal(modal, document.body);
}
