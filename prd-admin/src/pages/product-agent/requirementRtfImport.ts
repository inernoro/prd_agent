export interface RtfImportImage {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface RtfImportComment {
  author: string;
  title: string;
  content: string;
  createdAt?: string;
}

export interface RtfImportRequirement {
  externalId: string;
  title: string;
  description: string;
  grade: 'p0' | 'p1' | 'p2' | 'p3';
  sourceStatus: string;
  sourcePriority: string;
  fields: Record<string, string>;
  handlerNames: string[];
  developerNames: string[];
  creatorNames: string[];
  ccNames: string[];
  comments: RtfImportComment[];
  sourceCreatedAt?: string;
  sourceModifiedAt?: string;
  sourceCompletedAt?: string;
  images: RtfImportImage[];
}

interface RtfState {
  skip: boolean;
  unicodeFallbackLength: number;
  binaryLength: number;
}

const SKIPPED_DESTINATIONS = new Set([
  'colortbl',
  'colorschememapping',
  'datastore',
  'footer',
  'fonttbl',
  'generator',
  'header',
  'info',
  'listoverridetable',
  'listtable',
  'object',
  'pict',
  'rsidtbl',
  'stylesheet',
  'themedata',
]);

const IMAGE_MARKER = (index: number) => `[[IMPORT_IMAGE_${index}]]`;
const LEGACY_IMAGE_MARKER = (index: number) => `[[TAPD_IMAGE_${index}]]`;

function findGroupStart(input: string, controlIndex: number): number {
  for (let index = controlIndex; index >= 0; index -= 1) {
    if (input[index] === '{') return index;
  }
  return -1;
}

function findGroupEnd(input: string, start: number): number {
  let depth = 0;
  for (let index = start; index < input.length; index += 1) {
    if (input[index] === '{') depth += 1;
    else if (input[index] === '}' && --depth === 0) return index + 1;
  }
  return input.length;
}

function extractImages(input: string): { rtf: string; images: RtfImportImage[] } {
  const groups: { start: number; end: number; replacement: string }[] = [];
  const images: RtfImportImage[] = [];
  let cursor = 0;

  while (cursor < input.length) {
    const controlIndex = input.indexOf('\\pict', cursor);
    if (controlIndex < 0) break;
    const start = findGroupStart(input, controlIndex);
    if (start < 0) break;
    const end = findGroupEnd(input, start);
    const group = input.slice(start, end);
    const mimeType = group.includes('\\pngblip')
      ? 'image/png'
      : group.includes('\\jpegblip')
        ? 'image/jpeg'
        : '';
    const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : '';

    if (mimeType && extension) {
      const hexStart = group.search(/[0-9a-fA-F]{40}/);
      const hex = hexStart >= 0 ? (group.slice(hexStart).match(/[0-9a-fA-F]/g) ?? []).join('') : '';
      const evenHex = hex.length % 2 === 0 ? hex : hex.slice(0, -1);
      const bytes = new Uint8Array(evenHex.length / 2);
      for (let index = 0; index < evenHex.length; index += 2) {
        bytes[index / 2] = Number.parseInt(evenHex.slice(index, index + 2), 16);
      }
      const imageIndex = images.length;
      images.push({
        fileName: `import-${imageIndex + 1}.${extension}`,
        mimeType,
        bytes,
      });
      groups.push({ start, end, replacement: IMAGE_MARKER(imageIndex) });
    } else {
      groups.push({ start, end, replacement: '' });
    }
    cursor = end;
  }

  let replaced = input;
  for (const group of groups.reverse()) {
    replaced = `${replaced.slice(0, group.start)}${group.replacement}${replaced.slice(group.end)}`;
  }
  return { rtf: replaced, images };
}

function decodeHexByte(hex: string): string {
  const byte = Number.parseInt(hex, 16);
  return new TextDecoder('windows-1252').decode(Uint8Array.of(byte));
}

function decodeRtf(input: string): string {
  let output = '';
  const stack: RtfState[] = [];
  let state: RtfState = { skip: false, unicodeFallbackLength: 1, binaryLength: 0 };

  for (let index = 0; index < input.length;) {
    const char = input[index];

    if (state.binaryLength > 0) {
      index += state.binaryLength;
      state.binaryLength = 0;
      continue;
    }
    if (char === '{') {
      stack.push({ ...state });
      index += 1;
      continue;
    }
    if (char === '}') {
      state = stack.pop() ?? state;
      index += 1;
      continue;
    }
    if (char !== '\\') {
      if (!state.skip && char !== '\r' && char !== '\n') output += char;
      index += 1;
      continue;
    }

    index += 1;
    const escaped = input[index];
    if (escaped === '\\' || escaped === '{' || escaped === '}') {
      if (!state.skip) output += escaped;
      index += 1;
      continue;
    }
    if (escaped === '*') {
      state.skip = true;
      index += 1;
      continue;
    }
    if (escaped === "'") {
      if (!state.skip) output += decodeHexByte(input.slice(index + 1, index + 3));
      index += 3;
      continue;
    }

    const match = input.slice(index).match(/^([a-zA-Z]+)(-?\d+)? ?/);
    if (!match) {
      index += 1;
      continue;
    }
    const word = match[1];
    const parameter = match[2] === undefined ? null : Number(match[2]);
    index += match[0].length;

    if (SKIPPED_DESTINATIONS.has(word)) {
      state.skip = true;
      continue;
    }
    if (state.skip) continue;
    if (word === 'uc' && parameter !== null) {
      state.unicodeFallbackLength = parameter;
      continue;
    }
    if (word === 'u' && parameter !== null) {
      output += String.fromCharCode(parameter < 0 ? parameter + 65536 : parameter);
      let skipped = 0;
      while (skipped < state.unicodeFallbackLength && index < input.length) {
        index += input[index] === '\\' && input[index + 1] === "'" ? 4 : 1;
        skipped += 1;
      }
      continue;
    }
    if (word === 'bin' && parameter !== null) {
      state.binaryLength = parameter;
      continue;
    }
    if (word === 'par' || word === 'line') output += '\n';
    else if (word === 'tab') output += '\t';
    else if (word === 'cell') output += '\u001f';
    else if (word === 'row') output += '\u001e';
    else if (word === 'emdash') output += '—';
    else if (word === 'endash') output += '–';
    else if (word === 'bullet') output += '•';
    else if (word === 'lquote' || word === 'rquote') output += "'";
    else if (word === 'ldblquote' || word === 'rdblquote') output += '"';
  }
  return output;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function descriptionToHtml(value: string): string {
  return value
    .split(/\n+/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      const marker = trimmed.match(/^\[\[(?:IMPORT_IMAGE|TAPD_IMAGE)_(\d+)]]$/);
      if (marker) return `<p data-import-image="${marker[1]}"></p>`;
      if (/^\d+[、.]/.test(trimmed)) return `<h3>${escapeHtml(trimmed)}</h3>`;
      return `<p>${escapeHtml(trimmed)}</p>`;
    })
    .filter(Boolean)
    .join('');
}

function splitNames(value?: string): string[] {
  return (value ?? '')
    .split(/[;；,，]/)
    .map((name) => name.trim())
    .filter(Boolean);
}

function mapPriorityToGrade(priority: string): 'p0' | 'p1' | 'p2' | 'p3' {
  const normalized = priority.trim().toLowerCase();
  if (normalized.includes('urgent') || normalized.includes('紧急') || normalized.includes('highest')) return 'p0';
  if (normalized.includes('high') || normalized.includes('重要')) return 'p1';
  if (normalized.includes('low') || normalized.includes('较低')) return 'p3';
  return 'p2';
}

function parseComment(value: string): RtfImportComment | null {
  const lines = value.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || !lines[0].startsWith('【评论:')) return null;
  const header = lines[0].match(/^【评论:([^\s]+)\s+(.+?)(?:\s+\(([^)]+)\))?】$/);
  return {
    author: header?.[1] ?? '',
    title: header?.[2] ?? lines[0].replace(/^【|】$/g, ''),
    createdAt: header?.[3],
    content: lines.slice(1).join('\n'),
  };
}

/** 解析需求导出 RTF（表格字段 + 评论 + 内嵌图片）。 */
export function parseRequirementRtfBytes(bytes: ArrayBuffer | Uint8Array, fileName = 'requirement-export.rtf'): RtfImportRequirement {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const raw = new TextDecoder('windows-1252').decode(data);
  if (!raw.trimStart().startsWith('{\\rtf')) throw new Error(`${fileName} 不是有效的 RTF 文件`);

  const extracted = extractImages(raw);
  const rows = decodeRtf(extracted.rtf)
    .split('\u001e')
    .map((row) => row.split('\u001f').map((cell) => cell.trim()))
    .filter((row) => row.some(Boolean));
  if (rows.length < 3) throw new Error(`${fileName} 没有识别到需求表格`);

  const fields: Record<string, string> = {};
  const fullWidthValues: string[] = [];
  let title = '';

  for (const row of rows) {
    const values = row.filter((cell, index) => cell || index < row.length - 1);
    if (values[0]?.trim() === 'ID' && values.length >= 2) {
      fields.ID = values[1]?.trim() ?? '';
      continue;
    }
    if (values.length >= 4) {
      for (let index = 0; index + 1 < values.length; index += 2) {
        const label = values[index]?.trim();
        if (label) fields[label] = values[index + 1]?.trim() ?? '';
      }
      continue;
    }
    const value = values.find(Boolean)?.trim() ?? '';
    if (!value) continue;
    if (!title && fields.ID && !value.startsWith('【评论:')) title = value;
    else fullWidthValues.push(value);
  }

  const descriptionText = fullWidthValues
    .filter((value) => !value.startsWith('【评论:'))
    .sort((a, b) => b.length - a.length)[0] ?? '';
  const comments = fullWidthValues
    .map(parseComment)
    .filter((comment): comment is RtfImportComment => comment !== null);
  if (!fields.ID || !title) throw new Error(`${fileName} 缺少需求 ID 或标题`);

  return {
    externalId: fields.ID,
    title,
    description: descriptionToHtml(descriptionText),
    grade: mapPriorityToGrade(fields.优先级 ?? ''),
    sourceStatus: fields.状态 ?? '',
    sourcePriority: fields.优先级 ?? '',
    fields,
    handlerNames: splitNames(fields.处理人),
    developerNames: splitNames(fields.开发人员),
    creatorNames: splitNames(fields.创建人),
    ccNames: splitNames(fields.抄送人),
    comments,
    sourceCreatedAt: fields.创建时间 || undefined,
    sourceModifiedAt: fields.最后修改时间 || undefined,
    sourceCompletedAt: fields.完成时间 || undefined,
    images: extracted.images,
  };
}

export function replaceImportImageMarkers(
  html: string,
  uploadedImages: { index: number; url: string; fileName: string }[],
): string {
  let result = html;
  for (const image of uploadedImages) {
    const markers = [
      `<p data-import-image="${image.index}"></p>`,
      `<p data-tapd-image="${image.index}"></p>`,
    ];
    const replacement = `<p><img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.fileName)}" style="max-width:100%;border-radius:8px;margin:8px 0;" /></p>`;
    for (const marker of markers) {
      result = result.replace(marker, replacement);
    }
  }
  return result;
}
