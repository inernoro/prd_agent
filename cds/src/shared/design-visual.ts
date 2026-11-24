import { designDatasetRequired, designSlots, designViewports, type DesignCaptureProvenance, type DesignCell, type DesignRun, type DesignScreen, type DesignSlot, type DesignTheme, type DesignVersion } from './design-workspace.js';

export const designVisualStandard = [
  ['V-01', '位置', '对图', '逐个指出页头、标签、主体、浮层、底部。位置保持一致，有调整时引用依据。'],
  ['V-02', '对齐', '测量', '记录同一行控件的顶边、底边及高度，误差 ≤ 1 px。'],
  ['V-03', '遮挡与裁切', '测量 + 对图', '浮层与内容不重叠，中文词不被截断。'],
  ['V-04', '溢出与滚动', '测量', '文档宽度不超出视口，只有主内容区滚动。'],
  ['V-05', '原样内容', '文本扫描', '检查误露出的 Markdown、JSON、内部编号和凭据串。'],
  ['V-06', '一种写法', '文本比对', '同一页的徽标和列表计数一致，同类入口用词一致。'],
  ['V-07', '深色', '对图 + 测量', '对照深色实拍，正文对比度 ≥ 4.5，检查色块和图片。'],
  ['V-08', '视口', '对图', '对照手机 375 px 和 Windows 125%、150% 的实拍。'],
  ['V-09', '状态', '对图', '稿件声明的空、加载、出错、已过期、无权限状态逐个有实拍。'],
  ['V-10', '数据规模', '对图', '用长标题、几十条和真实规模的数据检查裁切、溢出和页面长度。'],
] as const;
export type DesignVisualCheckId = typeof designVisualStandard[number][0];
export type DesignVisualCheck = { status: 'passed' | 'failed' | 'missing'; evidence: string };
export type DesignVisualChecks = Partial<Record<DesignVisualCheckId, DesignVisualCheck>>;
export type DesignVisualRow = DesignCaptureProvenance & {
  imageId?: string; referenceImageId?: string; measured?: DesignCell['measured'];
  checks: DesignVisualChecks; by: string; at: string;
};
export type DesignVisualStatus = 'passed' | 'failed' | 'missing' | 'no_image' | 'no_reference' | 'unverified';

const visualStandardPath = '设计文档/视觉验收标准.md';

export function designVisualRequired(version: DesignVersion, run?: DesignRun) {
  return run?.visual !== undefined || version.delivery?.files.some(file => file.path === visualStandardPath) === true;
}

export function visualSlotTheme(slot: DesignSlot): DesignTheme {
  return slot.endsWith('-dark') ? 'dark' : 'light';
}

export function designVisualSlots(screen: DesignScreen) {
  return designSlots.filter(slot => slot === `${screen.viewport}-${visualSlotTheme(slot)}` && screen.themes.includes(visualSlotTheme(slot)));
}

export function designVisualKey(screenId: string, slot: DesignSlot) {
  return `${screenId}/${slot}` as const;
}

export function designVisualReference(version: DesignVersion, screenId: string, slot: DesignSlot, row?: DesignVisualRow) {
  return row?.referenceImageId ?? version.renders?.[screenId]?.[visualSlotTheme(slot)]?.id;
}

export function designProgramStatus(version: DesignVersion, run?: DesignRun) {
  const keys = version.screens.flatMap(screen => designVisualSlots(screen).map(slot => designVisualKey(screen.id, slot)));
  const proofs = keys.flatMap(key => {
    const proof = run?.programEvidence?.[key];
    return proof ? [proof] : [];
  });
  const fixtures = new Set(proofs.map(proof => proof.fixtureDigest));
  const provenanceMatches = (value?: DesignCaptureProvenance) => Boolean(version.demoData
    && value?.dataset === version.demoData.sha256 && value.commit === run?.commit && value.capturedBy === 'cds');
  const invalidProvenance = designDatasetRequired(version) && (
    keys.some(key => run?.programEvidence?.[key] && (!provenanceMatches(run.programEvidence[key]) || !provenanceMatches(run.visual?.[key])))
    || run?.cells.some(cell => (cell.imageId || cell.status === 'passed' || cell.status === 'failed') && !provenanceMatches(cell)));
  const invalid = Boolean(invalidProvenance) || fixtures.size > 1 || proofs.some(proof => proof.commit !== run?.commit || proof.review?.matched === false);
  const reviewed = proofs.filter(proof => proof.review?.matched && proof.review.by !== proof.by
    && proof.review.digest === proof.digest && proof.review.fixtureDigest === proof.fixtureDigest).length;
  return { total: keys.length, captured: proofs.length, reviewed, invalid, invalidProvenance: Boolean(invalidProvenance) };
}

export function designVisualRuleShot(version: DesignVersion, screen: DesignScreen, slot: DesignSlot, run?: DesignRun) {
  if (!run || !screen.impl) return undefined;
  const { width, height } = designViewports[screen.viewport];
  const rules = new Set(version.acceptance.filter(rule => rule.screenId === screen.id && rule.slots.includes(slot)).map(rule => rule.id));
  return run.cells.find(cell => rules.has(cell.itemId) && cell.slot === slot && cell.imageId && cell.measured?.path === screen.impl
    && cell.measured.width === width && cell.measured.height === height && cell.measured.theme === visualSlotTheme(slot));
}

export function concreteVisualEvidence(id: DesignVisualCheckId, evidence: string): boolean {
  const words = evidence.trim();
  if (words.length < 6 || /^(全部通过|没有问题|看起来没问题|看起来一致|一致|无差异|未见异常|through|passed|looks good)[。.!\s]*$/i.test(words)) return false;
  if (id === 'V-01') return ['页头', '标签', '主体', '浮层', '底部'].every(region => words.includes(region));
  if (id === 'V-02' || id === 'V-03' || id === 'V-04') return /[0-9]/.test(words);
  return true;
}

export function designVisualCheckStatus(id: DesignVisualCheckId, check?: DesignVisualCheck) {
  if (!check || check.status === 'missing' || !concreteVisualEvidence(id, check.evidence)) return 'missing';
  return check.status;
}

export function designVisualStatus(version: DesignVersion, screen: DesignScreen, slot: DesignSlot, run?: DesignRun): DesignVisualStatus {
  if (!run) return 'unverified';
  const row = run.visual?.[designVisualKey(screen.id, slot)];
  const statuses = designVisualStandard.map(([id]) => designVisualCheckStatus(id, row?.checks[id]));
  if (statuses.includes('failed')) return 'failed';
  if (!row?.imageId) return 'no_image';
  if (!designVisualReference(version, screen.id, slot, row)) return 'no_reference';
  return statuses.includes('missing') ? 'missing' : 'passed';
}

export function designVisualSummary(version: DesignVersion, run?: DesignRun) {
  const statuses = version.screens.flatMap(screen => designVisualSlots(screen).map(slot => designVisualStatus(version, screen, slot, run)));
  return { total: statuses.length, failed: statuses.filter(status => status === 'failed').length,
    remaining: statuses.filter(status => status !== 'passed').length };
}
