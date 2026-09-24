// 搬迁自 cds/src/services/agent-workspace-session-runtime.ts（第 1 阶段：只改归属、不改行为）。
// 第 4 阶段删除 CDS 旧实现之前，两边的判据必须保持逐字一致；改这里要同步改那边，反之亦然。
import path from 'node:path';

import { AgentWorkspaceRuntimeError } from '../errors.js';
import { MAX_HTML_NESTING_DEPTH, decodeHtmlText, iterateHtmlTags, parseHtmlAttributes } from '../quality/html.js';
import { decodeBase64, normalizeRelativePath, sha256 } from '../workspace/primitives.js';
import type { ParsedWorkspacePackage, WorkspacePackageFile, WorkspaceTransferRequest } from '../workspace/transfer.js';

const PUBLIC_ARTIFACT_MANIFEST_SCHEMA = 'map-design-artifact-public-manifest-v2';

export const MAX_OUTPUT_FILE_COUNT = 100;

export const IGNORED_RUNTIME_OUTPUT_PATHS = ['index.html.artifact.json'] as const;
export const CDS_GENERATED_ARTIFACT_PATHS = [
  'assets/accessibility-static-report.json',
  'assets/design-tokens.json',
  'assets/page-outline.json',
  'assets/provenance.json',
] as const;

function jsonArtifactFile(path: string, value: unknown): WorkspacePackageFile {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  return {
    path,
    contentBase64: bytes.toString('base64'),
    sha256: sha256(bytes),
    size: bytes.byteLength,
    mediaType: 'application/json; charset=utf-8',
  };
}

export function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function computePublicArtifactRevision(files: readonly WorkspacePackageFile[]): string {
  const canonical = [...files]
    .sort((left, right) => compareOrdinal(left.path, right.path))
    .flatMap((file) => [file.path, file.sha256, String(file.size), file.mediaType])
    .map((value) => `${Buffer.byteLength(value, 'utf8')}:${value}`)
    .join('');
  return sha256(Buffer.from(canonical, 'utf8'));
}

export function buildPublicArtifactManifest(files: readonly WorkspacePackageFile[]): WorkspacePackageFile {
  const listedFiles = [...files]
    .sort((left, right) => compareOrdinal(left.path, right.path))
    .map(({ path: filePath, sha256: fileSha, size, mediaType }) => ({
      path: filePath,
      sha256: fileSha,
      size,
      mediaType,
    }));
  const manifestBytes = Buffer.from(JSON.stringify({
    schemaVersion: PUBLIC_ARTIFACT_MANIFEST_SCHEMA,
    artifactRevision: computePublicArtifactRevision(files),
    entryFile: 'index.html',
    files: listedFiles,
  }));
  return {
    path: 'manifest.json',
    contentBase64: manifestBytes.toString('base64'),
    sha256: sha256(manifestBytes),
    size: manifestBytes.byteLength,
    mediaType: 'application/json; charset=utf-8',
  };
}

const MAX_OUTLINE_HEADINGS = 256;
const MAX_HEADING_TEXT_CHARS = 2_048;
const MAX_CSS_DERIVATION_CHARS = 512 * 1024;

type DerivedHeading = { level: number; text: string; id?: string };

function appendBounded(current: string, next: string, limit: number): string {
  if (current.length >= limit || !next) return current;
  return current + next.slice(0, limit - current.length);
}


function normalizeDerivedText(value: string, maxLength: number): string {
  return decodeHtmlText(value).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

/**
 * Build public deterministic side files only after the final HTML has passed
 * CDS hardening. Values come from the publishable document or a non-identifying
 * count; private source ids, object keys, credentials and source hashes never
 * cross this boundary.
 */
export function buildGeneratedArtifactFiles(
  hardenedHtml: string,
  authorAssetPaths: readonly string[] = [],
): WorkspacePackageFile[] {
  const headings: DerivedHeading[] = [];
  const customProperties = new Map<string, string>();
  const colors = new Set<string>();
  const fontFamilies = new Set<string>();
  const breakpoints = new Set<number>();
  const landmarks: Record<string, number> = { header: 0, nav: 0, main: 0, aside: 0, footer: 0 };
  const stack: Array<{
    name: string;
    suppressed: boolean;
    heading?: { level: number; id?: string; text: string };
    title?: { text: string };
    styleStart?: number;
  }> = [];
  let activeHeading: typeof stack[number]['heading'];
  let activeTitle: typeof stack[number]['title'];
  let documentTitle = '';
  let suppressedDepth = 0;
  let htmlLanguage = '';
  let headingCount = 0;
  let h1Count = 0;
  let imageCount = 0;
  let missingImageAltCount = 0;
  let linkCount = 0;
  let buttonCount = 0;
  let cssCharsRemaining = MAX_CSS_DERIVATION_CHARS;
  let cursor = 0;

  const processCss = (rawCss: string): void => {
    if (cssCharsRemaining <= 0) return;
    const css = rawCss.slice(0, cssCharsRemaining).replace(/\/\*[\s\S]*?\*\//g, ' ');
    cssCharsRemaining -= Math.min(rawCss.length, cssCharsRemaining);
    if (customProperties.size < 256) {
      for (const match of css.matchAll(/(--[a-z0-9_-]+)\s*:\s*([^;}{]+)/gi)) {
        const key = match[1].toLowerCase();
        if (!customProperties.has(key) && customProperties.size >= 256) break;
        customProperties.set(key, match[2].trim().slice(0, 240));
      }
    }
    if (colors.size < 256) {
      for (const match of css.matchAll(/#[0-9a-f]{3,8}\b|(?:rgb|hsl)a?\([^)]{1,120}\)/gi)) {
        colors.add(match[0].toLowerCase().replace(/\s+/g, ' '));
        if (colors.size >= 256) break;
      }
    }
    if (fontFamilies.size < 64) {
      for (const match of css.matchAll(/font-family\s*:\s*([^;}{]+)/gi)) {
        fontFamilies.add(match[1].trim().replace(/\s+/g, ' ').slice(0, 240));
        if (fontFamilies.size >= 64) break;
      }
    }
    if (breakpoints.size < 64) {
      for (const match of css.matchAll(/@media[^{}]*\((?:min|max)-width\s*:\s*(\d+)px\)/gi)) {
        breakpoints.add(Number.parseInt(match[1], 10));
        if (breakpoints.size >= 64) break;
      }
    }
  };

  for (const tag of iterateHtmlTags(hardenedHtml)) {
    const text = hardenedHtml.slice(cursor, tag.start);
    if (activeTitle) activeTitle.text = appendBounded(activeTitle.text, text, MAX_HEADING_TEXT_CHARS);
    if (activeHeading && suppressedDepth === 0) {
      activeHeading.text = appendBounded(activeHeading.text, text, MAX_HEADING_TEXT_CHARS);
    }
    cursor = tag.end;
    const name = tag.name.toLowerCase();
    if (tag.isClosing) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        const frame = stack.pop()!;
        if (frame.suppressed) suppressedDepth -= 1;
        if (frame.styleStart !== undefined) processCss(hardenedHtml.slice(frame.styleStart, tag.start));
        if (frame.heading) {
          const normalizedText = normalizeDerivedText(frame.heading.text, 240);
          if (normalizedText && headings.length < MAX_OUTLINE_HEADINGS) {
            headings.push({
              level: frame.heading.level,
              text: normalizedText,
              ...(frame.heading.id ? { id: frame.heading.id } : {}),
            });
          }
          if (activeHeading === frame.heading) activeHeading = undefined;
        }
        if (frame.title) {
          if (!documentTitle) documentTitle = normalizeDerivedText(frame.title.text, 240);
          if (activeTitle === frame.title) activeTitle = undefined;
        }
        if (frame.name === name) break;
      }
      continue;
    }

    const needsAttributes = name === 'html'
      || name === 'img'
      || /^h[1-6]$/.test(name)
      || /(?:^|\s)(?:hidden|aria-hidden|style)(?:\s|=|$)/i.test(tag.attributes);
    const attributes = needsAttributes ? parseHtmlAttributes(tag.attributes) : new Map<string, string>();
    if (name === 'html' && !htmlLanguage) {
      htmlLanguage = decodeHtmlText(attributes.get('lang') || '').trim().slice(0, 80);
    }
    const inlineStyle = attributes.get('style') || '';
    const suppressed = ['head', 'template', 'noscript', 'script', 'style'].includes(name)
      || attributes.has('hidden')
      || (attributes.get('aria-hidden') || '').trim().toLowerCase() === 'true'
      || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i.test(inlineStyle);
    const visible = suppressedDepth === 0 && !suppressed;
    let heading: typeof activeHeading;
    let titleFrame: typeof activeTitle;
    if (visible && /^h[1-6]$/.test(name)) {
      const level = Number.parseInt(name[1], 10);
      headingCount += 1;
      if (level === 1) h1Count += 1;
      heading = {
        level,
        text: '',
        ...(attributes.get('id') ? { id: decodeHtmlText(attributes.get('id') || '').slice(0, 160) } : {}),
      };
      activeHeading = heading;
    }
    if (name === 'title' && !activeTitle) {
      titleFrame = { text: '' };
      activeTitle = titleFrame;
    }
    if (visible) {
      if (name === 'img') {
        imageCount += 1;
        if (!attributes.has('alt')) missingImageAltCount += 1;
      } else if (name === 'a') linkCount += 1;
      else if (name === 'button') buttonCount += 1;
      if (Object.hasOwn(landmarks, name)) landmarks[name] += 1;
    }
    const voidElement = /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(name);
    if (!tag.isSelfClosing && !voidElement) {
      if (stack.length >= MAX_HTML_NESTING_DEPTH) {
        throw new AgentWorkspaceRuntimeError(
          'design_output_quality_rejected',
          'index.html exceeds the supported HTML nesting depth',
        );
      }
      stack.push({
        name,
        suppressed,
        ...(heading ? { heading } : {}),
        ...(titleFrame ? { title: titleFrame } : {}),
        ...(name === 'style' ? { styleStart: tag.end } : {}),
      });
      if (suppressed) suppressedDepth += 1;
    }
  }
  const title = documentTitle || normalizeDerivedText(activeTitle?.text || '', 240);

  return [
    jsonArtifactFile('assets/page-outline.json', {
      schemaVersion: 'map-page-outline-v1',
      title,
      headings,
    }),
    jsonArtifactFile('assets/design-tokens.json', {
      schemaVersion: 'map-design-tokens-v1',
      customProperties: Object.fromEntries([...customProperties.entries()].sort(([left], [right]) => left.localeCompare(right))),
      colors: [...colors].sort(),
      fontFamilies: [...fontFamilies].sort(),
      responsiveBreakpointsPx: [...breakpoints].sort((left, right) => left - right),
    }),
    jsonArtifactFile('assets/accessibility-static-report.json', {
      schemaVersion: 'map-accessibility-static-report-v1',
      document: {
        hasLanguage: htmlLanguage.length > 0,
        language: htmlLanguage || null,
        hasTitle: title.length > 0,
        headingCount,
        hasSingleH1: h1Count === 1,
      },
      images: {
        count: imageCount,
        missingAltCount: missingImageAltCount,
      },
      controls: {
        linkCount,
        buttonCount,
      },
      landmarks,
      scope: 'static-structure-only',
    }),
    jsonArtifactFile('assets/provenance.json', {
      schemaVersion: 'map-artifact-provenance-v1',
      producer: 'cds-open-design-runtime',
      derivationStage: 'post-security-hardening',
      publicInput: authorAssetPaths.length ? 'hardened-index-html-and-author-assets' : 'hardened-index-html',
      publishedFiles: ['index.html', ...authorAssetPaths, ...CDS_GENERATED_ARTIFACT_PATHS, 'manifest.json'].sort(compareOrdinal),
      privacy: authorAssetPaths.length
        ? 'author-assets-preserved-publication-review-required'
        : 'public-html-only-no-private-source-metadata',
    }),
  ].sort((left, right) => left.path.localeCompare(right.path));
}

export function buildGeneratedPublicArtifactPackage(
  hardenedHtml: string,
  collectedFiles: readonly WorkspacePackageFile[],
): WorkspacePackageFile[] {
  const authorAssets = validatePublicArtifactFiles(collectedFiles, true)
    .filter((file) => file.path !== 'index.html');
  const indexBytes = Buffer.from(hardenedHtml);
  const indexFile: WorkspacePackageFile = {
    path: 'index.html',
    contentBase64: indexBytes.toString('base64'),
    sha256: sha256(indexBytes),
    size: indexBytes.byteLength,
    mediaType: 'text/html; charset=utf-8',
  };
  const publicFiles = [indexFile, ...authorAssets, ...buildGeneratedArtifactFiles(hardenedHtml, authorAssets.map((file) => file.path))]
    .sort((left, right) => compareOrdinal(left.path, right.path));
  assertPublicArtifactFileCount(publicFiles.length + 1);
  return [...publicFiles, buildPublicArtifactManifest(publicFiles)]
    .sort((left, right) => compareOrdinal(left.path, right.path));
}

export function isAllowedOutput(relativePath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith('/**')) {
      const prefix = pattern.slice(0, -3);
      return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
    }
    return relativePath === pattern;
  });
}

export function mediaTypeForFile(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.html') return 'text/html; charset=utf-8';
  if (extension === '.css') return 'text/css; charset=utf-8';
  if (extension === '.js' || extension === '.mjs') return 'text/javascript; charset=utf-8';
  if (extension === '.json') return 'application/json; charset=utf-8';
  if (extension === '.svg') return 'image/svg+xml';
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.ico') return 'image/x-icon';
  if (extension === '.woff') return 'font/woff';
  if (extension === '.woff2') return 'font/woff2';
  if (extension === '.ttf') return 'font/ttf';
  if (extension === '.otf') return 'font/otf';
  return 'application/octet-stream';
}

export function assertPublicArtifactFileCount(fileCount: number): void {
  if (fileCount > MAX_OUTPUT_FILE_COUNT) {
    throw new AgentWorkspaceRuntimeError('design_output_too_many_files', `Public output exceeds the ${MAX_OUTPUT_FILE_COUNT}-file limit`);
  }
}

// Mirrors Core DesignArtifactPublicPath; workspace/private paths keep their
// separate, existing transport contract.
export function assertPublicArtifactPath(filePath: string): void {
  normalizeRelativePath(filePath);
  if (filePath.length > 240 || filePath.normalize('NFC') !== filePath
    || /[%?#:\u0000-\u001f\u007f-\u009f]/.test(filePath)
    || filePath.split('/').some((segment) => /[ .]$/.test(segment)
      || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(segment.split('.')[0]))) {
    throw new AgentWorkspaceRuntimeError('design_output_invalid', `invalid public output path: ${filePath}`);
  }
}

function validatePublicJson(text: string): void {
  // Keep BOM visible (and rejected by JSON.parse) and match MAP's 64-level
  // JsonDocument limit without rewriting or recursively walking the payload.
  JSON.parse(text);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === '[' || character === '{') {
      depth += 1;
      if (depth > 64) throw new Error('JSON depth exceeds 64');
    } else if (character === ']' || character === '}') depth -= 1;
  }
}

// This is the byte-preservation boundary. Script execution is granted later only
// when index.html references a file in this exact validated package.
export function validatePublicArtifactFiles(
  files: readonly WorkspacePackageFile[],
  rejectGeneratedPaths = false,
): WorkspacePackageFile[] {
  const seen = new Set<string>(rejectGeneratedPaths ? CDS_GENERATED_ARTIFACT_PATHS.map((filePath) => filePath.toUpperCase()) : []);
  const validated = files.filter((file) => file.path !== 'manifest.json').map((file) => {
    assertPublicArtifactPath(file.path);
    const identity = file.path.toUpperCase();
    if (rejectGeneratedPaths && CDS_GENERATED_ARTIFACT_PATHS.some((reserved) => reserved.toUpperCase() === identity)) {
      throw new AgentWorkspaceRuntimeError('design_output_invalid', `public output path is reserved for CDS metadata: ${file.path}`);
    }
    if (seen.has(identity)) throw new AgentWorkspaceRuntimeError('design_output_invalid', `duplicate public output: ${file.path}`);
    seen.add(identity);
    if (file.path !== 'index.html'
      && (!file.path.startsWith('assets/') || !/\.(?:css|js|mjs|png|jpe?g|gif|webp|ico|woff2?|ttf|otf|json)$/i.test(file.path))) {
      throw new AgentWorkspaceRuntimeError('design_output_invalid', `unsupported public output type: ${file.path}`);
    }
    let bytes: Buffer;
    try {
      bytes = decodeBase64(file.contentBase64, file.path);
    } catch {
      throw new AgentWorkspaceRuntimeError('design_output_invalid', `invalid public output bytes: ${file.path}`);
    }
    if (bytes.byteLength === 0 || bytes.byteLength !== file.size || sha256(bytes) !== file.sha256 || file.mediaType !== mediaTypeForFile(file.path)) {
      throw new AgentWorkspaceRuntimeError('design_output_invalid', `public output integrity mismatch: ${file.path}`);
    }
    if (/\.(?:html|css|js|mjs|json)$/i.test(file.path)) {
      try {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        if (path.extname(file.path).toLowerCase() === '.json') validatePublicJson(text);
      } catch {
        throw new AgentWorkspaceRuntimeError('design_output_invalid', `public text output is not valid UTF-8 or JSON: ${file.path}`);
      }
    }
    return { ...file };
  });
  for (const identity of seen) {
    for (let separator = identity.indexOf('/'); separator >= 0; separator = identity.indexOf('/', separator + 1)) {
      if (seen.has(identity.slice(0, separator))) {
        throw new AgentWorkspaceRuntimeError('design_output_invalid', 'public output file and directory paths conflict');
      }
    }
  }
  return validated;
}

// Start edits from the verified public snapshot, not from a second merge at commit.
// A deleted working-copy file must stay deleted; frozen current/ inputs are never exported.
export function prepareCurrentArtifactSeeds(
  inputFiles: ParsedWorkspacePackage['files'],
  transfer: WorkspaceTransferRequest,
): WorkspacePackageFile[] {
  const currentFiles = inputFiles.filter((file) => file.path.startsWith('current/'));
  if (currentFiles.length === 0) return [];
  try {
    const currentEntry = currentFiles.find((file) => file.path === 'current/index.html');
    if (!currentEntry) throw new Error('current entry is missing');
    // These are format-compatibility checks, not proof of producer identity or authorization.
    // An arbitrary uploaded file with the same reserved name must not silently disappear.
    const knownReports = new Map(buildGeneratedArtifactFiles('')
      .map((file) => [file.path, JSON.parse(Buffer.from(file.contentBase64, 'base64').toString('utf8')) as Record<string, unknown>]));
    for (const file of currentFiles) {
      const publicPath = file.path.slice('current/'.length);
      const reportShape = knownReports.get(publicPath);
      if (publicPath !== 'manifest.json' && !reportShape) continue;
      const record = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes));
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('unknown reserved file format');
      if (publicPath === 'manifest.json') {
        if (record.schemaVersion !== PUBLIC_ARTIFACT_MANIFEST_SCHEMA || record.entryFile !== 'index.html'
          || Object.keys(record).sort().join(',') !== 'artifactRevision,entryFile,files,schemaVersion'
          || !Array.isArray(record.files) || !record.files.length || record.files.length >= MAX_OUTPUT_FILE_COUNT
          || !record.files.every((item: unknown) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
            const listed = item as Record<string, unknown>;
            return Object.keys(listed).sort().join(',') === 'mediaType,path,sha256,size'
              && typeof listed.path === 'string' && typeof listed.mediaType === 'string'
              && typeof listed.sha256 === 'string' && /^[a-f0-9]{64}$/.test(listed.sha256)
              && typeof listed.size === 'number' && Number.isSafeInteger(listed.size) && listed.size > 0;
          })
          || record.artifactRevision !== computePublicArtifactRevision(record.files)) throw new Error('unknown reserved manifest format');
        // Do not compare the old entry hash to normalized current/index.html:
        // MAP may have removed the trusted system CSP envelope from that input.
      } else if (record.schemaVersion !== reportShape!.schemaVersion
        || Object.keys(record).sort().join(',') !== Object.keys(reportShape!).sort().join(',')
        || publicPath === 'assets/provenance.json' && (record.producer !== reportShape!.producer || record.derivationStage !== reportShape!.derivationStage)) {
        throw new Error('unknown reserved report format');
      }
    }
    const candidates = currentFiles.map((file) => {
      const publicPath = file.path.slice('current/'.length);
      const expectedMime = mediaTypeForFile(publicPath);
      // Stored sites may use a MIME without charset or the equivalent JS MIME.
      // Normalize that declaration only; never re-encode the original bytes.
      const [baseMime, ...parameters] = file.mediaType.split(';').map((part) => part.trim().toLowerCase());
      const expectedBase = expectedMime.split(';')[0];
      if (!(baseMime === expectedBase || expectedBase === 'text/javascript' && baseMime === 'application/javascript')
        || parameters.length > 1 || parameters.some((parameter) => !/^charset\s*=\s*(?:utf-8|"utf-8")$/.test(parameter))) {
        throw new Error('current resource MIME is incompatible with its file type');
      }
      return {
        path: publicPath, contentBase64: file.bytes.toString('base64'), sha256: file.sha256,
        size: file.bytes.byteLength, mediaType: expectedMime,
      };
    });
    const validated = validatePublicArtifactFiles(candidates);
    if (!validated.some((file) => file.path === 'index.html')) throw new Error('current entry is missing');
    // Old derived reports describe the previous revision and must not masquerade
    // as authored resources. Exact known paths only; case aliases remain invalid.
    const seeds = validated.filter((file) => !CDS_GENERATED_ARTIFACT_PATHS.some((reportPath) => file.path === reportPath));
    validatePublicArtifactFiles(seeds, true);
    for (const seed of seeds) {
      if (!isAllowedOutput(seed.path, transfer.allowedOutputPaths)) throw new Error('current resource is outside the authorized output paths');
      if (inputFiles.some((file) => file.path === seed.path)) throw new Error('editable copy conflicts with a frozen input');
    }
    assertPublicArtifactFileCount(seeds.length + 1);
    if (seeds.reduce((total, file) => total + file.size, 0) > transfer.maxOutputBytes) throw new Error('current resources exceed the output size limit');
    return seeds;
  } catch {
    throw new AgentWorkspaceRuntimeError(
      'workspace_current_artifact_unsupported',
      'Current site cannot be copied intact into the authorized public workspace; check its paths, file types, and size',
    );
  }
}

export function publicTransfer(transfer: WorkspaceTransferRequest): Omit<WorkspaceTransferRequest, 'transferToken'> {
  const { transferToken: _token, ...safe } = transfer;
  return safe;
}
