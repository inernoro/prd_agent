import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fromBuffer, type Entry, type ZipFile } from 'yauzl';
import { crc32 } from '../utils/zip.js';
import { designSlots, designViewports, type DesignDeliveryFile, type DesignMaterial, type DesignRule, type DesignScreen, type DesignTheme } from '../shared/design-workspace.js';
import { planningText, rejectPlanning } from './engineering-planning-input.js';

const mib = 1024 * 1024;
export const designPackageLimit = 4 * mib;
export const invalidDesign = (message: string): never => rejectPlanning(400, 'invalid_design', message);
export const designDigest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true });
const git = promisify(execFile);

export function designRecord(value: unknown, name: string, allowed?: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidDesign(`${name} 须为对象`);
  const input = value as Record<string, unknown>;
  if (allowed && Object.keys(input).some(key => !allowed.includes(key))) invalidDesign(`${name} 包含不支持的字段`);
  return input;
}

export function designId(value: unknown, name: string): string {
  const id = planningText(value, name, 120);
  if (!/^[A-Za-z0-9_.-]+$/.test(id) || id === '.' || id === '..' || Object.hasOwn(Object.prototype, id)) invalidDesign(`${name} 不是有效编号`);
  return id;
}

export function designCommit(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(value)) return invalidDesign('请提供完整的 Git 提交 SHA');
  return value.toLowerCase();
}

function relativeFile(value: unknown): string {
  const file = planningText(value, '稿件包路径', 400);
  if (/^[a-z]:|[\\:\u0000-\u001f]/i.test(file) || file.split('/').some(part => part === '' || part === '.' || part === '..')) {
    invalidDesign('稿件包包含无效相对路径');
  }
  return file;
}

export function designSourcePath(value: unknown) {
  return value === '.' ? value : relativeFile(value);
}

export async function readDesignSourceZip(repoRoot: string, commit: string, sourcePath: string) {
  try {
    const settings = { encoding: 'buffer' as const, timeout: 6000, maxBuffer: designPackageLimit };
    const identity = await git('git', ['--no-replace-objects', '-C', repoRoot, 'cat-file', '-t', commit], settings);
    if (identity.stdout.toString().trim() !== 'commit') return undefined;
    const tree = sourcePath === '.' ? commit : `${commit}:${sourcePath}`;
    const archive = await git('git', ['--no-replace-objects', '-C', repoRoot, 'archive', '--format=zip', tree], settings);
    return archive.stdout;
  } catch { return undefined; }
}

export function localDesignPath(value: unknown): string {
  const route = planningText(value, '画面路径', 1200);
  if (!route.startsWith('/') || /^\/\//.test(route) || /[\\\s]|%(?:2f|5c|2e|0[0-9a-f]|1[0-9a-f]|25)/i.test(route)
    || route.split(/[?#]/, 1)[0].split('/').some(part => part === '.' || part === '..')) invalidDesign('画面须使用预览内的本地路径');
  return route;
}

export function designPngDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 57 || bytes.length > 1.5 * mib || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return undefined;
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width < 1 || width > 8192 || height < 1 || height > 8192 || width * height > 12_000_000) return undefined;
  let hasPixels = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset), end = offset + length + 12;
    if (end > bytes.length || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return undefined;
    const name = bytes.toString('ascii', offset + 4, offset + 8);
    if (name === 'IDAT') hasPixels ||= length > 0;
    if (name === 'IEND') return hasPixels && length === 0 && end === bytes.length ? { width, height } : undefined;
    offset = end;
  }
  return undefined;
}

async function zipEntries(bytes: Buffer, onlyPath?: string): Promise<Map<string, Buffer>> {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > designPackageLimit) invalidDesign('稿件包须是 4 MiB 以内的 ZIP');
  const zip = await new Promise<ZipFile>((resolve, reject) => fromBuffer(bytes, {
    lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: false,
  }, (error, file) => error || !file ? reject(error) : resolve(file)));
  const entries = new Map<string, Buffer>();
  const paths = new Set<string>();
  let expanded = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry: Entry) => {
        void (async () => {
          const directory = entry.fileName.endsWith('/');
          const name = relativeFile(directory ? entry.fileName.slice(0, -1) : entry.fileName);
          const type = (entry.externalFileAttributes >>> 16) & 0xf000;
          expanded += entry.uncompressedSize;
          if (paths.has(name) || paths.size >= 600 || expanded > 12 * mib || entry.uncompressedSize > 4 * mib
            || entry.isEncrypted() || (type !== 0 && type !== (directory ? 0x4000 : 0x8000))) invalidDesign('稿件包含不支持的文件，或超过文件数与解压限制');
          paths.add(name);
          if (!directory && (onlyPath === undefined || name === onlyPath)) {
            const stream = await new Promise<NodeJS.ReadableStream>((ok, fail) => zip.openReadStream(entry,
              (error, value) => error || !value ? fail(error) : ok(value)));
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of stream) {
              const buffer = Buffer.from(chunk);
              size += buffer.length;
              if (size > entry.uncompressedSize) invalidDesign('稿件包的解压内容超限');
              chunks.push(buffer);
            }
            const content = Buffer.concat(chunks, size);
            if (size !== entry.uncompressedSize || crc32(content) !== entry.crc32) invalidDesign('稿件包内容校验失败');
            entries.set(name, content);
          }
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
  return entries;
}

export async function readArchivedDesignFile(bytes: Buffer, filename: string): Promise<Buffer | undefined> {
  return (await zipEntries(bytes, filename)).get(filename);
}

export async function readDesignFrameworkSource(bytes: Buffer): Promise<DesignMaterial> {
  const files = await zipEntries(bytes);
  const text = (name: string) => {
    const content = files.get(name);
    return content?.length ? decoder.decode(content).replace(/\r\n/g, '\n').trim() : undefined;
  };
  const colors = text('tokens.json');
  return { tokens: colors ? designRecord(JSON.parse(colors), 'Git 框架令牌') : undefined,
    rules: text('rules.md'), components: text('components.md'), skeleton: text('skeleton.html') };
}

function list<T>(value: unknown, label: string, max: number, parse: (item: unknown) => T, optional = false): T[] {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value) || value.length > max) return invalidDesign(`${label} 须为列表且最多 ${max} 项`);
  return value.map(parse);
}

function unique<T>(rows: T[], id: (row: T) => string, name: string) {
  if (new Set(rows.map(id)).size !== rows.length) invalidDesign(`${name} 编号重复`);
  return rows;
}

function screen(value: unknown): DesignScreen {
  const input = designRecord(value, '画面');
  const name = planningText(input.name, '画面名称', 120);
  const rawRoute = planningText(input.route, '画面路由', 1200);
  const route = rawRoute.startsWith('#') ? rawRoute : localDesignPath(rawRoute);
  const viewport = input.viewport;
  if (viewport !== 'desktop' && viewport !== 'phone') return invalidDesign('画面视口须是 desktop 或 phone');
  const themes = unique(list(input.themes ?? ['light', 'dark'], '主题', 2, (theme): DesignTheme => {
    if (theme === 'light' || theme === 'dark') return theme;
    return invalidDesign('画面主题须是 light 或 dark');
  }), item => item, '主题');
  if (!themes.length) invalidDesign('每个画面至少须有一个主题');
  return { id: designId(input.id, '画面编号'), name, route, viewport, themes,
    impl: input.impl == null ? null : localDesignPath(input.impl),
    ...(input.readySelector === undefined ? {} : { readySelector: planningText(input.readySelector, '画面就绪选择器', 300) }) };
}

function rule(value: unknown, screens: DesignScreen[]): DesignRule {
  const input = designRecord(value, '验收项');
  const how = input.how;
  if (how !== 'measure' && how !== 'screenshot' && how !== 'human') return invalidDesign('验收项须声明测量、截图或人工核对');
  const priority = input.priority ?? 'normal';
  if (priority !== 'normal' && priority !== 'high') return invalidDesign('验收级别须是 normal 或 high');
  const screenId = input.screenId === undefined ? undefined : designId(input.screenId, '验收画面');
  const target = screens.find(item => item.id === screenId);
  if (screenId && !target) invalidDesign('验收项引用了不存在的画面');
  const slots = unique(list(input.slots ?? designSlots, '适用视口和主题', 4, slot =>
    designSlots.find(id => id === slot) ?? invalidDesign('不支持的验收视口和主题')), item => item, '验收视口和主题');
  if (!slots.length) invalidDesign('验收项至少适用一个视口和主题');
  let probe: DesignRule['probe'];
  if (input.probe !== undefined) {
    const method = designRecord(input.probe, '测量方法', ['type', 'tolerance']);
    if (how !== 'measure' || method.type !== 'horizontal-overflow' || (method.tolerance !== undefined
      && (typeof method.tolerance !== 'number' || !Number.isInteger(method.tolerance) || method.tolerance < 0 || method.tolerance > 16))) {
      return invalidDesign('测量方法或容差无效');
    }
    probe = { type: method.type, tolerance: method.tolerance as number | undefined };
  }
  return { id: designId(input.id, '验收编号'), rule: planningText(input.rule, '验收规则', 600), how, priority, slots,
    screenId, probe, expected: input.expected === undefined ? undefined : planningText(input.expected, '验收期望', 800) };
}

const deliveryText = /\.(?:md|mdx|txt|json|ya?ml|html?|css|[cm]?js|ts|tsx|jsx|csv|toml|xml|svg)$/i;

function describeDesignDelivery(entries: Map<string, Buffer>, root: string, input: Record<string, unknown>,
  prototype: string, rationale: string, checks: string, rendered: ReadonlySet<string>) {
  const files = new Map([...entries].map(([name, content]) => [name.slice(root.length), content]));
  const warnings: string[] = [];
  function location(value: unknown, label: string, directory = false) {
    if (value === undefined || value === null) return undefined;
    try {
      const name = relativeFile(typeof value === 'string' && directory ? value.replace(/\/+$/, '') : value);
      if (!files.has(name) && !(directory && [...files.keys()].some(file => file.startsWith(name + '/')))) {
        warnings.push(`${label}未随包提供：${name}`);
      }
      return name;
    } catch {
      warnings.push(`${label}须是稿件内的相对路径`);
      return undefined;
    }
  }
  const source = location(input.source, '声明的原型源码', true);
  const frameworkDraft = location(input.frameworkDraft, '声明的框架草案', true);
  const docs = new Set<string>();
  if (Array.isArray(input.docs)) {
    for (const declared of input.docs.slice(0, 600)) {
      const name = location(declared, '声明的交付文档');
      if (name) docs.add(name);
    }
  } else if (input.docs !== undefined) warnings.push('交付文档清单须由包内相对路径组成');
  const prototypeVersion = typeof input.prototypeVersion === 'number' && Number.isSafeInteger(input.prototypeVersion)
    && input.prototypeVersion > 0 ? input.prototypeVersion : undefined;
  if (input.prototypeVersion !== undefined && prototypeVersion === undefined) warnings.push('原型版本须是正整数，原值见稿件清单');
  const date = typeof input.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : undefined;
  if (input.date !== undefined && date === undefined) warnings.push('稿件日期须使用 YYYY-MM-DD，原值见稿件清单');
  const notes = typeof input.notes === 'string' ? input.notes.slice(0, 4_000) : undefined;
  if (input.notes !== undefined && (notes === undefined || notes !== input.notes)) warnings.push('完整的稿件说明见原稿件清单');
  const base = (part: string | undefined) => part ? part.replace(/\/+$/, '') : undefined;
  const within = (filename: string, folder: string | undefined) => folder !== undefined && (filename === folder || filename.startsWith(folder + '/'));
  function kind(path: string): DesignDeliveryFile['kind'] {
    if (path === 'design.json') return 'manifest';
    if (path === prototype) return 'prototype';
    if (path === rationale) return 'rationale';
    if (path === checks) return 'checks';
    if (rendered.has(path)) return 'render';
    if (/^(?:交付说明|handoff|delivery)\.md$/i.test(path)) return 'guide';
    if (docs.has(path)) return 'document';
    if (within(path, base(frameworkDraft)) || within(path, 'spec')) return 'framework';
    if (within(path, base(source))) return 'source';
    return 'attachment';
  }
  const index = [...files].map(([path, content]) => {
    const type = kind(path);
    let text = false;
    let headings: string[] | undefined;
    if (deliveryText.test(path)) {
      try {
        const decoded = decoder.decode(content);
        text = !decoded.includes('\0');
        if (text && /\.md$/i.test(path)) {
          headings = [...decoded.matchAll(/^#{1,6}[ \t]+([^\r\n]+)$/gm)].slice(0, 40).map(match => match[1].trim().slice(0, 150));
        }
      } catch { /* Preserve undecodable files as downloads. */ }
    }
    return { path, kind: type, size: content.length, sha256: designDigest(content), text, ...(headings?.length ? { headings } : {}) };
  }).sort((a, b) => a.path.localeCompare(b.path));
  return { archiveRoot: root, index, warnings: [...new Set(warnings)], prototype, source: source ? input.source as string : undefined,
    frameworkDraft: frameworkDraft ? input.frameworkDraft as string : undefined, prototypeVersion, date, notes };
}

export async function readDesignPackage(bytes: Buffer) {
  let entries: Map<string, Buffer>;
  try { entries = await zipEntries(bytes); } catch { return invalidDesign('无法读取稿件 ZIP，检查完整性、文件类型、路径和体积'); }
  const manifests = [...entries.keys()].filter(name => name === 'design.json' || /^[^/]+\/design\.json$/.test(name));
  if (manifests.length !== 1) invalidDesign('稿件包只能包含一份根级 design.json');
  const manifest = manifests[0];
  const root = manifest.slice(0, -'design.json'.length);
  if (root && [...entries.keys()].some(name => !name.startsWith(root))) invalidDesign('稿件文件须位于同一目录');
  const file = (name: unknown) => entries.get(root + relativeFile(name));
  const utf8 = (name: unknown, max: number) => {
    const value = file(name);
    if (!value) return undefined;
    if (value.length > max) return invalidDesign('稿件文本超过单文件体积限制');
    try { return decoder.decode(value); } catch { return invalidDesign('稿件文本须为有效 UTF-8'); }
  };
  const json = (name: unknown) => {
    const value = utf8(name, 128 * 1024);
    if (value === undefined) return undefined;
    try { return designRecord(JSON.parse(value), '稿件 JSON'); } catch { return invalidDesign('稿件包含无效的 JSON 对象'); }
  };
  const input = json('design.json')!;
  const rationale = planningText(utf8(input.rationale ?? '思路.md', 64 * 1024), '设计思路', 64 * 1024);
  const prototypeFile = input.prototype ?? 'dist/index.html';
  const html = utf8(prototypeFile, 4 * mib);
  if (!html || !/<(?:!doctype html|html|head|body|main|div)\b/i.test(html)) return invalidDesign('缺少可打开的单文件 HTML 原型');
  const screens = unique(list(input.screens, '画面清单', 80, screen), row => row.id, '画面');
  const renders = screens.flatMap(screen => screen.themes.flatMap(theme => {
    const content = file(`screens/${screen.id}.${theme}.png`);
    if (!content) return [];
    const actual = designPngDimensions(content);
    const expected = designViewports[screen.viewport];
    if (actual?.width !== expected.width || actual.height !== expected.height) {
      return invalidDesign(`画面 ${screen.id} 的 ${theme} 截图须为 ${expected.width} × ${expected.height} 的 PNG`);
    }
    return [{ screenId: screen.id, theme, content, sha256: designDigest(content) }];
  }));
  if (Buffer.byteLength(html) + renders.reduce((sum, capture) => sum + capture.content.length, 0) > 8 * mib) {
    return invalidDesign('单个稿件版本的原型和截图最多 8 MiB');
  }
  const acceptance = unique(list(input.acceptance, '验收项', 60, value => rule(value, screens), true), row => row.id, '验收项');
  const spec: DesignMaterial = { tokens: json('spec/tokens.json'), rules: utf8('spec/rules.md', 64 * 1024),
    components: utf8('spec/components.md', 64 * 1024), skeleton: utf8('spec/skeleton.html', 64 * 1024) };
  const framework = input.framework == null ? undefined : designId(input.framework, '框架编号');
  const frameworkVersion = input.frameworkVersion;
  if (frameworkVersion !== undefined && (!framework || typeof frameworkVersion !== 'number'
    || !Number.isSafeInteger(frameworkVersion) || frameworkVersion < 1)) return invalidDesign('请提供所用框架的有效版本号');
  const delivery = describeDesignDelivery(entries, root, input, relativeFile(prototypeFile),
    relativeFile(input.rationale ?? '思路.md'), relativeFile(input.checks ?? 'checks/result.json'),
    new Set(renders.map(row => `screens/${row.screenId}.${row.theme}.png`)));
  return {
    packageId: input.id === undefined ? undefined : designId(input.id, '稿件编号'),
    project: planningText(input.project, '项目', 160), title: planningText(input.title, '稿件标题', 180), rationale,
    sha256: designDigest(bytes), filesSha256: designDigest(JSON.stringify(delivery.index.map(file => [file.path, file.sha256]))),
    prototype: Buffer.from(html), screens, acceptance, spec, renders, delivery,
    checks: json(input.checks ?? 'checks/result.json'),
    framework, frameworkVersion,
    group: input.group === undefined ? undefined : planningText(input.group, '稿件分组', 80),
    tags: unique(list(input.tags, '稿件标签', 30, tag => planningText(tag, '标签', 60), true), row => row, '标签'),
    decisionIds: unique(list(input.decisionIds, '关联决策', 20, id => designId(id, '决策编号'), true), row => row, '关联决策'),
  };
}
