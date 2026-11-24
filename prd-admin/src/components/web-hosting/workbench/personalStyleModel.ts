import type { HostedSite } from '@/services/real/webPages';
import type {
  PersonalStyle,
  PersonalStyleDraft,
  PersonalStyleField,
  PersonalStyleInput,
} from '@/services/real/personalStyles';

/**
 * 「我的风格」的纯逻辑：表单、校验、「系统填写」标记、可选的网页。组件只管渲染，判断都在这里，方便单测。
 * 校验口径与后端 PersonalDesignStyleService 一致（后端仍是最终判据，这里只是提前告诉用户）。
 */

export const PERSONAL_NAME_MAX = 40;
export const PERSONAL_INSTRUCTION_MAX = 1500;
export const PERSONAL_NOTE_MAX = 500;

const HEX = /^#[0-9a-f]{6}$/i;

export interface PersonalStyleForm {
  name: string;
  instruction: string;
  /** [正文, 底色, 强调色]；空数组表示不带色块。 */
  swatches: string[];
  /** 逗号分隔的字体名，保存时拆开。 */
  fontsText: string;
  baseDesignSystemId: string;
}

export function formFromDraft(draft: PersonalStyleDraft): PersonalStyleForm {
  return {
    name: draft.name,
    instruction: draft.instruction,
    swatches: [...draft.swatches],
    fontsText: draft.fonts.join('，'),
    baseDesignSystemId: draft.baseDesignSystemId,
  };
}

export function formFromStyle(style: PersonalStyle): PersonalStyleForm {
  return {
    name: style.name,
    instruction: style.instruction,
    swatches: [...style.swatches],
    fontsText: style.fonts.join('，'),
    baseDesignSystemId: style.baseDesignSystemId,
  };
}

export function parseFonts(text: string): string[] {
  return Array.from(new Set(text.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean)));
}

function fieldValue(form: PersonalStyleForm, field: PersonalStyleField): string {
  switch (field) {
    case 'name': return form.name.trim();
    case 'instruction': return form.instruction.trim();
    case 'swatches': return form.swatches.map((color) => color.toLowerCase()).join(',');
    case 'fonts': return parseFonts(form.fontsText).join(',');
    case 'baseDesignSystemId': return form.baseDesignSystemId;
  }
}

/**
 * 系统填的字段里，用户还没改过的那些。改过一个字就不再算系统填的——界面上的「系统填写」标记随之消失，
 * 保存时也只把这些报给后端。
 */
export function systemFilledFields(draft: PersonalStyleDraft, form: PersonalStyleForm): PersonalStyleField[] {
  const original = formFromDraft(draft);
  return draft.systemFilledFields.filter((field) => fieldValue(original, field) === fieldValue(form, field));
}

/** 表单能不能保存；能返回 null，不能返回一句要改什么。 */
export function validatePersonalStyleForm(form: PersonalStyleForm): string | null {
  const name = form.name.trim();
  if (!name) return '给这套风格起个名字';
  if (name.length > PERSONAL_NAME_MAX) return `名称不超过 ${PERSONAL_NAME_MAX} 个字`;
  if (/[<>"\n\r\t]/.test(name)) return '名称里不能有尖括号、双引号或换行';
  const instruction = form.instruction.trim();
  if (!instruction) return '风格说明不能为空：至少写一句想要的配色、字体或版式';
  if (instruction.length > PERSONAL_INSTRUCTION_MAX) return `风格说明不超过 ${PERSONAL_INSTRUCTION_MAX} 个字`;
  if (form.swatches.length !== 0 && (form.swatches.length !== 3 || form.swatches.some((color) => !HEX.test(color)))) {
    return '色块要么不带，要么是三枚 #rrggbb 颜色';
  }
  const fonts = parseFonts(form.fontsText);
  if (fonts.length > 4 || fonts.some((font) => font.length > 60)) return '字体最多 4 个，每个不超过 60 个字';
  if (!form.baseDesignSystemId) return '选一个设计系统骨架';
  return null;
}

/** 新建时提交的整份内容。 */
export function createInput(draft: PersonalStyleDraft, form: PersonalStyleForm): PersonalStyleInput {
  return {
    name: form.name.trim(),
    instruction: form.instruction.trim(),
    swatches: form.swatches.map((color) => color.toLowerCase()),
    fonts: parseFonts(form.fontsText),
    baseDesignSystemId: form.baseDesignSystemId,
    sourceSiteId: draft.sourceSiteId,
    sourceSiteTitle: draft.sourceSiteTitle,
    sourceNote: draft.sourceNote,
    systemFilledFields: systemFilledFields(draft, form),
  };
}

/** 修改时只提交改过的字段；什么都没改返回 null。 */
export function updateInput(style: PersonalStyle, form: PersonalStyleForm): PersonalStyleInput | null {
  const original = formFromStyle(style);
  const patch: PersonalStyleInput = {};
  if (fieldValue(original, 'name') !== fieldValue(form, 'name')) patch.name = form.name.trim();
  if (fieldValue(original, 'instruction') !== fieldValue(form, 'instruction')) patch.instruction = form.instruction.trim();
  if (fieldValue(original, 'swatches') !== fieldValue(form, 'swatches')) patch.swatches = form.swatches.map((color) => color.toLowerCase());
  if (fieldValue(original, 'fonts') !== fieldValue(form, 'fonts')) patch.fonts = parseFonts(form.fontsText);
  if (fieldValue(original, 'baseDesignSystemId') !== fieldValue(form, 'baseDesignSystemId')) patch.baseDesignSystemId = form.baseDesignSystemId;
  return Object.keys(patch).length > 0 ? patch : null;
}

/** 可以拿来提取风格的网页：自己的、入口是 HTML、不是 PDF / 视频包装站。 */
export function derivableSites(sites: HostedSite[], currentUserId: string | null | undefined): HostedSite[] {
  return sites.filter((site) =>
    (!currentUserId || site.ownerUserId === currentUserId)
    && /\.html?$/i.test(site.entryFile || '')
    && (!site.wrappedAssetType || site.wrappedAssetType === 'markdown'));
}

/** 提取按钮能不能点：选了网页或写了描述，至少一样。 */
export function deriveBlocker(siteId: string | null, note: string): string | null {
  if (note.trim().length > PERSONAL_NOTE_MAX) return `描述不超过 ${PERSONAL_NOTE_MAX} 个字`;
  if (!siteId && !note.trim()) return '选一张你自己的网页，或写几句想要的风格';
  return null;
}

/** 还能不能新建；不能时给一句原因。 */
export function createBlocker(count: number, limit: number): string | null {
  return count >= limit ? `已经有 ${count} 套，最多 ${limit} 套，先删掉一套不用的` : null;
}

/** 「我的风格」网页选择器的分页状态：按页读、可搜索、可继续往下加载。 */
export type SitePickerState =
  | { status: 'loading' }
  | { status: 'ready'; query: string; items: HostedSite[]; scanned: number; total: number; loadingMore: boolean }
  | { status: 'failed'; message: string };

type SitePageResponse =
  | { success: true; data: { items: HostedSite[]; total: number } }
  | { success: false; error?: { message?: string } | null };

/** 第一页（或换了搜索词之后的第一页）回来：整页替换。 */
export function firstSitePage(query: string, res: SitePageResponse, userId: string | null | undefined): SitePickerState {
  if (!res.success) return { status: 'failed', message: res.error?.message || '你的网页列表没有读出来，可以先只写描述' };
  return {
    status: 'ready',
    query,
    items: derivableSites(res.data.items, userId),
    scanned: res.data.items.length,
    total: res.data.total,
    loadingMore: false,
  };
}

/**
 * 「继续加载」的响应回来：只认发出它的那次请求（同一搜索词、同一起点），否则原样丢弃——
 * 迟到的响应不许把别的查询结果混进当前列表。失败只收起加载态，不丢已有列表。
 */
export function appendSitePage(
  current: SitePickerState,
  request: { query: string; skip: number },
  res: SitePageResponse,
  userId: string | null | undefined,
): SitePickerState {
  if (current.status !== 'ready' || current.scanned !== request.skip || current.query !== request.query) return current;
  if (!res.success) return { ...current, loadingMore: false };
  const known = new Set(current.items.map((item) => item.id));
  const more = derivableSites(res.data.items, userId).filter((item) => !known.has(item.id));
  return {
    status: 'ready',
    query: request.query,
    items: [...current.items, ...more],
    scanned: current.scanned + res.data.items.length,
    total: res.data.total,
    loadingMore: false,
  };
}

/** 还有没有没看过的网页。 */
export function hasMoreSitePages(state: SitePickerState): boolean {
  return state.status === 'ready' && state.scanned < state.total;
}

