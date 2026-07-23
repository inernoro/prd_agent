#!/usr/bin/env node
/* global console, process */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SOURCE_EXTENSIONS = new Set(['.tsx', '.ts', '.jsx', '.js', '.css']);
const STYLE_EXTENSIONS = new Set(['.tsx', '.jsx', '.css']);

const PATTERNS = {
  inlineStyle: {
    label: 'inline style',
    regex: /style=\{\{/g,
    weight: 3,
  },
  hardColor: {
    label: 'hard-coded color',
    regex: /#[0-9a-fA-F]{3,8}\b|rgba?\(/g,
    weight: 1,
  },
  arbitraryTailwind: {
    label: 'arbitrary Tailwind',
    regex: /\b(?:rounded|text|bg|border|shadow|p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|w|h|min-w|min-h|max-w|max-h|top|right|bottom|left|inset|translate-x|translate-y|z)-\[/g,
    weight: 2,
  },
  heavyEffect: {
    label: 'heavy visual effect',
    regex: /linear-gradient|radial-gradient|boxShadow|box-shadow|backdrop-filter|drop-shadow|filter:/g,
    weight: 2,
  },
  literalShadow: {
    label: 'literal shadow',
    regex: /\b(?:boxShadow|box-shadow)\s*:\s*['"`]?(?!var\()[^\n;]{0,120}(?:rgba?\(|#[0-9a-fA-F]{3,8}\b)/g,
    weight: 2,
  },
  lowContrastText: {
    label: 'low contrast text',
    regex: /text-(?:white|black)\/(?:[1-3]\d|40)\b|color\s*:\s*['"`]?rgba\([^)]*,\s*0\.(?:[0-3]\d?|40)\)/gi,
    weight: 3,
  },
  themeRisk: {
    label: 'theme contract risk',
    regex: /text-white(?:\/\d+)?\b|bg-\[#(?:0c0d0f|16171a|16171b|1a1c20)\]|var\(--text-primary,\s*#fff\)/gi,
    weight: 3,
  },
  declaredDarkScope: {
    label: 'declared dark scope',
    regex: /surface-tone-dark|data-surface-tone=["']dark["']/gi,
    weight: 0,
  },
  fixedThemeSurface: {
    label: 'fixed theme surface',
    regex: /background\s*:\s*['"`]?(?:rgba\(0\s*,\s*0\s*,\s*0\s*,\s*0\.(?:1[5-9]|2\d)|linear-gradient\([^\n]*(?:22\s*,\s*27\s*,\s*36|18\s*,\s*22\s*,\s*30))|bg-\[#(?:0c0d0f|16171a|16171b|1a1c20)\]/gi,
    weight: 0,
  },
  fixedThemeText: {
    label: 'fixed theme text',
    regex: /text-white(?:\/\d+)?\b|color\s*:\s*['"`]rgba\(255\s*,\s*255\s*,\s*255\s*,/gi,
    weight: 0,
  },
  dynamicTextColor: {
    label: 'dynamic text color',
    regex: /color\s*:\s*(?:hsla?\(|['"`]hsla?\()/gi,
    weight: 0,
  },
  adaptiveBorderRisk: {
    label: 'adaptive border risk',
    regex: /(?:\bborder(?:Top|Bottom|Left|Right|Color)?\s*:\s*['"`][^\n]{0,120}rgba\(\s*255\s*,\s*255\s*,\s*255|\b(?:border(?:-[tblrxy])?|divide)-(?:white|black)(?:\/(?:\d+|\[[^\]]+\]))?)/gi,
    weight: 0,
  },
  adaptiveSurfaceRisk: {
    label: 'adaptive surface risk',
    regex: /(?:\bbackground(?:Color)?\s*:\s*['"`]rgba\(\s*255\s*,\s*255\s*,\s*255|(?<!hover:)\bbg-white(?:\/(?:\d+|\[[^\]]+\])))/gi,
    weight: 0,
  },
  adaptiveHoverRisk: {
    label: 'adaptive hover risk',
    regex: /\bhover:bg-white(?:\/(?:\d+|\[[^\]]+\]))/gi,
    weight: 0,
  },
  surfaceUse: {
    label: 'surface use',
    regex: /\bsurface(?:-|")|\bGlassCard\b|\bCard\b|\bButton\b|\bPageHeader\b/g,
    weight: 0,
  },
};

const PRINT_TOP = Number.parseInt(getArgValue('--top') ?? '25', 10);
const JSON_OUTPUT = process.argv.includes('--json');
const DETAILS_OUTPUT = process.argv.includes('--details');
const CHECK_BASELINE = process.argv.includes('--check-baseline');
const UPDATE_BASELINE = process.argv.includes('--update-baseline');
const METRIC_VERSION = 3;
const EXCLUDE_PATTERNS = getArgValues('--exclude')
  .flatMap((value) => value.split(','))
  .map((value) => value.trim())
  .filter(Boolean);

// Only experiences whose whole page is intentionally dark may bypass adaptive
// surface/text findings. Local dark islands still remain visible to the scan.
const FULL_DARK_SURFACE_FILES = new Set([
  'pages/cds-agent/CdsAgentPage.tsx',
]);

function getArgValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function getArgValues(flag) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === flag && process.argv[index + 1]) {
      values.push(process.argv[index + 1]);
    }
  }
  return values;
}

function resolveProjectRoot() {
  const cwd = process.cwd();
  if (existsSync(path.join(cwd, 'src'))) return cwd;
  if (existsSync(path.join(cwd, 'prd-admin', 'src'))) return path.join(cwd, 'prd-admin');
  throw new Error('Cannot find prd-admin/src from current working directory.');
}

function baselinePath(projectRoot) {
  return path.join(projectRoot, 'scripts', 'style-debt-baseline.json');
}

function classificationPath(projectRoot) {
  return path.join(projectRoot, 'scripts', 'theme-risk-classification.json');
}

function walkFiles(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walkFiles(fullPath, files);
      continue;
    }
    if (SOURCE_EXTENSIONS.has(path.extname(fullPath))) files.push(fullPath);
  }
  return files;
}

function countMatches(text, regex) {
  regex.lastIndex = 0;
  return Array.from(text.matchAll(regex)).length;
}

function collectMatches(text, patternKey, regex) {
  regex.lastIndex = 0;
  return Array.from(text.matchAll(regex)).map((match) => ({
    kind: patternKey,
    line: text.slice(0, match.index).split('\n').length,
    snippet: match[0].replace(/\s+/g, ' ').trim().slice(0, 180),
  }));
}

function isPreciseAdaptiveFinding(finding) {
  if (finding.kind !== 'adaptiveBorderRisk') return true;
  return !/^border(?:Top|Bottom|Left|Right|Color)?\s*:\s*['"`](?:none|var\(--)/i
    .test(finding.snippet);
}

function moduleKey(relativePath) {
  const parts = relativePath.split(path.sep);
  if (parts[0] === 'pages') return `pages/${parts[1] ?? '(root)'}`;
  if (parts[0] === 'components') return `components/${parts[1] ?? '(root)'}`;
  return parts[0] ?? '(root)';
}

function analyzeFile(projectRoot, filePath) {
  const relativePath = path.relative(path.join(projectRoot, 'src'), filePath);
  const ext = path.extname(filePath);
  const text = readFileSync(filePath, 'utf8');
  const counts = {};

  for (const [key, pattern] of Object.entries(PATTERNS)) {
    if (key === 'inlineStyle' && !STYLE_EXTENSIONS.has(ext)) {
      counts[key] = 0;
      continue;
    }
    counts[key] = countMatches(text, pattern.regex);
  }

  const isFullDarkSurface = FULL_DARK_SURFACE_FILES.has(relativePath);
  if (isFullDarkSurface) {
    counts.adaptiveBorderRisk = 0;
    counts.adaptiveSurfaceRisk = 0;
    counts.adaptiveHoverRisk = 0;
  }

  const undeclaredThemeRisk = isFullDarkSurface
    ? counts.dynamicTextColor
    : Math.max(0, counts.fixedThemeSurface - counts.declaredDarkScope)
      + counts.fixedThemeText
      + counts.dynamicTextColor;
  const adaptiveThemeRisk =
    counts.adaptiveBorderRisk + counts.adaptiveSurfaceRisk + counts.adaptiveHoverRisk;
  const preciseAdaptiveFindings = isFullDarkSurface
    ? []
    : ['adaptiveBorderRisk', 'adaptiveSurfaceRisk', 'adaptiveHoverRisk']
        .flatMap((key) => collectMatches(text, key, PATTERNS[key].regex))
        .filter(isPreciseAdaptiveFinding)
        .map((finding) => ({ ...finding, path: relativePath }));
  const preciseAdaptiveBorderRisk = preciseAdaptiveFindings
    .filter((finding) => finding.kind === 'adaptiveBorderRisk').length;
  const preciseAdaptiveSurfaceRisk = preciseAdaptiveFindings
    .filter((finding) => finding.kind === 'adaptiveSurfaceRisk').length;
  const preciseAdaptiveHoverRisk = preciseAdaptiveFindings
    .filter((finding) => finding.kind === 'adaptiveHoverRisk').length;
  const preciseAdaptiveThemeRisk =
    preciseAdaptiveBorderRisk + preciseAdaptiveSurfaceRisk + preciseAdaptiveHoverRisk;
  const adaptiveFindings = DETAILS_OUTPUT ? preciseAdaptiveFindings : [];

  const score =
    counts.inlineStyle * PATTERNS.inlineStyle.weight +
    counts.hardColor * PATTERNS.hardColor.weight +
    counts.arbitraryTailwind * PATTERNS.arbitraryTailwind.weight +
    counts.heavyEffect * PATTERNS.heavyEffect.weight +
    counts.literalShadow * PATTERNS.literalShadow.weight +
    counts.lowContrastText * PATTERNS.lowContrastText.weight;

  return {
    path: relativePath,
    module: moduleKey(relativePath),
    score,
    undeclaredThemeRisk,
    adaptiveThemeRisk,
    preciseAdaptiveBorderRisk,
    preciseAdaptiveSurfaceRisk,
    preciseAdaptiveHoverRisk,
    preciseAdaptiveThemeRisk,
    adaptiveFindings,
    ...counts,
  };
}

function scoreSnapshot(report) {
  return {
    score: report.totals.score,
    undeclaredThemeRisk: report.totals.undeclaredThemeRisk,
    adaptiveBorderRisk: report.totals.adaptiveBorderRisk,
    adaptiveSurfaceRisk: report.totals.adaptiveSurfaceRisk,
    adaptiveHoverRisk: report.totals.adaptiveHoverRisk,
    adaptiveThemeRisk: report.totals.adaptiveThemeRisk,
    actionableThemeRisk: report.themeLayers.actionableThemeRisk,
    ordinaryUiRisk: report.themeLayers.ordinaryUiRisk,
    unclassifiedThemeRisk: report.themeLayers.unclassifiedThemeRisk,
  };
}

function loadBaseline(projectRoot) {
  const filePath = baselinePath(projectRoot);
  if (!existsSync(filePath)) {
    throw new Error(`Missing style debt baseline: ${filePath}`);
  }
  return { filePath, value: JSON.parse(readFileSync(filePath, 'utf8')) };
}

function checkBaseline(report) {
  const { value } = loadBaseline(report.projectRoot);
  const current = scoreSnapshot(report);
  const violations = value.enforcedMetrics.flatMap((metric) => {
    const ceiling = value.currentCeiling[metric];
    return current[metric] > ceiling
      ? [`${metric}: ${ceiling} -> ${current[metric]}`]
      : [];
  });
  violations.push(...report.classification.errors);

  console.log('\nStyle debt baseline');
  console.log(`Metric version: ${value.metricVersion}`);
  console.log(`Program baseline score: ${value.programBaseline.score}`);
  console.log(`Current score: ${current.score}`);
  console.log(`Program baseline adaptive risk: ${value.programBaseline.adaptiveThemeRisk}`);
  console.log(`Current adaptive risk: ${current.adaptiveThemeRisk}`);
  console.log(`Current actionable theme risk: ${current.actionableThemeRisk}`);
  console.log(`Current unclassified theme risk: ${current.unclassifiedThemeRisk}`);
  console.log(`Milestone target score: ${value.milestoneTarget.score}`);
  console.log(`Milestone target undeclared risk: ${value.milestoneTarget.undeclaredThemeRisk}`);
  console.log(`Milestone target adaptive risk: ${value.milestoneTarget.adaptiveThemeRisk}`);
  const milestoneMet = Object.entries(value.milestoneTarget)
    .every(([metric, target]) => current[metric] <= target);
  console.log(`Milestone status: ${milestoneMet ? 'ACHIEVED' : 'IN PROGRESS'}`);
  if (value.nextTarget) {
    console.log(`Next target score: ${value.nextTarget.score}`);
    console.log(`Next target undeclared risk: ${value.nextTarget.undeclaredThemeRisk}`);
    console.log(`Next target adaptive risk: ${value.nextTarget.adaptiveThemeRisk}`);
  }

  if (violations.length > 0) {
    console.error('\nStyle debt ratchet failed');
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
  } else {
    console.log('Style debt ratchet: PASS');
  }
}

function updateBaseline(report) {
  const { filePath, value } = loadBaseline(report.projectRoot);
  const next = {
    ...value,
    updatedAt: new Date().toISOString(),
    currentCeiling: scoreSnapshot(report),
  };
  writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Updated style debt baseline: ${filePath}`);
}

function isExcluded(row) {
  return EXCLUDE_PATTERNS.some((pattern) => row.path.startsWith(pattern) || row.module === pattern);
}

function summarize(projectRoot) {
  const files = walkFiles(path.join(projectRoot, 'src'));
  const allRows = files.map((file) => analyzeFile(projectRoot, file));
  const rows = allRows.filter((row) => !isExcluded(row));
  const emptyPatternCounts = Object.fromEntries(Object.keys(PATTERNS).map((key) => [key, 0]));
  const totals = rows.reduce(
    (acc, row) => {
      acc.files += 1;
      acc.score += row.score;
      acc.undeclaredThemeRisk += row.undeclaredThemeRisk;
      acc.adaptiveThemeRisk += row.adaptiveThemeRisk;
      acc.preciseAdaptiveBorderRisk += row.preciseAdaptiveBorderRisk;
      acc.preciseAdaptiveSurfaceRisk += row.preciseAdaptiveSurfaceRisk;
      acc.preciseAdaptiveHoverRisk += row.preciseAdaptiveHoverRisk;
      acc.preciseAdaptiveThemeRisk += row.preciseAdaptiveThemeRisk;
      for (const key of Object.keys(PATTERNS)) acc[key] += row[key];
      return acc;
    },
    {
      files: 0,
      score: 0,
      undeclaredThemeRisk: 0,
      adaptiveThemeRisk: 0,
      preciseAdaptiveBorderRisk: 0,
      preciseAdaptiveSurfaceRisk: 0,
      preciseAdaptiveHoverRisk: 0,
      preciseAdaptiveThemeRisk: 0,
      ...emptyPatternCounts,
    },
  );

  const classificationManifest = JSON.parse(
    readFileSync(classificationPath(projectRoot), 'utf8'),
  );
  const classificationEntries = [
    ...classificationManifest.intentionalVisualFiles,
    ...classificationManifest.infrastructureFiles,
  ];
  const classifiedPaths = new Set(classificationEntries.map((entry) => entry.path));
  const rowPaths = new Set(rows.map((row) => row.path));
  const duplicatePaths = classificationEntries
    .map((entry) => entry.path)
    .filter((entryPath, index, all) => all.indexOf(entryPath) !== index);
  const classificationErrors = [
    ...duplicatePaths.map((entryPath) => `Duplicate theme classification: ${entryPath}`),
    ...classificationEntries
      .filter((entry) => !rowPaths.has(entry.path))
      .map((entry) => `Theme classification path does not exist: ${entry.path}`),
    ...classificationEntries
      .filter((entry) => !entry.category || !entry.scope || !entry.rationale)
      .map((entry) => `Incomplete theme classification: ${entry.path}`),
  ];
  const ordinaryRows = rows.filter((row) => !classifiedPaths.has(row.path));
  const intentionalRows = rows.filter((row) => classifiedPaths.has(row.path));
  const ordinaryAdaptiveRisk = ordinaryRows
    .reduce((sum, row) => sum + row.preciseAdaptiveThemeRisk, 0);
  const ordinaryFixedSurfaceRisk = ordinaryRows
    .reduce((sum, row) => sum + row.fixedThemeSurface, 0);
  const actionableThemeRisk = ordinaryAdaptiveRisk + ordinaryFixedSurfaceRisk;
  const themeLayers = {
    metricVersion: METRIC_VERSION,
    rawMaintenanceDebt: totals.score,
    legacyThemeSignals: {
      undeclaredThemeRisk: totals.undeclaredThemeRisk,
      adaptiveThemeRisk: totals.adaptiveThemeRisk,
    },
    actionableThemeRisk,
    ordinaryUiRisk: actionableThemeRisk,
    unclassifiedThemeRisk: actionableThemeRisk,
    intentionalVisualDebt: intentionalRows.reduce(
      (sum, row) => sum + row.undeclaredThemeRisk + row.preciseAdaptiveThemeRisk,
      0,
    ),
    semanticContrastDebt: ordinaryRows.reduce(
      (sum, row) => sum + row.fixedThemeText,
      0,
    ),
    dynamicVisualDebt: ordinaryRows.reduce(
      (sum, row) => sum + row.dynamicTextColor,
      0,
    ),
  };

  const modules = new Map();
  for (const row of rows) {
    const current = modules.get(row.module) ?? {
      module: row.module,
      files: 0,
      score: 0,
      undeclaredThemeRisk: 0,
      adaptiveThemeRisk: 0,
      ...emptyPatternCounts,
    };
    current.files += 1;
    current.score += row.score;
    current.undeclaredThemeRisk += row.undeclaredThemeRisk;
    current.adaptiveThemeRisk += row.adaptiveThemeRisk;
    for (const key of Object.keys(PATTERNS)) current[key] += row[key];
    modules.set(row.module, current);
  }
  const adaptiveRows = rows
    .filter((row) => row.adaptiveThemeRisk > 0)
    .sort((a, b) => b.adaptiveThemeRisk - a.adaptiveThemeRisk);

  return {
    metricVersion: METRIC_VERSION,
    projectRoot,
    generatedAt: new Date().toISOString(),
    excluded: EXCLUDE_PATTERNS,
    totals,
    themeLayers,
    classification: {
      schemaVersion: classificationManifest.schemaVersion,
      classifiedFiles: classifiedPaths.size,
      errors: classificationErrors,
    },
    topFiles: rows.filter((row) => row.score > 0).sort((a, b) => b.score - a.score).slice(0, PRINT_TOP),
    topThemeRisks: rows.filter((row) => row.undeclaredThemeRisk > 0)
      .sort((a, b) => b.undeclaredThemeRisk - a.undeclaredThemeRisk)
      .slice(0, PRINT_TOP),
    topAdaptiveThemeRisks: adaptiveRows.slice(0, PRINT_TOP),
    adaptiveFindings: DETAILS_OUTPUT
      ? adaptiveRows.flatMap((row) => row.adaptiveFindings).slice(0, PRINT_TOP * 5)
      : [],
    topModules: Array.from(modules.values())
      .filter((row) => row.score > 0 || row.adaptiveThemeRisk > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, PRINT_TOP),
  };
}

function printTable(title, rows, columns) {
  console.log(`\n${title}`);
  console.log(columns.map((col) => col.label).join('\t'));
  for (const row of rows) {
    console.log(columns.map((col) => row[col.key]).join('\t'));
  }
}

function printHuman(report) {
  console.log('Style debt report');
  console.log(`Project: ${report.projectRoot}`);
  console.log(`Generated: ${report.generatedAt}`);
  if (report.excluded.length > 0) console.log(`Excluded: ${report.excluded.join(', ')}`);
  console.log('');
  console.log(`Files scanned: ${report.totals.files}`);
  console.log(`Debt score: ${report.totals.score}`);
  console.log(`Metric version: ${report.metricVersion}`);
  console.log(`Actionable theme risk: ${report.themeLayers.actionableThemeRisk}`);
  console.log(`Ordinary UI risk: ${report.themeLayers.ordinaryUiRisk}`);
  console.log(`Unclassified theme risk: ${report.themeLayers.unclassifiedThemeRisk}`);
  console.log(`Intentional visual debt: ${report.themeLayers.intentionalVisualDebt}`);
  console.log(`Semantic contrast debt: ${report.themeLayers.semanticContrastDebt}`);
  console.log(`Inline style: ${report.totals.inlineStyle}`);
  console.log(`Hard-coded color: ${report.totals.hardColor}`);
  console.log(`Arbitrary Tailwind: ${report.totals.arbitraryTailwind}`);
  console.log(`Heavy visual effect: ${report.totals.heavyEffect}`);
  console.log(`Literal shadow: ${report.totals.literalShadow}`);
  console.log(`Low contrast text risk: ${report.totals.lowContrastText}`);
  console.log(`Theme contract risk: ${report.totals.themeRisk}`);
  console.log(`Fixed theme surface: ${report.totals.fixedThemeSurface}`);
  console.log(`Fixed theme text: ${report.totals.fixedThemeText}`);
  console.log(`Dynamic text color: ${report.totals.dynamicTextColor}`);
  console.log(`Undeclared theme risk: ${report.totals.undeclaredThemeRisk}`);
  console.log(`Adaptive border risk: ${report.totals.adaptiveBorderRisk}`);
  console.log(`Adaptive surface risk: ${report.totals.adaptiveSurfaceRisk}`);
  console.log(`Adaptive hover risk: ${report.totals.adaptiveHoverRisk}`);
  console.log(`Adaptive theme risk: ${report.totals.adaptiveThemeRisk}`);
  console.log(`Surface/design usage signals: ${report.totals.surfaceUse}`);

  const columns = [
    { key: 'score', label: 'score' },
    { key: 'inlineStyle', label: 'style' },
    { key: 'hardColor', label: 'color' },
    { key: 'arbitraryTailwind', label: 'tw' },
    { key: 'heavyEffect', label: 'fx' },
    { key: 'literalShadow', label: 'shadow' },
    { key: 'lowContrastText', label: 'contrast' },
    { key: 'themeRisk', label: 'theme' },
    { key: 'undeclaredThemeRisk', label: 'undeclared' },
    { key: 'declaredDarkScope', label: 'dark-scope' },
    { key: 'fixedThemeSurface', label: 'fixed-bg' },
    { key: 'fixedThemeText', label: 'fixed-text' },
    { key: 'dynamicTextColor', label: 'dynamic-text' },
    { key: 'adaptiveThemeRisk', label: 'adaptive' },
    { key: 'surfaceUse', label: 'surface' },
  ];

  printTable('Top modules', report.topModules, [...columns, { key: 'module', label: 'module' }]);
  printTable('Top files', report.topFiles, [...columns, { key: 'path', label: 'path' }]);
  printTable('Top undeclared theme risks', report.topThemeRisks, [...columns, { key: 'path', label: 'path' }]);
  printTable('Top adaptive theme risks', report.topAdaptiveThemeRisks, [
    { key: 'adaptiveThemeRisk', label: 'adaptive' },
    { key: 'adaptiveBorderRisk', label: 'border' },
    { key: 'adaptiveSurfaceRisk', label: 'surface' },
    { key: 'adaptiveHoverRisk', label: 'hover' },
    { key: 'path', label: 'path' },
  ]);

  if (report.adaptiveFindings.length > 0) {
    console.log('\nActionable adaptive theme findings');
    for (const finding of report.adaptiveFindings) {
      console.log(`${finding.path}:${finding.line}\t${finding.kind}\t${finding.snippet}`);
    }
  }

  console.log('\nNext actions');
  console.log('- Convert container-level background/border/shadow styles to surface, surface-inset, or GlassCard.');
  console.log('- Keep semantic status colors, but route repeated palettes through tokens.');
  console.log('- Treat experience pages as explicit exceptions instead of letting their visual language leak into admin pages.');
  console.log('- Migrate theme contract risks: fixed dark scopes, low-opacity white text, and mixed fixed/adaptive colors.');
  console.log('- Replace literal component shadows with shared elevation tokens and inspect low-contrast text risks in both themes.');
}

const report = summarize(resolveProjectRoot());
if (JSON_OUTPUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printHuman(report);
}
if (CHECK_BASELINE) checkBaseline(report);
if (UPDATE_BASELINE) updateBaseline(report);
