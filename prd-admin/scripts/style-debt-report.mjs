#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
  surfaceUse: {
    label: 'surface use',
    regex: /\bsurface(?:-|")|\bGlassCard\b|\bCard\b|\bButton\b|\bPageHeader\b/g,
    weight: 0,
  },
};

const PRINT_TOP = Number.parseInt(getArgValue('--top') ?? '25', 10);
const JSON_OUTPUT = process.argv.includes('--json');
const EXCLUDE_PATTERNS = getArgValues('--exclude')
  .flatMap((value) => value.split(','))
  .map((value) => value.trim())
  .filter(Boolean);

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

  const score =
    counts.inlineStyle * PATTERNS.inlineStyle.weight +
    counts.hardColor * PATTERNS.hardColor.weight +
    counts.arbitraryTailwind * PATTERNS.arbitraryTailwind.weight +
    counts.heavyEffect * PATTERNS.heavyEffect.weight;

  return {
    path: relativePath,
    module: moduleKey(relativePath),
    score,
    ...counts,
  };
}

function isExcluded(row) {
  return EXCLUDE_PATTERNS.some((pattern) => row.path.startsWith(pattern) || row.module === pattern);
}

function summarize(projectRoot) {
  const files = walkFiles(path.join(projectRoot, 'src'));
  const allRows = files.map((file) => analyzeFile(projectRoot, file));
  const rows = allRows.filter((row) => !isExcluded(row));
  const totals = rows.reduce(
    (acc, row) => {
      acc.files += 1;
      acc.score += row.score;
      for (const key of Object.keys(PATTERNS)) acc[key] += row[key];
      return acc;
    },
    {
      files: 0,
      score: 0,
      inlineStyle: 0,
      hardColor: 0,
      arbitraryTailwind: 0,
      heavyEffect: 0,
      surfaceUse: 0,
    },
  );

  const modules = new Map();
  for (const row of rows) {
    const current = modules.get(row.module) ?? {
      module: row.module,
      files: 0,
      score: 0,
      inlineStyle: 0,
      hardColor: 0,
      arbitraryTailwind: 0,
      heavyEffect: 0,
      surfaceUse: 0,
    };
    current.files += 1;
    current.score += row.score;
    for (const key of Object.keys(PATTERNS)) current[key] += row[key];
    modules.set(row.module, current);
  }

  return {
    projectRoot,
    generatedAt: new Date().toISOString(),
    excluded: EXCLUDE_PATTERNS,
    totals,
    topFiles: rows.filter((row) => row.score > 0).sort((a, b) => b.score - a.score).slice(0, PRINT_TOP),
    topModules: Array.from(modules.values()).filter((row) => row.score > 0).sort((a, b) => b.score - a.score).slice(0, PRINT_TOP),
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
  console.log(`Inline style: ${report.totals.inlineStyle}`);
  console.log(`Hard-coded color: ${report.totals.hardColor}`);
  console.log(`Arbitrary Tailwind: ${report.totals.arbitraryTailwind}`);
  console.log(`Heavy visual effect: ${report.totals.heavyEffect}`);
  console.log(`Surface/design usage signals: ${report.totals.surfaceUse}`);

  const columns = [
    { key: 'score', label: 'score' },
    { key: 'inlineStyle', label: 'style' },
    { key: 'hardColor', label: 'color' },
    { key: 'arbitraryTailwind', label: 'tw' },
    { key: 'heavyEffect', label: 'fx' },
    { key: 'surfaceUse', label: 'surface' },
  ];

  printTable('Top modules', report.topModules, [...columns, { key: 'module', label: 'module' }]);
  printTable('Top files', report.topFiles, [...columns, { key: 'path', label: 'path' }]);

  console.log('\nNext actions');
  console.log('- Convert container-level background/border/shadow styles to surface, surface-inset, or GlassCard.');
  console.log('- Keep semantic status colors, but route repeated palettes through tokens.');
  console.log('- Treat experience pages as explicit exceptions instead of letting their visual language leak into admin pages.');
}

const report = summarize(resolveProjectRoot());
if (JSON_OUTPUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printHuman(report);
}
