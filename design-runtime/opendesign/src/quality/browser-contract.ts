import { BROWSER_HARD_GATE_AUTHORING_RULE } from '../prompts.js';

export const BROWSER_QUALITY_SCHEMA = 'map-browser-quality-evidence-v1';
export const BROWSER_QUALITY_FAILURE_SCHEMA = 'map-browser-quality-failure-evidence-v1';
export const BROWSER_QUALITY_RULE_VERSION = 'browser-hard-gate-v1';
export const BROWSER_QUALITY_HEURISTIC_VERSION = 'browser-aesthetic-heuristic-v1';
export const MAX_BROWSER_REPAIR_ATTEMPTS = 2;
export const BROWSER_CHECK_TIMEOUT_MS = 45_000;

export const BROWSER_QUALITY_VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

export type BrowserQualityViewportName = typeof BROWSER_QUALITY_VIEWPORTS[number]['name'];
export type BrowserQualityIssueCode =
  | 'horizontal_overflow'
  | 'main_content_clipped'
  | 'primary_cta_clipped'
  | 'empty_link'
  | 'broken_fragment_target'
  | 'mobile_navigation_unusable'
  | 'table_unreadable'
  | 'key_text_contrast_low'
  | 'presentation_page_count_mismatch'
  | 'presentation_navigation_unusable'
  | 'presentation_text_too_small'
  | 'presentation_fixed_overlay_obscures_content';

export interface BrowserElementSummary {
  tag: string;
  id?: string;
  role?: string;
  label?: string;
}

export interface BrowserQualityIssue {
  issueCode: BrowserQualityIssueCode;
  severity: 'hard';
  ruleVersion: typeof BROWSER_QUALITY_RULE_VERSION;
  viewport: BrowserQualityViewportName;
  actual: Record<string, string | number | boolean | null>;
  target: string;
  element?: BrowserElementSummary;
}

export interface BrowserViewportMeasurement {
  viewport: BrowserQualityViewportName;
  width: number;
  height: number;
  slideIndex?: number;
  documentWidth: number;
  h1Count: number;
  visibleHeadingCount: number;
  visibleCtaCount: number;
  visibleLandmarkCount: number;
  issues: BrowserQualityIssue[];
  screenshotPath: string;
}

export interface BrowserQualityAttemptEvidence {
  repairAttempt: number;
  checkedAt: string;
  hardPassed: boolean;
  score: number;
  viewports: BrowserViewportMeasurement[];
  issueCodes: BrowserQualityIssueCode[];
  evidenceRefs: string[];
}

export interface BrowserQualityEvidence {
  schemaVersion: typeof BROWSER_QUALITY_SCHEMA;
  ruleVersion: typeof BROWSER_QUALITY_RULE_VERSION;
  heuristicVersion: typeof BROWSER_QUALITY_HEURISTIC_VERSION;
  browser: { name: 'chromium'; version: string };
  firstPassPassed: boolean;
  repairAttempts: number;
  repairSucceeded: boolean;
  finalHardPassed: boolean;
  finalScore: number;
  attempts: BrowserQualityAttemptEvidence[];
}

export interface BrowserQualityFailureIssue {
  issueCode: BrowserQualityIssueCode;
  viewport: BrowserQualityViewportName;
  actual: Record<string, string | number | boolean | null>;
  target: string;
  elementSummary?: BrowserElementSummary;
}

export interface BrowserQualityFailureAttempt {
  repairAttempt: number;
  hardPassed: boolean;
  score: number;
  issues: BrowserQualityFailureIssue[];
}

/**
 * 失败任务也必须留下可追溯的浏览器事实，但不能把 HTML、截图物理路径或无界 DOM 文本塞进事件。
 * 最多保留三次检查、每次十六个问题；这覆盖首检与两轮有限修复。
 */
export interface BrowserQualityFailureEvidence {
  schemaVersion: typeof BROWSER_QUALITY_FAILURE_SCHEMA;
  ruleVersion: typeof BROWSER_QUALITY_RULE_VERSION;
  heuristicVersion: typeof BROWSER_QUALITY_HEURISTIC_VERSION;
  repairAttempts: number;
  repairBudgetExhausted: boolean;
  attempts: BrowserQualityFailureAttempt[];
}

export interface BrowserQualityWorkerJob {
  workspaceDir: string;
  evidenceDir: string;
  repairAttempt: number;
}

export interface BrowserQualityWorkerResult {
  browserVersion: string;
  measurements: BrowserViewportMeasurement[];
}

export function summarizeAttempt(
  repairAttempt: number,
  browserVersion: string,
  measurements: BrowserViewportMeasurement[],
  checkedAt = new Date().toISOString(),
): BrowserQualityAttemptEvidence {
  const issues = measurements.flatMap((measurement) => measurement.issues);
  const issueCodes = [...new Set(issues.map((issue) => issue.issueCode))].sort();
  const visibleStructure = measurements.reduce(
    (total, measurement) => total
      + Math.min(measurement.visibleHeadingCount, 4)
      + Math.min(measurement.visibleCtaCount, 2)
      + Math.min(measurement.visibleLandmarkCount, 3),
    0,
  );
  const score = Math.max(0, Math.min(100, 70 + Math.min(20, visibleStructure * 2) - issues.length * 12));
  return {
    repairAttempt,
    checkedAt,
    hardPassed: issues.length === 0,
    score,
    viewports: measurements,
    issueCodes,
    evidenceRefs: measurements.map((measurement) => measurement.screenshotPath),
  };
}

export function buildBrowserQualityEvidence(
  browserVersion: string,
  attempts: BrowserQualityAttemptEvidence[],
): BrowserQualityEvidence {
  const finalAttempt = attempts.at(-1);
  if (!finalAttempt) throw new Error('browser quality evidence requires at least one attempt');
  return {
    schemaVersion: BROWSER_QUALITY_SCHEMA,
    ruleVersion: BROWSER_QUALITY_RULE_VERSION,
    heuristicVersion: BROWSER_QUALITY_HEURISTIC_VERSION,
    browser: { name: 'chromium', version: browserVersion },
    firstPassPassed: attempts[0].hardPassed,
    repairAttempts: Math.max(0, attempts.length - 1),
    repairSucceeded: !attempts[0].hardPassed && finalAttempt.hardPassed,
    finalHardPassed: finalAttempt.hardPassed,
    finalScore: finalAttempt.score,
    attempts,
  };
}

const boundedText = (value: string | undefined, max: number): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
};

const BROWSER_MEASUREMENT_KEYS = new Set([
  'documentWidth', 'viewportWidth', 'present', 'visible', 'left', 'right', 'href',
  'linkCount', 'visibleLinkCount', 'hasVisibleToggle', 'tableWidth', 'scrollable',
  'minCellWidth', 'ratio', 'minimum', 'fontSize', 'fontWeight',
  'slideIndex', 'actualPages', 'targetPages', 'canNavigate',
  'effectiveFontSize', 'minimumFontSize', 'overlapRatio',
]);

function boundedActual(actual: BrowserQualityIssue['actual']): BrowserQualityFailureIssue['actual'] {
  const safe: BrowserQualityFailureIssue['actual'] = {};
  for (const [key, value] of Object.entries(actual).slice(0, 8)) {
    if (!BROWSER_MEASUREMENT_KEYS.has(key)) continue;
    safe[key] = typeof value === 'string' ? value.slice(0, 120) : value;
  }
  return safe;
}

export function buildBrowserQualityFailureEvidence(
  attempts: BrowserQualityAttemptEvidence[],
  repairBudgetExhausted: boolean,
): BrowserQualityFailureEvidence {
  return {
    schemaVersion: BROWSER_QUALITY_FAILURE_SCHEMA,
    ruleVersion: BROWSER_QUALITY_RULE_VERSION,
    heuristicVersion: BROWSER_QUALITY_HEURISTIC_VERSION,
    repairAttempts: Math.max(0, attempts.length - 1),
    repairBudgetExhausted,
    attempts: attempts.slice(-3).map((attempt) => ({
      repairAttempt: attempt.repairAttempt,
      hardPassed: attempt.hardPassed,
      score: attempt.score,
      issues: attempt.viewports.flatMap((measurement) => measurement.issues).slice(0, 16).map((issue) => ({
        issueCode: issue.issueCode,
        viewport: issue.viewport,
        actual: boundedActual(issue.actual),
        target: boundedText(issue.target, 160) ?? 'browser hard-gate target',
        ...(issue.element ? {
          elementSummary: {
            tag: boundedText(issue.element.tag, 40) ?? 'element',
            ...(boundedText(issue.element.id, 80) ? { id: boundedText(issue.element.id, 80) } : {}),
            ...(boundedText(issue.element.role, 80) ? { role: boundedText(issue.element.role, 80) } : {}),
            ...(boundedText(issue.element.label, 160) ? { label: boundedText(issue.element.label, 160) } : {}),
          },
        } : {}),
      })),
    })),
  };
}

function measuredIssueSignature(attempt: BrowserQualityAttemptEvidence): string[] {
  return attempt.viewports.flatMap((measurement) => measurement.issues).map((issue) => JSON.stringify({
    issueCode: issue.issueCode,
    viewport: issue.viewport,
    actual: Object.fromEntries(Object.entries(issue.actual).sort(([left], [right]) => left.localeCompare(right))),
    target: issue.target,
    element: issue.element,
  })).sort();
}

function hasNoMeasuredImprovement(
  attempt: BrowserQualityAttemptEvidence,
  previousAttempt: BrowserQualityAttemptEvidence | undefined,
): boolean {
  if (!previousAttempt || attempt.score !== previousAttempt.score) return false;
  return JSON.stringify(measuredIssueSignature(attempt)) === JSON.stringify(measuredIssueSignature(previousAttempt));
}

export function browserRepairMessage(
  attempt: BrowserQualityAttemptEvidence,
  previousAttempt?: BrowserQualityAttemptEvidence,
): string {
  const issues = attempt.viewports.flatMap((measurement) => measurement.issues).map((issue) => ({
    issueCode: issue.issueCode,
    viewport: issue.viewport,
    actual: issue.actual,
    target: issue.target,
    element: issue.element,
  }));
  const repeatedMobileNavigationFailure = hasNoMeasuredImprovement(attempt, previousAttempt)
    && attempt.issueCodes.includes('mobile_navigation_unusable');
  const escalation = repeatedMobileNavigationFailure ? [
    'The previous targeted repair produced no measurable change to this mobile navigation issue or score. Do not repeat that patch.',
    'At the 390px viewport, use one complete accessible strategy: either keep the failing navigation links directly visible, or provide one visible operable button whose aria-controls exactly equals the controlled navigation id and whose activation makes those links visible.',
    'Do not leave any second hidden nav or [role="navigation"] containing links without its own matching visible control. A decorative button, a button targeting another nav, or a closed container whose links never become visible does not repair this issue.',
    'Verify the computed mobile styles and the clicked open state before saving the complete page.',
  ] : [];
  return [
    'The isolated browser quality gate rendered the current page at 1440px desktop and 390px mobile and rejected it.',
    'Repair only the measured hard issues below in the existing /workspace/index.html and its existing assets.',
    BROWSER_HARD_GATE_AUTHORING_RULE,
    'Keep all verified facts, brand tokens, sections, and working interactions. Do not replace the page with a simplified rewrite.',
    `Measured issues (rule ${BROWSER_QUALITY_RULE_VERSION}):`,
    JSON.stringify(issues),
    ...escalation,
    'After fixing, save the complete page to /workspace/index.html. Do not describe the work in chat.',
  ].join('\n');
}
