// 搬迁自 cds/src/services/agent-workspace-session-runtime.ts（第 1 阶段：只改归属、不改行为）。
// 第 4 阶段删除 CDS 旧实现之前，两边的判据必须保持逐字一致；改这里要同步改那边，反之亦然。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { assertPublicArtifactPath } from '../artifact/public-package.js';
import { AgentWorkspaceRuntimeError } from '../errors.js';
import { decodeHtmlText, extractVisibleHtmlText, hasHtmlAttribute, iterateHtmlTags, parseHtmlAttributes, readHtmlAttribute } from './html.js';

export interface VisibleTextOccurrenceConstraint {
  text: string;
  minOccurrences: number;
  maxOccurrences: number;
}

export const MAP_DESIGN_ARTIFACT_QUALITY_SCHEMA = 'map-design-artifact-quality-v1';

// A real design run commonly exposes a different deterministic violation after each
// repair (for example: unsupported facts, then broken fragments, then inert buttons).
// Keep the repair loop bounded by this cap and the execution deadline, while
// allowing OpenDesign enough passes to converge instead of failing a valid task after
// only two repairs.
export const MAX_QUALITY_REPAIR_ATTEMPTS = 4;

/** 模板 <main> 里那段「把版式粘到这里」的指示注释。留在交付页面里 = 起始页原样交回。 */
const TEMPLATE_UNTOUCHED_MARKER = 'PASTE LAYOUTS FROM references/layouts.md HERE';

const ARTIFACT_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "img-src data:",
  "font-src data:",
  "media-src data:",
  "style-src 'unsafe-inline'",
  "script-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
].join('; ');
const VERIFIED_PACKAGE_ARTIFACT_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'self' blob:",
  "manifest-src 'none'",
].join('; ');
const DOCUMENT_ROOT_RE = /^\uFEFF?\s*(?:<!doctype\s+html\s*>\s*)?(?:<!--[\s\S]*?-->\s*)*<html(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"<>]*"|'[^'<>]*'|[^\s"'\x60=<>]+))?)*\s*>/i;
const DOCUMENT_HEAD_RE = /^\s*(?:<!--[\s\S]*?-->\s*)*<head(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"<>]*"|'[^'<>]*'|[^\s"'\x60=<>]+))?)*\s*>/i;

export function canAcceptUntrackedWorkspaceEdit(
  deliverableValidation: string | undefined,
  currentHtml: Buffer | undefined,
  outputHtml: Buffer,
): boolean {
  return deliverableValidation === 'no_artifact'
    && outputHtml.length > 0
    && (currentHtml === undefined || !currentHtml.equals(outputHtml));
}

/**
 * 「有几个、在哪」的位置提示，锚点与按钮共用一份。序号与总数由闸门给出，
 * 缺了就退回不带位置的说法（`no-rootless-tree`：不编）。
 */
function brokenElementLocationHint(
  details: Record<string, unknown> | undefined,
  countKey: string,
  ordinalsKey: string,
  // 人读的词（anchor / button）与标签名（a / button）是两回事：共用一个会写出
  // 「2 such a(s)」这种句子。分开传，模型读到的仍是它数得出来的那个东西。
  noun: string,
  tagName: string,
): string {
  const rawCount = details?.[countKey];
  const count = typeof rawCount === 'number' && Number.isSafeInteger(rawCount) && rawCount > 0
    ? rawCount
    : undefined;
  const rawOrdinals = details?.[ordinalsKey];
  const ordinals = Array.isArray(rawOrdinals)
    ? rawOrdinals.filter((value): value is number => (
      typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    )).slice(0, 24)
    : [];
  if (count === undefined || ordinals.length === 0) return '';
  return ` There are ${count} such ${noun}(s); they are at document-order ${noun} position(s) `
    + `${ordinals.join(', ')} (counting every <${tagName}> element from the top of the file).`;
}

const brokenAnchorLocationHint = (details: Record<string, unknown> | undefined): string =>
  brokenElementLocationHint(details, 'brokenLinkCount', 'brokenLinkOrdinals', 'anchor', 'a');

const inertButtonLocationHint = (details: Record<string, unknown> | undefined): string =>
  brokenElementLocationHint(details, 'inertButtonCount', 'inertButtonOrdinals', 'button', 'button');

export function classifyQualityRepairReason(error: AgentWorkspaceRuntimeError): { code: string; instruction: string } | undefined {
  const { message } = error;
  if (message === 'index.html contains a measured claim with unresolved source context'
    || message === 'index.html dropped a retained source-backed measured claim') {
    const missing = message === 'index.html dropped a retained source-backed measured claim';
    const token = controlledMeasuredClaimToken(error.details?.measuredClaimToken);
    return {
      code: missing ? 'retained_measured_claim_missing' : 'measured_claim_context_unresolved',
      instruction: `${token ? `The source-backed quantity ${token}` : 'A source-backed quantity'} ${missing ? 'is no longer visibly retained' : 'has a value present in the sources, but its subject cannot be aligned confidently'}. Do not delete or change the quantity. Read the frozen factual sources and restore the original source wording, keeping the subject and quantity together in visible text.`,
    };
  }
  if (message === 'index.html contains no explicit body element') {
    return {
      code: 'missing_body',
      instruction: 'Create one explicit body element containing the complete visible page.',
    };
  }
  if (message === 'index.html contains no visible content') {
    return {
      code: 'no_visible_content',
      instruction: 'Create a complete page with meaningful visible content grounded in the MAP task and knowledge sources.',
    };
  }
  if (message === 'index.html contains visible placeholder or unfinished content') {
    return {
      code: 'visible_placeholder',
      instruction: 'Remove every visible placeholder or unfinished-content marker.',
    };
  }
  if (message === 'index.html still contains unreplaced template placeholders') {
    const rawCount = error.details?.placeholderCount;
    const count = typeof rawCount === 'number' && Number.isSafeInteger(rawCount) && rawCount > 0
      ? rawCount
      : undefined;
    const rawSamples = error.details?.placeholderSamples;
    // 样本来自模型自己的产物，可能夹着注入尝试：只收形如 `[REPLACE] 短文本` 的片段，逐条限长。
    const samples = Array.isArray(rawSamples)
      ? rawSamples
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.replace(/\s+/g, ' ').trim().slice(0, 48))
        .filter((value) => /^\[\s*replace\s*\]/i.test(value))
        .slice(0, 12)
      : [];
    const head = count === undefined || samples.length === 0
      ? ''
      : `There are ${count} unreplaced placeholder(s) left, for example: ${samples.join(' | ')}. `;
    return {
      code: 'unreplaced_template_placeholder',
      instruction: `${head}Every [REPLACE] marker is a slot you must fill with real copy taken from the MAP task `
        + 'and the knowledge sources. Replace the whole marker including the word REPLACE and its brackets; '
        + 'never leave one behind, and do not just delete the slot element instead of filling it. '
        + 'Search the entire file for the marker before you finish - the publication gate rejects the page '
        + 'if a single one remains.',
    };
  }
  if (message === 'index.html is still the untouched starter template') {
    return {
      code: 'untouched_starter_template',
      instruction: 'You returned the starter template unchanged: its layout-instruction comment is still inside <main>, '
        + 'so no real page was produced. Build the actual page now from the MAP task in /workspace/brief/task.json and the '
        + 'knowledge sources - replace the entire contents of <main> with real sections and copy, and fill every remaining '
        + 'slot in the header and footer. Keep the template only as a layout and styling reference.',
    };
  }
  if (message === 'index.html contains a link without a target') {
    return {
      code: 'link_without_target',
      instruction: `${brokenAnchorLocationHint(error.details)}Every anchor needs a real destination, and the publication policy accepts exactly one kind: href="#section-id" pointing at an id that exists on this page. An absolute or relative URL fails the package validator instead, with no repair pass. A label that is not meant to navigate must stop being an anchor: render it as span, li, or heading text. The web-prototype template is the usual source of these; its markup is a sketch, not permitted output.`.trim(),
    };
  }
  if (message === 'index.html contains an empty link target') {
    return {
      code: 'empty_link_target',
      instruction: `${brokenAnchorLocationHint(error.details)}href="#" and href="" are rejected without exception, including in the topnav and footer. Point each anchor at a fragment of this same page instead: href="#section-id" where that id exists here, so the navigation actually jumps to your own sections. That is the only link target the publication policy accepts - an absolute or relative URL fails the package validator, with no repair pass. A label that is not meant to navigate must stop being an anchor: render it as span, li, or heading text. You most likely copied these from the web-prototype template or layouts.md; those files are layout sketches, not permitted markup, and rewriting them here is not removing a requested control.`.trim(),
    };
  }
  if (message === 'index.html contains a malformed fragment target') {
    return {
      code: 'malformed_fragment_target',
      instruction: 'Remove or correct every malformed in-page fragment link.',
    };
  }
  if (
    message.startsWith('index.html contains a missing fragment target:')
    || message.startsWith('index.html contains missing fragment targets:')
    || /^index\.html contains [1-9]\d* missing fragment target\(s\)$/.test(message)
  ) {
    const count = typeof error.details?.missingFragmentCount === 'number'
      && Number.isSafeInteger(error.details.missingFragmentCount)
      && error.details.missingFragmentCount > 0
      ? error.details.missingFragmentCount
      : undefined;
    const ordinals = Array.isArray(error.details?.missingLinkOrdinals)
      ? error.details.missingLinkOrdinals.filter((value): value is number => (
        typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      )).slice(0, 24)
      : [];
    return {
      code: 'missing_fragment_target',
      instruction: count !== undefined && ordinals.length > 0
        ? `There are ${count} missing fragment link target(s). Correct or remove the affected anchor element(s) at document-order position(s) ${ordinals.join(', ')}, then inspect every other fragment link against existing element ids.`
        : 'Remove or correct every in-page link whose fragment does not match an existing element id.',
    };
  }
  if (message === 'index.html contains an enabled button without provable declarative behavior') {
    return {
      code: 'inert_enabled_button',
      instruction: `${inertButtonLocationHint(error.details)}Repair each enabled button to perform the requested behavior: drive a real popover via popovertarget, or rewrite it as an anchor to one of your own sections. Do not remove or disable a control the MAP instruction actually asked for; a bare [REPLACE] CTA copied from the web-prototype template was never requested, so turning that one into an anchor or plain text is the correct repair, not a degradation. If the current publication policy cannot support a requested behavior, report the incompatibility instead of degrading the deliverable.`.trim(),
    };
  }
  if (message === 'index.html violates a visible text occurrence constraint') {
    const ordinal = typeof error.details?.constraintOrdinal === 'number'
      && Number.isSafeInteger(error.details.constraintOrdinal)
      && error.details.constraintOrdinal > 0
      ? error.details.constraintOrdinal
      : undefined;
    return {
      code: 'visible_text_occurrence',
      instruction: ordinal === undefined
        ? 'Read qualityContract.visibleTextOccurrenceConstraints in task.json and make every constrained visible text appear exactly the required number of times.'
        : `Read qualityContract.visibleTextOccurrenceConstraints in task.json. Make constraint number ${ordinal} appear exactly once in visible page content, removing duplicate rendered elements while preserving the requested insertion.`,
    };
  }
  if (message === 'index.html contains CSS-generated textual content') {
    return {
      code: 'css_generated_text',
      instruction: 'Move every readable pseudo-element or CSS-generated string into an ordinary visible HTML text node. CSS content may contain decorative symbols only.',
    };
  }
  if (message.startsWith('index.html contains an unsupported measured claim:')) {
    const ordinal = typeof error.details?.measuredClaimOrdinal === 'number'
      && Number.isSafeInteger(error.details.measuredClaimOrdinal)
      && error.details.measuredClaimOrdinal > 0
      ? error.details.measuredClaimOrdinal
      : undefined;
    const token = controlledMeasuredClaimToken(error.details?.measuredClaimToken);
    return {
      code: 'unsupported_measured_claim',
      instruction: ordinal !== undefined && token !== undefined
        ? `Visible measured claim number ${ordinal} in document order has unsupported normalized token ${token}. Remove that exact claim or rewrite it using only a value supported for the same subject by the MAP knowledge sources, then inspect every other measured claim.`
        : 'Remove every measured claim that is not supported by the MAP knowledge sources.',
    };
  }
  if (message.startsWith('index.html contains an unsupported date, contact, or URL:')) {
    return {
      code: 'unsupported_fact',
      instruction: 'Remove every date, contact detail, or URL that is not supported by the MAP knowledge sources.',
    };
  }
  return undefined;
}

/** Version 1 canonical bytes shared with HostedSiteRevisionRules.NormalizeGeneratedHtml. */
export function normalizeGeneratedHtml(raw: string): string {
  const trimHtmlWhitespace = (value: string) => value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
  let value = String(raw ?? '').replace(/\r\n?/g, '\n');
  if (value.startsWith('\uFEFF')) value = value.slice(1);
  value = trimHtmlWhitespace(value);
  if (!value.startsWith('```')) return value;
  const firstLine = value.indexOf('\n');
  if (firstLine >= 0) value = value.slice(firstLine + 1);
  const closing = value.lastIndexOf('```');
  if (closing >= 0) value = value.slice(0, closing);
  return trimHtmlWhitespace(value);
}

export function hardenSelfContainedHtml(
  rawHtml: string,
  evidenceText = '',
  visibleTextOccurrenceConstraints: readonly VisibleTextOccurrenceConstraint[] = [],
): string {
  return hardenHtmlWithFactRetention(rawHtml, evidenceText, visibleTextOccurrenceConstraints);
}

export function hardenVerifiedPackageHtml(
  rawHtml: string,
  packagePaths: readonly string[],
  evidenceText = '',
  visibleTextOccurrenceConstraints: readonly VisibleTextOccurrenceConstraint[] = [],
): string {
  return hardenHtmlWithFactRetention(
    rawHtml,
    evidenceText,
    visibleTextOccurrenceConstraints,
    undefined,
    packagePaths,
  );
}

interface RetainedMeasuredFact {
  token: string;
  candidates: readonly MeasuredClaimContext[];
}

interface MeasuredFactRetentionState {
  facts: Map<string, RetainedMeasuredFact>;
  supportedClaims: MeasuredClaimIndex;
  authoritativeClaims: MeasuredClaimIndex;
}

/** Retains only source-backed quantities already presented during this execution,
 * not every number in a knowledge base. Source bindings cannot be replaced by a
 * repaired page, model-authored attributes, or state from another execution. */
export function createArtifactQualityGate(
  evidenceText: string,
  visibleTextOccurrenceConstraints: readonly VisibleTextOccurrenceConstraint[] = [],
  authoritativeEvidenceText = evidenceText,
): (rawHtml: string, packagePaths?: readonly string[]) => string {
  const retention: MeasuredFactRetentionState = {
    facts: new Map(),
    supportedClaims: indexMeasuredClaims(measuredClaimContexts(evidenceText)),
    authoritativeClaims: indexMeasuredClaims(measuredClaimContexts(authoritativeEvidenceText)),
  };
  const constraints = visibleTextOccurrenceConstraints.map((constraint) => ({ ...constraint }));
  return (rawHtml, packagePaths) => hardenHtmlWithFactRetention(
    rawHtml,
    evidenceText,
    constraints,
    retention,
    packagePaths,
  );
}

function hardenHtmlWithFactRetention(
  rawHtml: string,
  evidenceText: string,
  visibleTextOccurrenceConstraints: readonly VisibleTextOccurrenceConstraint[],
  retention?: MeasuredFactRetentionState,
  packagePaths?: readonly string[],
): string {
  let html = normalizeGeneratedHtml(rawHtml);
  if (!DOCUMENT_ROOT_RE.test(html)) {
    throw new AgentWorkspaceRuntimeError(
      'design_output_invalid',
      'index.html must contain an explicit html root element so the security policy can be injected',
    );
  }
  const verifiedPackagePaths = packagePaths === undefined
    ? undefined
    : validateVerifiedPackagePaths(packagePaths);
  html = convertRelativeKnowledgeAnchors(html);
  for (const tag of iterateHtmlTags(html)) {
    if (tag.isClosing) continue;
    const name = tag.name.toLowerCase();
    if (verifiedPackagePaths === undefined && name === 'script') {
      throw new AgentWorkspaceRuntimeError(
        'design_output_not_self_contained',
        'index.html contains executable script; the OpenDesign MVP accepts declarative HTML and CSS only',
      );
    }
    if (/^(?:animate|set|animatemotion|animatetransform)$/i.test(name)) {
      throw new AgentWorkspaceRuntimeError(
        'design_output_not_self_contained',
        'index.html contains a disallowed SVG animation primitive',
      );
    }
    const attributes = parseHtmlAttributes(tag.attributes);
    for (const attribute of ['src', 'href', 'poster', 'background']) {
      const rawValue = attributes.get(attribute);
      if (rawValue === undefined) continue;
      const value = decodeHtmlText(rawValue ?? '').trim();
      if (!value || value.startsWith('#')) continue;
      if (verifiedPackagePaths !== undefined) {
        assertVerifiedPackageReference(name, attribute, value, verifiedPackagePaths);
      } else {
        if (value.startsWith('data:') && name !== 'a' && name !== 'area') continue;
        throw new AgentWorkspaceRuntimeError(
          'design_output_not_self_contained',
          `index.html references a non-inline resource from <${name}>`,
        );
      }
    }
    if (
      [...attributes.keys()].some((attribute) => (
        ['srcset', 'srcdoc', 'ping', 'formaction', 'xlink:href'].includes(attribute)
        || (verifiedPackagePaths === undefined && attribute.startsWith('on'))
      ))
      || (verifiedPackagePaths === undefined
        ? /^(?:applet|base|iframe|frame|object|embed|form)$/i.test(name)
        : /^(?:applet|base|iframe|frame|object|embed)$/i.test(name))
      || (name === 'meta' && attributes.has('http-equiv'))
    ) {
      throw new AgentWorkspaceRuntimeError(
        'design_output_not_self_contained',
        'index.html contains an embedded navigation or document primitive',
      );
    }
  }
  if (/@import\s+(?:url\s*\()?/i.test(html)) {
    throw new AgentWorkspaceRuntimeError(
      'design_output_not_self_contained',
      'index.html CSS contains a disallowed @import',
    );
  }
  for (const match of html.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    const value = match[2].trim();
    if (!value || value.startsWith('data:') || value.startsWith('#')) continue;
    if (verifiedPackagePaths !== undefined && resolveVerifiedPackagePath(value, verifiedPackagePaths)) continue;
    throw new AgentWorkspaceRuntimeError(
      'design_output_not_self_contained',
      'index.html CSS references a non-inline resource',
    );
  }
  validateCssGeneratedContent(html);
  validateArtifactQuality(
    html,
    evidenceText,
    visibleTextOccurrenceConstraints,
    retention,
    verifiedPackagePaths !== undefined,
  );

  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${verifiedPackagePaths === undefined ? ARTIFACT_CSP : VERIFIED_PACKAGE_ARTIFACT_CSP}">`;
  const root = html.match(DOCUMENT_ROOT_RE);
  const head = html.slice(root![0].length).match(DOCUMENT_HEAD_RE);
  if (head) {
    const insertionIndex = root![0].length + head[0].length;
    return `${html.slice(0, insertionIndex)}${cspMeta}${html.slice(insertionIndex)}`;
  }
  return html.replace(DOCUMENT_ROOT_RE, (documentRoot) => `${documentRoot}<head>${cspMeta}</head>`);
}

function validateVerifiedPackagePaths(packagePaths: readonly string[]): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const candidate of packagePaths) {
    try {
      assertPublicArtifactPath(candidate);
    } catch {
      throw new AgentWorkspaceRuntimeError('design_output_invalid', 'verified package contains an invalid path');
    }
    if (paths.has(candidate)) {
      throw new AgentWorkspaceRuntimeError('design_output_invalid', 'verified package contains a duplicate path');
    }
    paths.add(candidate);
  }
  if (!paths.has('index.html')) {
    throw new AgentWorkspaceRuntimeError('design_output_missing', 'verified package has no index.html');
  }
  return paths;
}

function assertVerifiedPackageReference(
  tagName: string,
  attribute: string,
  rawValue: string,
  packagePaths: ReadonlySet<string>,
): void {
  const value = rawValue.trim();
  if (tagName === 'a' || tagName === 'area') {
    throw new AgentWorkspaceRuntimeError(
      'design_output_not_self_contained',
      'index.html links may only target a fragment in the current document',
    );
  }
  if (value.toLowerCase().startsWith('data:')) {
    if (attribute === 'src' && tagName !== 'script') return;
    throw new AgentWorkspaceRuntimeError(
      'design_output_not_self_contained',
      'index.html embeds an executable data resource in a disallowed position',
    );
  }
  if (!resolveVerifiedPackagePath(value, packagePaths)) {
    throw new AgentWorkspaceRuntimeError(
      'design_output_not_self_contained',
      `index.html references a resource outside the verified package from <${tagName}>`,
    );
  }
}

function resolveVerifiedPackagePath(rawValue: string, packagePaths: ReadonlySet<string>): string | undefined {
  let value = rawValue.trim();
  if (!value || value.startsWith('/') || value.includes('\\')) return undefined;
  const suffix = value.search(/[?#]/);
  if (suffix >= 0) value = value.slice(0, suffix);
  while (value.startsWith('./')) value = value.slice(2);
  try {
    value = decodeURIComponent(value);
    assertPublicArtifactPath(value);
  } catch {
    return undefined;
  }
  return value.startsWith('assets/') && packagePaths.has(value) ? value : undefined;
}

function validateCssGeneratedContent(html: string): void {
  let styleContentStart: number | undefined;
  for (const tag of iterateHtmlTags(html)) {
    if (tag.name.toLowerCase() !== 'style') continue;
    if (!tag.isClosing) {
      if (!tag.isSelfClosing) styleContentStart = tag.end;
      continue;
    }
    if (styleContentStart === undefined) continue;
    const css = html.slice(styleContentStart, tag.start).replace(/\/\*[\s\S]*?\*\//g, ' ');
    styleContentStart = undefined;
    for (const match of css.matchAll(/(?:^|[;{])\s*content\s*:\s*([^;}]+)/gi)) {
      const value = match[1].trim();
      if (/^(?:none|normal|["']\s*["'])$/i.test(value)) continue;
      const quoted = value.match(/^(["'])([\s\S]*)\1$/);
      if (quoted && !/[A-Za-z0-9\\\u3400-\u9fff]/u.test(quoted[2])) continue;
      throw new AgentWorkspaceRuntimeError(
        'design_output_quality_rejected',
        'index.html contains CSS-generated textual content',
      );
    }
  }
}

interface MeasuredClaimContext {
  token: string;
  context: string;
  requiresContext: boolean;
  isStructural: boolean;
  entityKeys: Set<string>;
}

interface MeasuredClaimIndex {
  byToken: Map<string, MeasuredClaimContext[]>;
  ids: Map<MeasuredClaimContext, number>;
}

function measuredClaimIdentity(claim: MeasuredClaimContext): string {
  return JSON.stringify([claim.token.toLowerCase(), claim.context, claim.requiresContext,
    claim.isStructural, [...claim.entityKeys].sort()]);
}

function indexMeasuredClaims(claims: readonly MeasuredClaimContext[]): MeasuredClaimIndex {
  const byToken = new Map<string, MeasuredClaimContext[]>();
  const ids = new Map<MeasuredClaimContext, number>();
  const identities = new Set<string>();
  for (const [ordinal, claim] of claims.entries()) {
    const identity = measuredClaimIdentity(claim);
    // Exact predicate-equivalent repetitions do not create different source
    // bindings. Keep the first frozen ordinal, never merge distinct contexts.
    if (identities.has(identity)) continue;
    identities.add(identity);
    ids.set(claim, ordinal);
    const token = claim.token.toLowerCase();
    const candidates = byToken.get(token) ?? [];
    candidates.push(claim);
    byToken.set(token, candidates);
  }
  return { byToken, ids };
}

function measuredClaimContexts(text: string): MeasuredClaimContext[] {
  const claims: MeasuredClaimContext[] = [];
  // Clock minutes are not standalone quantities: splitting "19:00 周六" at ':'
  // must not invent "0周". Mask only complete clock digits before segmentation,
  // retaining delimiters/offsets and using this same lexical boundary for both
  // source evidence and visible text. This does not establish clock fact support.
  const quantityText = text.replace(
    /(?<![\d:：])(?:[01]?\d|2[0-3])[:：][0-5]\d(?!\d|[:：]\d)/g,
    (clock) => clock.replace(/\d/g, ' '),
  );
  for (const segment of quantityText.split(/[\r\n。！？!?；;，,：:]+/)) {
    const segmentClaims: Array<MeasuredClaimContext & { offset: number; patternOrder: number }> = [];
    const patterns = [
      // 「1 个月」「2 个小时」是时长，与 MAP 的 HostedSiteRevisionRules 同口径，不当成「1 个（计数）」。
      { regex: /(?<![A-Za-z0-9_])(\d+(?:[.,]\d+)*)\s*(?:个\s*(?=月|小时))?(%|％|分钟|小时|天|周|月|年|万字|元|美元|人民币|KB|MB|GB)(?![A-Za-z])/gi, numberIndex: 1, unitIndex: 2 },
      { regex: /([￥¥$])\s*(\d+(?:[.,]\d+)*)/gi, numberIndex: 2, unitIndex: 1 },
      { regex: /(?<![A-Za-z0-9_])(\d+(?:[.,]\d+)*)\s*(个|条|次|篇|字|人|位|家|项|例|份|种|类|层|步|章|节|页)(?![A-Za-z])(?!\s*(?:月|小时))/gi, numberIndex: 1, unitIndex: 2 },
    ];
    for (const [patternOrder, pattern] of patterns.entries()) {
      for (const match of segment.matchAll(pattern.regex)) {
        const rawNumber = match[pattern.numberIndex];
        const parsed = Number(rawNumber.replaceAll(',', ''));
        const number = Number.isFinite(parsed) ? String(parsed) : rawNumber;
        const rawUnit = match[pattern.unitIndex];
        const requiresContext = isCountUnit(rawUnit);
        const entityKeys = extractClaimEntityKeys(segment, rawUnit);
        const unit = normalizeClaimUnit(rawUnit, entityKeys);
        segmentClaims.push({
          token: `${number}|${unit}`,
          context: normalizeClaimContext(segment),
          requiresContext,
          isStructural: requiresContext && isStructuralCount(segment),
          entityKeys,
          offset: match.index ?? 0,
          patternOrder,
        });
      }
    }
    segmentClaims.sort((left, right) => left.offset - right.offset || left.patternOrder - right.patternOrder);
    for (const { offset: _offset, patternOrder: _patternOrder, ...claim } of segmentClaims) claims.push(claim);
  }
  return claims;
}

const CONTROLLED_MEASURED_CLAIM_UNITS = new Set([
  '%', '分钟', '小时', '天', '周', '月', '年', '万字', 'KB', 'MB', 'GB', 'CNY', 'USD',
  '个', '条', '次', '字', '项', '例', '份', '种', '类', '层', '步',
  'PERSON', 'ARTICLE', 'ORGANIZATION', 'SECTION', 'PAGE', 'PROJECT', 'CUSTOMER', 'USER',
  'CONSUMER', 'READER', 'EMPLOYEE', 'CASE', 'MODULE', 'CATEGORY', 'OPERATION', 'COLUMN',
]);

function controlledMeasuredClaimToken(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 48) return undefined;
  const match = /^(?:0|[1-9]\d*)(?:\.\d+)?(.+)$/.exec(value);
  return match && CONTROLLED_MEASURED_CLAIM_UNITS.has(match[1]) ? value : undefined;
}

function normalizeClaimContext(value: string): string {
  return value.replace(
    /\d+(?:[.,]\d+)*|%|％|￥|¥|\$|分钟|小时|天|周|月|年|万字|元|美元|人民币|KB|MB|GB|个|条|次|篇|字|人|位|家|项|例|份|种|类|层|步|章|节|页|大约|约|只需|总共|预计|可达|达到|需要|耗时|时长|total|approximately|about|around/gi,
    '',
  );
}

function claimContextTokens(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const word of value.matchAll(/[A-Za-z][A-Za-z0-9_-]{2,}/g)) tokens.add(word[0].toLowerCase());
  const chinese = [...value].filter((character) => /[\u4e00-\u9fff]/.test(character)).join('');
  for (let index = 0; index + 1 < chinese.length; index += 1) tokens.add(chinese.slice(index, index + 2));
  return tokens;
}

function hasClaimContextOverlap(
  left: string,
  right: string,
  requiresContext: boolean,
  leftEntities: Set<string>,
  rightEntities: Set<string>,
): boolean {
  if (!requiresContext) return true;
  const comparableLeftEntities = new Set([...leftEntities].filter((key) => key !== 'PERSON'));
  const comparableRightEntities = new Set([...rightEntities].filter((key) => key !== 'PERSON'));
  if (requiresContext && comparableLeftEntities.size > 0 && comparableRightEntities.size > 0) {
    return [...comparableRightEntities].some((key) => comparableLeftEntities.has(key));
  }
  const leftTokens = claimContextTokens(left);
  if (leftTokens.size === 0) return !requiresContext;
  const rightTokens = claimContextTokens(right);
  if (rightTokens.size === 0) return false;
  const overlap = [...rightTokens].filter((token) => leftTokens.has(token)).length;
  return Math.min(leftTokens.size, rightTokens.size) <= 1 ? overlap === 1 : overlap >= 2;
}

function hasExplicitClaimEntityConflict(left: MeasuredClaimContext, right: MeasuredClaimContext): boolean {
  const leftEntities = [...left.entityKeys].filter((key) => key !== 'PERSON');
  const rightEntities = [...right.entityKeys].filter((key) => key !== 'PERSON');
  return leftEntities.length > 0 && rightEntities.length > 0
    && !leftEntities.some((key) => rightEntities.includes(key));
}

function alignsMeasuredClaim(source: MeasuredClaimContext, visible: MeasuredClaimContext): boolean {
  return source.token.toLowerCase() === visible.token.toLowerCase()
    && hasClaimContextOverlap(source.context, visible.context, visible.requiresContext, source.entityKeys, visible.entityKeys);
}

function normalizeClaimUnit(value: string, entityKeys: Set<string>): string {
  if (value === '％') return '%';
  if (value === '￥' || value === '¥' || value === '元' || value === '人民币') return 'CNY';
  if (value === '$' || value === '美元') return 'USD';
  if (value === '人' || value === '位' || (value === '个' && ['CUSTOMER', 'USER', 'CONSUMER', 'READER', 'EMPLOYEE'].some((key) => entityKeys.has(key)))) return 'PERSON';
  if (value === '篇' || (value === '个' && entityKeys.has('ARTICLE'))) return 'ARTICLE';
  if (value === '家' || (value === '个' && entityKeys.has('ORGANIZATION'))) return 'ORGANIZATION';
  if (value === '章' || value === '节' || (value === '个' && entityKeys.has('SECTION'))) return 'SECTION';
  if (value === '页') return 'PAGE';
  if (value === '个' && entityKeys.size === 1) return [...entityKeys][0];
  return value.toUpperCase();
}

function isCountUnit(unit: string): boolean {
  return new Set(['个', '条', '次', '篇', '字', '人', '位', '家', '项', '例', '份', '种', '类', '层', '步', '章', '节', '页']).has(unit);
}

function isStructuralCount(segment: string): boolean {
  return /(?:第\s*\d+\s*(?:步|章|节)(?:\b|。|，|,|：|:|$))|(?:(?:本文|本页|下文|以下|使用方式|操作流程|阅读路径|页面内容)[^\r\n。！？!?；;]{0,16}(?:分为|包括|包含|共有)\s*\d+(?:[.,]\d+)*\s*(?:个|条|项|种|类|层|步|章|节)?\s*(?:步骤|阶段|部分|章节|要点|原则|方式|层级|类别|模块|区块|栏目|操作)(?:\b|。|，|,|：|:|$))/i.test(segment);
}

function extractClaimEntityKeys(segment: string, unit: string): Set<string> {
  const keys = new Set<string>();
  for (const [key, pattern] of [
    ['PROJECT', /项目/],
    ['CUSTOMER', /客户/],
    ['USER', /用户/],
    ['CONSUMER', /消费者/],
    ['READER', /读者/],
    ['EMPLOYEE', /员工|成员/],
    ['CASE', /案例|样例/],
    ['ARTICLE', /文章|文档|知识|内容/],
    ['MODULE', /模块|功能/],
    ['CATEGORY', /类别|分类|种类/],
    ['OPERATION', /操作|流程|步骤/],
    ['SECTION', /章节|章|节/],
    ['COLUMN', /栏目|专栏/],
    ['ORGANIZATION', /企业|公司|机构|商家/],
  ] as const) {
    if (pattern.test(segment)) keys.add(key);
  }
  if (unit === '人' || unit === '位') keys.add('PERSON');
  if (unit === '篇') keys.add('ARTICLE');
  if (unit === '章' || unit === '节') keys.add('SECTION');
  if (unit === '家') keys.add('ORGANIZATION');
  if (unit === '页') keys.add('PAGE');
  return keys;
}

function validateArtifactQuality(
  html: string,
  evidenceText: string,
  visibleTextOccurrenceConstraints: readonly VisibleTextOccurrenceConstraint[],
  retention?: MeasuredFactRetentionState,
  allowScriptedControls = false,
): void {
  let bodyContentStart: number | undefined;
  let bodyContentEnd: number | undefined;
  for (const tag of iterateHtmlTags(html)) {
    if (tag.name.toLowerCase() !== 'body') continue;
    if (!tag.isClosing && bodyContentStart === undefined) bodyContentStart = tag.end;
    else if (tag.isClosing && bodyContentStart !== undefined) {
      bodyContentEnd = tag.start;
      break;
    }
  }
  if (bodyContentStart === undefined || bodyContentEnd === undefined) {
    throw new AgentWorkspaceRuntimeError('design_output_quality_rejected', 'index.html contains no explicit body element');
  }
  const visible = extractVisibleHtmlText(html.slice(bodyContentStart, bodyContentEnd));
  if (!visible) {
    throw new AgentWorkspaceRuntimeError('design_output_quality_rejected', 'index.html contains no visible content');
  }
  if (/(?:图|图片|图示|插图|截图|内容|文案|数据|此处|位置)\s*(?:仍|仅|为|是|[:：·—-])?\s*占位|占位\s*(?:图|图片|图示|插图|截图|内容|文案|数据|[:：·—-])|待\s*(?:补充|替换|填写|完善)|\blorem\s+ipsum\b|\b(?:todo|tbd)\b/i.test(visible)) {
    throw new AgentWorkspaceRuntimeError('design_output_quality_rejected', 'index.html contains visible placeholder or unfinished content');
  }
  // 起始页是一张清空了占位文案的模板，模型一字未改地交回来时，它的可见文字只剩一个版权符号，
  // 「有没有可见内容」那条判据放它过去，于是整条链路全绿、用户拿到一张空页
  // （2026-09-20 第八条 run 实测，比失败更糟的那种成功）。
  // 判据取模板正文里那段「把版式粘到这里」的指示注释：真做过的页面会把 <main> 的内容整段换掉，
  // 它留不下来；留着就是确证「起始页原样交回」。比「可见文字少于 N 个字」准，也不会误伤小页面。
  // MAP 落库前会拒收任何残留的 `[REPLACE]`（HostedSiteRevision 的
  // EnsureNoUnresolvedTemplatePlaceholders）。同一条判据前移到这里，模型才有 4 轮修复机会
  // 把漏掉的槽填掉；此前 CDS 不查，漏几个就直接撞上 MAP 的硬拒，一次生成全废。
  // 口径与 MAP 一致：先去掉注释与 <style>，再找 `[ replace ]`。
  const sentinelMarkup = html.replace(/<!--[\s\S]*?-->|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  const sentinels = [...sentinelMarkup.matchAll(/\[\s*replace\s*\][^<\n]{0,40}/gi)]
    .map((match) => match[0].trim());
  if (sentinels.length > 0) {
    throw new AgentWorkspaceRuntimeError(
      'design_output_quality_rejected',
      'index.html still contains unreplaced template placeholders',
      false,
      { placeholderCount: sentinels.length, placeholderSamples: sentinels.slice(0, 12) },
    );
  }
  if (html.includes(TEMPLATE_UNTOUCHED_MARKER)) {
    throw new AgentWorkspaceRuntimeError(
      'design_output_quality_rejected',
      'index.html is still the untouched starter template',
    );
  }
  for (const [index, constraint] of visibleTextOccurrenceConstraints.entries()) {
    const actualOccurrences = countLiteralOccurrences(visible, constraint.text);
    if (
      actualOccurrences >= constraint.minOccurrences
      && actualOccurrences <= constraint.maxOccurrences
    ) continue;
    throw new AgentWorkspaceRuntimeError(
      'design_output_quality_rejected',
      'index.html violates a visible text occurrence constraint',
      false,
      {
        qualityViolationFingerprint: crypto.createHash('sha256').update(constraint.text).digest('hex'),
        constraintOrdinal: index + 1,
        actualOccurrences,
        minOccurrences: constraint.minOccurrences,
        maxOccurrences: constraint.maxOccurrences,
      },
    );
  }

  const maxQualityTargets = 4_096;
  const maxMissingLinkOrdinals = 256;
  const targets = new Set<string>();
  const popoverTargets = new Set<string>();
  let hasScript = false;
  for (const tag of iterateHtmlTags(html)) {
    if (tag.isClosing) continue;
    if (tag.name.toLowerCase() === 'script') hasScript = true;
    const attributes = tag.attributes;
    const target = decodeHtmlText((readHtmlAttribute(attributes, 'id') ?? readHtmlAttribute(attributes, 'name') ?? '').trim());
    if (target) {
      targets.add(target);
      if (hasHtmlAttribute(attributes, 'popover')) popoverTargets.add(target);
      if (targets.size > maxQualityTargets) {
        throw new AgentWorkspaceRuntimeError(
          'design_output_quality_rejected',
          'index.html contains too many fragment targets to validate safely',
        );
      }
    }
  }
  const missingFragments = new Map<string, number[]>();
  // 空链接此前是「撞上第一个就抛」，而且什么都不告诉模型：既没有位置也没有条数。
  // 于是四轮修复全是盲修——2026-09-20 实测连着两条 run 都这么死的。改成和缺失锚点
  // 同一套口径：整篇收齐，抛的时候带上文档序号与总数。抛哪一条消息仍按文档顺序的
  // 第一条决定，precedence 逐字不变。
  const brokenAnchors: Array<{ ordinal: number; kind: 'missing' | 'empty' }> = [];
  // 按钮同理：此前也是撞上第一个就抛、不说位置不说条数。2026-09-20 实测空链接那条修好之后
  // 立刻撞上这条，模型同样是盲修。收齐再报，口径与锚点一致。
  const inertButtons: number[] = [];
  let buttonOrdinal = 0;
  let anchorOrdinal = 0;
  // precedence 必须按**文档顺序**判，不能拿「第 N 个按钮」去比「第 N 个锚点」——
  // 那是两条各自独立的计数，比出来的先后与页面里的先后无关。共用一条位置序列决定谁先报，
  // 报给模型的仍是各自的同类序号（模型数的是「第几个 <a>」「第几个 <button>」）。
  let documentPosition = 0;
  let firstInertButtonPosition = Number.POSITIVE_INFINITY;
  let firstBrokenAnchorPosition = Number.POSITIVE_INFINITY;
  let retainedMissingLinkOrdinals = 0;
  for (const tag of iterateHtmlTags(html)) {
    if (tag.isClosing) continue;
    documentPosition += 1;
    const tagName = tag.name.toLowerCase();
    if (tagName === 'button') {
      const attributes = tag.attributes;
      buttonOrdinal += 1;
      if (hasHtmlAttribute(attributes, 'disabled')) continue;
      const popoverTarget = readHtmlAttribute(attributes, 'popovertarget')?.trim();
      if (popoverTarget && popoverTargets.has(popoverTarget)) continue;
      if (allowScriptedControls && hasScript) continue;
      if (inertButtons.length < maxMissingLinkOrdinals) inertButtons.push(buttonOrdinal);
      firstInertButtonPosition = Math.min(firstInertButtonPosition, documentPosition);
      continue;
    }
    if (tagName !== 'a') continue;
    anchorOrdinal += 1;
    const href = readHtmlAttribute(tag.attributes, 'href');
    if (href === undefined) {
      if (brokenAnchors.length < maxMissingLinkOrdinals) brokenAnchors.push({ ordinal: anchorOrdinal, kind: 'missing' });
      firstBrokenAnchorPosition = Math.min(firstBrokenAnchorPosition, documentPosition);
      continue;
    }
    const normalized = href?.trim() ?? '';
    if (!normalized || normalized === '#') {
      if (brokenAnchors.length < maxMissingLinkOrdinals) brokenAnchors.push({ ordinal: anchorOrdinal, kind: 'empty' });
      firstBrokenAnchorPosition = Math.min(firstBrokenAnchorPosition, documentPosition);
      continue;
    }
    if (normalized.startsWith('#')) {
      let fragment: string;
      try {
        fragment = decodeURIComponent(normalized.slice(1));
      } catch {
        throw new AgentWorkspaceRuntimeError('design_output_quality_rejected', 'index.html contains a malformed fragment target');
      }
      if (!fragment || !targets.has(fragment)) {
        const ordinals = missingFragments.get(fragment) ?? [];
        if (retainedMissingLinkOrdinals < maxMissingLinkOrdinals) {
          ordinals.push(anchorOrdinal);
          retainedMissingLinkOrdinals += 1;
        }
        missingFragments.set(fragment, ordinals);
        if (missingFragments.size > maxQualityTargets) {
          throw new AgentWorkspaceRuntimeError(
            'design_output_quality_rejected',
            'index.html contains too many missing fragment targets to report safely',
          );
        }
      }
    }
  }
  // 逐个抛的年代，谁在标签流里先出现谁先抛。这里按同一条位置序列还原那个顺序。
  if (inertButtons.length > 0 && firstInertButtonPosition <= firstBrokenAnchorPosition) {
    throw new AgentWorkspaceRuntimeError(
      'design_output_quality_rejected',
      'index.html contains an enabled button without provable declarative behavior',
      false,
      { inertButtonCount: inertButtons.length, inertButtonOrdinals: inertButtons.slice(0, 24) },
    );
  }
  if (brokenAnchors.length > 0) {
    // 抛哪一条按文档顺序的第一条决定（与逐个抛时完全一致），报的序号只列同一类的。
    const kind = brokenAnchors[0].kind;
    const ordinals = brokenAnchors.filter((entry) => entry.kind === kind).map((entry) => entry.ordinal);
    throw new AgentWorkspaceRuntimeError(
      'design_output_quality_rejected',
      kind === 'missing'
        ? 'index.html contains a link without a target'
        : 'index.html contains an empty link target',
      false,
      { brokenLinkCount: ordinals.length, brokenLinkOrdinals: ordinals.slice(0, 24) },
    );
  }
  if (inertButtons.length > 0) {
    throw new AgentWorkspaceRuntimeError(
      'design_output_quality_rejected',
      'index.html contains an enabled button without provable declarative behavior',
      false,
      { inertButtonCount: inertButtons.length, inertButtonOrdinals: inertButtons.slice(0, 24) },
    );
  }
  if (missingFragments.size > 0) {
    const normalizedFragments = Array.from(missingFragments.keys()).sort();
    const missingLinkOrdinals = Array.from(missingFragments.values()).flat().sort((left, right) => left - right);
    const qualityViolationFingerprint = crypto
      .createHash('sha256')
      .update(JSON.stringify(normalizedFragments))
      .digest('hex');
    throw new AgentWorkspaceRuntimeError(
      'design_output_quality_rejected',
      `index.html contains ${missingFragments.size} missing fragment target(s)`,
      false,
      {
        qualityViolationFingerprint,
        missingFragmentCount: missingFragments.size,
        missingLinkOrdinals,
      },
    );
  }

  const supportedClaims = retention?.supportedClaims ?? indexMeasuredClaims(measuredClaimContexts(evidenceText));
  const authoritativeClaims = retention?.authoritativeClaims ?? supportedClaims;
  const retainedFacts = retention?.facts;
  const visibleClaims = measuredClaimContexts(visible);
  const analysis = new Map<string, { claim: MeasuredClaimContext; ordinal: number;
    sourceCandidates: MeasuredClaimContext[]; aligned: boolean; binding: MeasuredClaimContext[] }>();
  for (const [ordinal, claim] of visibleClaims.entries()) {
    const identity = measuredClaimIdentity(claim);
    if (analysis.has(identity)) continue;
    const token = claim.token.toLowerCase();
    const candidates = (supportedClaims.byToken.get(token) ?? [])
      .filter((candidate) => !hasExplicitClaimEntityConflict(candidate, claim));
    const aligned = candidates.some((candidate) => alignsMeasuredClaim(candidate, claim));
    const sourceCandidates = (authoritativeClaims.byToken.get(token) ?? [])
      .filter((candidate) => !hasExplicitClaimEntityConflict(candidate, claim));
    const sourceAligned = sourceCandidates.filter((candidate) => alignsMeasuredClaim(candidate, claim));
    analysis.set(identity, { claim, ordinal, sourceCandidates, aligned,
      binding: sourceAligned.length > 0 ? sourceAligned : sourceCandidates });
  }
  // Capture all eligible claims before reporting the first failure, so one repair
  // cannot silently erase a later fact. An invented value never becomes required.
  const analyzedClaims = [...analysis.values()];
  for (const { claim, sourceCandidates, binding } of analyzedClaims) {
    if (claim.isStructural || sourceCandidates.length === 0 || !retainedFacts) continue;
    const key = `${claim.token.toLowerCase()}:${binding.map((candidate) => authoritativeClaims.ids.get(candidate)).join(',')}`;
    if (!retainedFacts.has(key)) retainedFacts.set(key, { token: claim.token, candidates: binding });
  }
  for (const { ordinal, claim, sourceCandidates, aligned } of analyzedClaims) {
    if (claim.isStructural || aligned) continue;
    const [number, unit] = claim.token.split('|');
    const measuredClaimToken = `${number}${unit}`;
    throw new AgentWorkspaceRuntimeError(
      'design_output_quality_rejected',
      sourceCandidates.length > 0
        ? 'index.html contains a measured claim with unresolved source context'
        : `index.html contains an unsupported measured claim: ${measuredClaimToken}`,
      false,
      {
        measuredClaimOrdinal: ordinal + 1,
        measuredClaimToken,
      },
    );
  }
  for (const retained of retainedFacts?.values() ?? []) {
    if (analyzedClaims.some(({ claim }) => !claim.isStructural
      && retained.candidates.some((candidate) => alignsMeasuredClaim(candidate, claim)))) continue;
    throw new AgentWorkspaceRuntimeError(
      'design_output_quality_rejected',
      'index.html dropped a retained source-backed measured claim',
      false,
      { measuredClaimToken: retained.token.replace('|', '') },
    );
  }
  const supportedFacts = sensitiveFacts(evidenceText);
  for (const fact of sensitiveFacts(visible)) {
    if (supportedFacts.has(fact)) continue;
    throw new AgentWorkspaceRuntimeError('design_output_quality_rejected', `index.html contains an unsupported date, contact, or URL: ${fact}`);
  }
}

function sensitiveFacts(text: string): Set<string> {
  const facts = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:19|20)\d{2}[-/.]\d{1,2}(?:[-/.]\d{1,2})?\b|(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)|(?<!\d)0\d{2,3}-?\d{7,8}(?!\d)/gi)) {
    facts.add(match[0].replace(/[.,;:，。；：)\]}>`]+$/g, '').toLowerCase());
  }
  return facts;
}

export function collectArtifactQualityEvidence(workspaceDir: string, includeUserSuppliedTask = true): string {
  const evidence: string[] = [];
  const taskPath = path.join(workspaceDir, 'brief', 'task.json');
  if (includeUserSuppliedTask && fs.existsSync(taskPath)) {
    try {
      const task = JSON.parse(fs.readFileSync(taskPath, 'utf8')) as Record<string, unknown>;
      for (const key of ['title', 'instruction']) {
        if (typeof task[key] === 'string') evidence.push(task[key] as string);
      }
    } catch {
      throw new AgentWorkspaceRuntimeError('workspace_package_invalid', 'brief/task.json is not valid JSON');
    }
  }
  const knowledgeDir = path.join(workspaceDir, 'knowledge');
  if (fs.existsSync(knowledgeDir)) {
    for (const entry of fs.readdirSync(knowledgeDir, { withFileTypes: true }).filter((item) => item.isFile())) {
      evidence.push(fs.readFileSync(path.join(knowledgeDir, entry.name), 'utf8'));
    }
  }
  const currentPath = path.join(workspaceDir, 'current', 'index.html');
  if (fs.existsSync(currentPath)) evidence.push(extractVisibleHtmlText(fs.readFileSync(currentPath, 'utf8')));
  return evidence.join('\n');
}

export function collectVisibleTextOccurrenceConstraints(workspaceDir: string): VisibleTextOccurrenceConstraint[] {
  const taskPath = path.join(workspaceDir, 'brief', 'task.json');
  if (!fs.existsSync(taskPath)) return [];
  try {
    const task = JSON.parse(fs.readFileSync(taskPath, 'utf8')) as Record<string, unknown>;
    const quality = task.qualityContract;
    if (!quality || typeof quality !== 'object' || Array.isArray(quality)) {
      throw new Error('quality contract missing');
    }
    return parseVisibleTextOccurrenceConstraints(
      (quality as Record<string, unknown>).visibleTextOccurrenceConstraints,
    );
  } catch (error) {
    if (error instanceof AgentWorkspaceRuntimeError) throw error;
    throw new AgentWorkspaceRuntimeError('workspace_package_invalid', 'brief/task.json is not valid JSON');
  }
}

export function parseVisibleTextOccurrenceConstraints(value: unknown): VisibleTextOccurrenceConstraint[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12) {
    throw new AgentWorkspaceRuntimeError(
      'workspace_quality_contract_unsupported',
      'brief/task.json qualityContract.visibleTextOccurrenceConstraints is unsupported',
    );
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new AgentWorkspaceRuntimeError(
        'workspace_quality_contract_unsupported',
        'brief/task.json qualityContract.visibleTextOccurrenceConstraints is unsupported',
      );
    }
    const rule = item as Record<string, unknown>;
    const text = typeof rule.text === 'string' ? rule.text.trim().replace(/\s+/g, ' ') : '';
    if (
      text.length < 4
      || text.length > 200
      || rule.minOccurrences !== 1
      || rule.maxOccurrences !== 1
      || seen.has(text)
    ) {
      throw new AgentWorkspaceRuntimeError(
        'workspace_quality_contract_unsupported',
        'brief/task.json qualityContract.visibleTextOccurrenceConstraints is unsupported',
      );
    }
    seen.add(text);
    return { text, minOccurrences: 1, maxOccurrences: 1 };
  });
}

function countLiteralOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index < 0) break;
    count += 1;
    cursor = index + needle.length;
  }
  return count;
}

function convertRelativeKnowledgeAnchors(html: string): string {
  const quoted = /<a\b[^>]*\bhref\s*=\s*(["'])(\.\/[A-Za-z0-9_./-]+(?:#[A-Za-z0-9_.:-]+)?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi;
  const unquoted = /<a\b[^>]*\bhref\s*=\s*(\.\/[A-Za-z0-9_./-]+(?:#[A-Za-z0-9_.:-]+)?)[^\s"'`=<>]*[^>]*>([\s\S]*?)<\/a\s*>/gi;
  const replace = (_match: string, value: string, body: string): string => {
    if (/(?:^|\/)\.\.(?:\/|$)/.test(value)) return _match;
    return `<span data-cds-source-reference="${value}">${body}</span>`;
  };
  return html
    .replace(quoted, (_match, _quote: string, value: string, body: string) => replace(_match, value, body))
    .replace(unquoted, (_match, value: string, body: string) => replace(_match, value, body));
}
