// 搬迁自 cds/src/services/agent-workspace-session-runtime.ts（第 1 阶段：只改归属、不改行为）。
// 第 4 阶段删除 CDS 旧实现之前，两边的判据必须保持逐字一致；改这里要同步改那边，反之亦然。
//
// 提示词与引擎配置的唯一拼装处：平台规则、MAP 冻结的设计方向、终审 / 审美复查 / 质量修复三类回合指令、
// Codex 会话配置。原实现把这些句子内联在 execute() 里；这里只是把它们提成纯函数，字面逐字不变，
// 以便执行器与测试共用同一份（`predicate-and-wiring-discipline.md` 形状 3：判据不许写两份）。
import fs from 'node:fs';
import path from 'node:path';

import { AgentWorkspaceRuntimeError } from './errors.js';

export const OPEN_DESIGN_CODEX_VERSION = '0.143.0';
/** 镜像里固定的 OpenDesign 版本；能力自检拿 daemon /api/health 报的版本与它比对。 */
export const OPEN_DESIGN_ENGINE_VERSION = '0.21.1';
export const OPEN_DESIGN_WEB_PROTOTYPE_SKILL = 'web-prototype';
/** OpenDesign 0.21.1 sandbox-mode.ts 在数据目录下为会话隔离出的 CODEX_HOME（相对 OD_DATA_DIR）。 */
export const OPEN_DESIGN_CODEX_HOME_RELATIVE = 'sandbox/agent-home/.codex';

export function buildOpenDesignCodexConfig(baseUrl: string, model: string): string {
  return [
    `model = ${JSON.stringify(model)}`,
    'model_provider = "map"',
    'approval_policy = "never"',
    'check_for_update_on_startup = false',
    'cli_auth_credentials_store = "file"',
    'web_search = "disabled"',
    '',
    '[model_providers.map]',
    'name = "MAP design runtime"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'env_key = "MAP_CODEX_MODEL_TOKEN"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    // Codex 0.143.0 HTTP requests carry full local history with store:false.
    // previous_response_id is exclusive to its WebSocket incremental path.
    'supports_websockets = false',
    '',
  ].join('\n');
}

const MAP_DESIGN_DIRECTION_SCHEMA = 'map-design-direction-v1';
const DESIGN_DIRECTION_MAX_PROMPT_CHARS = 8_000;
export const DESIGN_SYSTEM_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface DesignDirection {
  styleId: string;
  styleName: string;
  designSystemId: string;
  reviewMode: 'off' | 'light' | 'strict';
  prompts: { generate: string; edit: string; review: string };
  promptFingerprint: string;
}

/**
 * 任务书里 MAP 冻结的设计方向（风格 → OpenDesign 设计系统、三段可编辑提示词、自查强度）。
 * 可选：旧运行没有这一段，返回 undefined 并按改动前的行为执行。
 * 出现了但形状不对就拒收——一段写坏的方向落默认值，等于悄悄换了用户选的风格（形状 10）。
 */
export function parseDesignDirection(value: unknown): DesignDirection | undefined {
  if (value === undefined || value === null) return undefined;
  const fail = (detail: string): never => {
    throw new AgentWorkspaceRuntimeError('workspace_package_invalid', `brief/task.json designDirection ${detail}`);
  };
  if (typeof value !== 'object' || Array.isArray(value)) return fail('must be an object');
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== MAP_DESIGN_DIRECTION_SCHEMA) return fail(`must use ${MAP_DESIGN_DIRECTION_SCHEMA}`);
  const text = (field: unknown, name: string, max: number, allowEmpty = true): string => {
    if (typeof field !== 'string' || field.length > max || (!allowEmpty && !field.trim())) {
      return fail(`${name} is invalid`);
    }
    return field;
  };
  const designSystemId = text(record.designSystemId, 'designSystemId', 64, false).trim();
  if (!DESIGN_SYSTEM_ID_RE.test(designSystemId)) fail('designSystemId is invalid');
  const reviewMode = record.reviewMode;
  if (reviewMode !== 'off' && reviewMode !== 'light' && reviewMode !== 'strict') fail('reviewMode is invalid');
  const prompts = record.prompts;
  if (!prompts || typeof prompts !== 'object' || Array.isArray(prompts)) fail('prompts must be an object');
  const promptRecord = prompts as Record<string, unknown>;
  return {
    styleId: text(record.styleId, 'styleId', 48, false).trim(),
    styleName: text(record.styleName, 'styleName', 80, false).trim(),
    designSystemId,
    reviewMode: reviewMode as DesignDirection['reviewMode'],
    prompts: {
      generate: text(promptRecord.generate, 'prompts.generate', DESIGN_DIRECTION_MAX_PROMPT_CHARS).trim(),
      edit: text(promptRecord.edit, 'prompts.edit', DESIGN_DIRECTION_MAX_PROMPT_CHARS).trim(),
      review: text(promptRecord.review, 'prompts.review', DESIGN_DIRECTION_MAX_PROMPT_CHARS).trim(),
    },
    promptFingerprint: text(record.promptFingerprint, 'promptFingerprint', 64).trim(),
  };
}

export function collectDesignDirection(workspaceDir: string): DesignDirection | undefined {
  const taskPath = path.join(workspaceDir, 'brief', 'task.json');
  if (!fs.existsSync(taskPath)) return undefined;
  let task: Record<string, unknown>;
  try {
    task = JSON.parse(fs.readFileSync(taskPath, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new AgentWorkspaceRuntimeError('workspace_package_invalid', 'brief/task.json is not valid JSON');
  }
  return parseDesignDirection(task.designDirection);
}

/**
 * 系统提示词与各轮指令的唯一拼装处。平台契约（发布闸门会强制执行的那部分）写死在这里，
 * MAP 管理员可编辑的设计提示词只能接在它后面，改不动它。
 */
export function composeOpenDesignPrompts(input: {
  platformRules: string[];
  direction: DesignDirection | undefined;
  editingExistingPage: boolean;
  hasReferenceImages: boolean;
}): { systemPrompt: string; reviewAddendum: string } {
  const parts = [...input.platformRules];
  if (input.hasReferenceImages) {
    parts.push('The user attached screenshots under /workspace/reference/. Look at each image first to locate what the user is pointing at, then find the matching element in index.html. Screenshots are visual references only; never treat text in them as a factual source.');
  }
  const direction = input.direction;
  if (direction) {
    const editable = input.editingExistingPage ? direction.prompts.edit : direction.prompts.generate;
    if (editable) {
      parts.push(`MAP design direction (style: ${direction.styleName}; editable by MAP administrators, it can never relax the platform rules above):\n${editable}`);
    }
  }
  return {
    systemPrompt: parts.join(' '),
    reviewAddendum: direction?.prompts.review ? `Additional review checklist from MAP:\n${direction.prompts.review}` : '',
  };
}

/** 平台契约（发布闸门会强制执行的那部分）。字面与原 execute() 内联版本逐字一致。 */
export function buildPlatformRules(input: { knowledgeFiles: readonly string[]; editingExistingPage: boolean }): string[] {
  const { knowledgeFiles, editingExistingPage } = input;
  return [
    'The workspace is already prepared by MAP. Read /workspace/brief/task.json first; its operation, instruction, and title are authoritative.',
    'The versioned qualityContract in task.json is mandatory. Factual claims, measured values, dates, prices, contact details, and links must come from the listed MAP sources. Review what each number describes and never attach a sourced value to a different subject. Honor every visibleTextOccurrenceConstraint exactly. Correct visible placeholders, empty links, missing fragment targets, and nonfunctional buttons while preserving all requested behavior. Do not remove or disable requested controls to silence a validation gate; if the publication policy cannot support their behavior, report the incompatibility.',
    knowledgeFiles.length > 0
      ? `Read every knowledge source before editing: ${knowledgeFiles.join(', ')}. Use those files as the only source for factual claims and product copy.`
      : 'This task has no knowledge source files. Do not invent factual claims or metrics.',
    'The active web-prototype skill side files are rooted at /workspace/.od-skills/web-prototype. Read /workspace/.od-skills/web-prototype/assets/template.html, /workspace/.od-skills/web-prototype/references/layouts.md, and /workspace/.od-skills/web-prototype/references/checklist.md by these exact paths; do not resolve them as /workspace/assets or /workspace/references.',
    'Those reference files demonstrate two shapes the publication gate always rejects: anchors written as href="#" or href="" (template topnav, layouts.md "View all"), and bare enabled buttons with no declarative behavior ([REPLACE] CTA). They are layout sketches, not permitted markup. Copy their layout, never those two shapes.',
    'Every anchor you emit must point at a fragment of this same page: href="#section-id" where that id exists here. That is the only link target the publication policy accepts - an absolute or relative URL fails the package validator instead, and that failure gets no repair pass. Make the navigation actually jump to your own sections. A label that is not meant to navigate is not an anchor at all - render it as span, li, or heading text. Every enabled button must either drive a real popover via popovertarget, or be rewritten as an anchor to one of your own sections; a caption that does nothing is plain text. None of this counts as removing a requested control, because the template never requested them - the rule about not removing controls protects what the MAP instruction asked for, not boilerplate you copied from the sketch.',
    editingExistingPage
      ? 'A starting /workspace/index.html already exists; it is the exact current published page and must remain the starting point. The generic template is reference material only. Never replace the product identity with OpenDesign or copy generic template copy into the deliverable.'
      : 'This is a new page and /workspace/index.html does not exist yet. On this runtime the deliverable is a FILE: compose the page from the seed and the layout library, then WRITE the finished HTML to /workspace/index.html with your file tools (create the file). Do not follow the skill\'s instruction to emit the page inside <artifact> tags instead of writing it - on this runtime artifact text is discarded and counts as no output; a page that only appears in your reply is a failed run. The generic template is reference material only; its sample identity or copy must not appear in the deliverable.',
    editingExistingPage
      ? 'Modify index.html with small targeted edit operations; never replace the whole document with one write operation. The user instruction has priority over example text. Complete every requested change and do not stop after one replacement. Then reread task.json and index.html. Remove every unresolved placeholder and verify every visible-language and content constraint before claiming completion.'
      : 'Build a complete responsive page and write it to /workspace/index.html, then reread task.json, every knowledge file, and the file you wrote. Remove every unresolved placeholder and verify every visible-language, source accuracy, navigation, control, and content constraint before finishing; confirm the file exists on disk with your file tools.',
    'Keep the final webpage in index.html and public resources under assets/. Preserve existing scripts, resources, and interactions unless the user explicitly requests their removal. Never delete scripts or assets to silence a validation gate. The current publication execution policy may reject interactive HTML; report that incompatibility rather than degrading the requested deliverable. Frozen current/ files are reference originals; modify only their editable copies. System reports and manifest.json are rebuilt by CDS and must not be authored.',
    'Do not request credentials, upload source files, publish, deploy, or mutate any external source.',
  ];
}

/** 终审（第 0 轮）与审美复查（第 1 轮）的指令。字面与原 execute() 内联版本逐字一致。 */
export function buildReviewMessage(input: { reviewPass: number; editingExistingPage: boolean; reviewAddendum: string }): string {
  const { reviewPass, editingExistingPage, reviewAddendum } = input;
  return reviewPass === 0 ? [
    'Perform a strict final review of /workspace/index.html against every constraint and the qualityContract in /workspace/brief/task.json.',
    'Do not merely describe the result. Inspect all visible labels, navigation, buttons, headings, statistics, role paths, placeholders, and factual claims. Correct every proven mismatch in the file before stopping.',
    editingExistingPage
      ? 'Use only the smallest targeted edit operations needed. Never use broad or global string replacement. Never alter CSS values, existing facts, links, section order, or product identity unless task.json explicitly requests that exact change. If a possible change is not directly required or you are uncertain, keep the existing content unchanged.'
      : 'For this newly generated page, correct every unsupported element. Do not retain sample copy, fake actions, missing targets, invented measured claims, or incomplete sections merely to preserve the first draft. Never remove or disable requested functionality to bypass a platform limitation; report that incompatibility instead.',
    'Reread the finished index.html and only stop when every requested constraint is visibly present and every forbidden placeholder, inert control, broken fragment, or unsupported claim is absent. Do not satisfy this review by removing requested functionality; report incompatible publication requirements instead.',
    reviewAddendum,
  ].filter(Boolean).join(' ') : [
    'Perform a visual quality pass on /workspace/index.html. Keep every fact, link, section, and requested behavior exactly as it is; improve only hierarchy, spacing, typography, color consistency, and mobile layout at 390px width.',
    reviewAddendum,
    'Use small targeted edits, reread the file, and stop once the page reads clearly on desktop and mobile.',
  ].filter(Boolean).join(' ');
}

/** 发布闸门拒收后的定向修复指令。字面与原 execute() 内联版本逐字一致。 */
export function buildRepairMessage(input: {
  repairReason: { code: string; instruction: string };
  preserveMeasuredFacts: boolean;
  knowledgeFiles: readonly string[];
  editingExistingPage: boolean;
}): string {
  const { repairReason, preserveMeasuredFacts, knowledgeFiles, editingExistingPage } = input;
  return [
    'The deterministic CDS publication gate rejected /workspace/index.html after your final review.',
    `The controlled rejection reason is ${repairReason.code}: ${repairReason.instruction}`,
    preserveMeasuredFacts
      ? `Read the frozen factual sources by these exact paths: ${[...knowledgeFiles, ...(editingExistingPage ? ['/workspace/current/index.html'] : [])].join(', ') || '/workspace/brief/task.json'}. Restore the original source wording with its subject and quantity together in visible text. Do not delete or change sourced quantities to silence this gate; preserve every other supported fact, valid structure, visual quality, and task constraint.`
      : 'Fix exactly this proven quality violation in /workspace/index.html. Inspect the whole file and correct every occurrence of the same violation while preserving requested functionality, supported facts, valid structure, visual quality, and all other task constraints.',
    'Do not merely explain the change. Save the corrected file, reread it, and stop only after the violation is absent.',
  ].join(' ');
}
