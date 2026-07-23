/**
 * 自适应主题样式棘轮。
 *
 * 与 themeHardcodeRatchet 分工：
 * - themeHardcodeRatchet 约束 rgba 白透明与深色 hex。
 * - 本测试约束 Tailwind 白/黑固定边框、白色表面和白色悬浮态。
 *
 * 存量按文件记录，只允许减少。不能用其他文件的下降抵消当前文件的新增。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(TEST_DIR, '../..');
const BASELINE_PATH = path.join(TEST_DIR, 'themeAdaptiveBaseline.json');
const CLASSIFICATION_PATH = path.resolve(SRC_DIR, '../scripts/theme-risk-classification.json');
const STYLE_EXTENSIONS = new Set(['.tsx', '.ts', '.jsx', '.js', '.css']);
const FULL_DARK_SURFACE_FILES = new Set(['/pages/cds-agent/CdsAgentPage.tsx']);

const ADAPTIVE_BORDER_RE =
  /(?:\bborder(?:Top|Bottom|Left|Right|Color)?\s*:\s*['"`][^\n]{0,120}rgba\(\s*255\s*,\s*255\s*,\s*255|\b(?:border(?:-[tblrxy])?|divide)-(?:white|black)(?:\/(?:\d+|\[[^\]]+\]))?)/gi;
const ADAPTIVE_SURFACE_RE =
  /(?:\bbackground(?:Color)?\s*:\s*['"`]rgba\(\s*255\s*,\s*255\s*,\s*255|(?<!hover:)\bbg-white(?:\/(?:\d+|\[[^\]]+\])))/gi;
const ADAPTIVE_HOVER_RE = /\bhover:bg-white(?:\/(?:\d+|\[[^\]]+\]))/gi;
const SEMANTIC_BACKGROUND =
  /\b(?:bg|from|via|to)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-/;
const DARK_OVERLAY = /\bbg-black(?:\/(?:\d+|\[[^\]]+\]))?\b.*\b(?:absolute|fixed|inset-\d|inset-0|backdrop|top-\d|bottom-\d)\b|\b(?:absolute|fixed|inset-\d|inset-0|backdrop|top-\d|bottom-\d)\b.*\bbg-black(?:\/(?:\d+|\[[^\]]+\]))?\b/;
const FIXED_WHITE_TEXT = new RegExp(
  String.raw`\btext-${'white'}(?:\/(?:\d+|\[[^\]]+\]))?\b`,
);

interface Counts {
  border: number;
  surface: number;
  hover: number;
}

function skipped(relativePath: string): boolean {
  return (
    relativePath.includes('/__tests__/') ||
    relativePath.includes('/_dev/') ||
    relativePath.includes('/_mockup/') ||
    /\.test\.[jt]sx?$/.test(relativePath)
  );
}

function walk(directory: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else if (STYLE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function count(content: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  return Array.from(content.matchAll(pattern)).length;
}

function countAdaptiveBorders(content: string): number {
  ADAPTIVE_BORDER_RE.lastIndex = 0;
  return Array.from(content.matchAll(ADAPTIVE_BORDER_RE))
    .filter((match) => !/^border(?:Top|Bottom|Left|Right|Color)?\s*:\s*['"`](?:none|var\(--)/i.test(match[0]))
    .length;
}

function loadClassifiedPaths(): Set<string> {
  const manifest = JSON.parse(fs.readFileSync(CLASSIFICATION_PATH, 'utf8')) as {
    intentionalVisualFiles: Array<{ path: string }>;
    infrastructureFiles: Array<{ path: string }>;
  };
  return new Set(
    [...manifest.intentionalVisualFiles, ...manifest.infrastructureFiles]
      .map((entry) => `/${entry.path}`),
  );
}

function findUnclassifiedTextWhite(
  filePath: string,
  content: string,
  classifiedPaths: Set<string>,
): string[] {
  const relativePath = filePath.slice(SRC_DIR.length).replace(/\\/g, '/');
  if (classifiedPaths.has(relativePath) || skipped(relativePath)) return [];

  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const violations: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (
        FIXED_WHITE_TEXT.test(node.text)
        && !SEMANTIC_BACKGROUND.test(node.text)
        && !DARK_OVERLAY.test(node.text)
      ) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        violations.push(`${relativePath}:${line}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return violations;
}

function scan(): Record<string, Counts> {
  const findings: Record<string, Counts> = {};

  for (const filePath of walk(SRC_DIR)) {
    const relativePath = filePath.slice(SRC_DIR.length).replace(/\\/g, '/');
    if (skipped(relativePath) || FULL_DARK_SURFACE_FILES.has(relativePath)) continue;

    const content = fs.readFileSync(filePath, 'utf8');
    const counts = {
      border: countAdaptiveBorders(content),
      surface: count(content, ADAPTIVE_SURFACE_RE),
      hover: count(content, ADAPTIVE_HOVER_RE),
    };
    if (counts.border + counts.surface + counts.hover > 0) findings[relativePath] = counts;
  }

  return Object.fromEntries(
    Object.entries(findings).sort(([left], [right]) => left.localeCompare(right)),
  );
}

describe('自适应主题样式棘轮', () => {
  it('每个文件的固定边框、表面和悬浮态风险只能减少', () => {
    const current = scan();
    const classifiedPaths = loadClassifiedPaths();

    if (process.env.UPDATE_ADAPTIVE_THEME_BASELINE === '1') {
      fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
      return;
    }

    const baseline: Record<string, Counts> = JSON.parse(
      fs.readFileSync(BASELINE_PATH, 'utf8'),
    );
    const violations: string[] = [];

    for (const [file, counts] of Object.entries(current)) {
      const ceiling = classifiedPaths.has(file)
        ? baseline[file] ?? { border: 0, surface: 0, hover: 0 }
        : { border: 0, surface: 0, hover: 0 };
      for (const metric of ['border', 'surface', 'hover'] as const) {
        if (counts[metric] > ceiling[metric]) {
          violations.push(`${file}: ${metric} ${ceiling[metric]} -> ${counts[metric]}`);
        }
      }
    }

    expect(
      violations,
      [
        '',
        '自适应主题棘轮拦截：新增了浅色主题下可能隐形的固定样式。',
        '请改用 border-token-subtle、surface-inset、bg-token-nested 或 hover-bg-soft。',
        ...violations,
      ].join('\n'),
    ).toEqual([]);
  });

  it('普通界面的固定白字只能用于同一语义色表面的对比文字', () => {
    const classifiedPaths = loadClassifiedPaths();
    const violations = walk(SRC_DIR).flatMap((filePath) => {
      const content = fs.readFileSync(filePath, 'utf8');
      return findUnclassifiedTextWhite(filePath, content, classifiedPaths);
    });

    expect(
      violations,
      [
        '',
        '发现未分类的固定白色文字。',
        '普通界面请改用 text-token-primary / secondary / muted；',
        '只有同一 class 字符串中带语义色背景的对比文字可以保留固定白字。',
        ...violations,
      ].join('\n'),
    ).toEqual([]);
  });
});
