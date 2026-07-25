#!/usr/bin/env node
/* global console, process */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const write = process.argv.includes('--write');
const filePaths = process.argv.slice(2).filter((value) => value !== '--write');
const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const projectRoot = path.dirname(scriptDir);
const sourceRoot = path.join(projectRoot, 'src');
const classification = JSON.parse(
  readFileSync(path.join(scriptDir, 'theme-risk-classification.json'), 'utf8'),
);
const intentionalPaths = new Set([
  ...classification.intentionalVisualFiles,
  ...classification.infrastructureFiles,
].map((entry) => entry.path));

const WHITE_ALPHA = /rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*(?:0?\.\d+|1(?:\.0+)?)\s*\)/gi;
const DARK_ALPHA = /^(['"`])rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\.(?:1[5-9]|2\d)\s*\)\1$/i;
const DARK_GRADIENT = /linear-gradient\([^\n]*(?:22\s*,\s*27\s*,\s*36|18\s*,\s*22\s*,\s*30)/i;
const BORDER_PROPERTIES = new Set([
  'border',
  'borderTop',
  'borderRight',
  'borderBottom',
  'borderLeft',
  'borderColor',
]);
const SURFACE_PROPERTIES = new Set(['background', 'backgroundColor']);
const TEXT_PROPERTIES = new Set(['color']);

function nameOf(property) {
  if (!ts.isPropertyAssignment(property)) return null;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) {
    return property.name.text;
  }
  return null;
}

function migrateInitializer(source, property) {
  const name = nameOf(property);
  if (name === null) return null;
  const initializer = property.initializer;
  const text = initializer.getText();

  if (BORDER_PROPERTIES.has(name)) {
    const next = text
      .replace(/var\(--(?:border-(?:subtle|faint)|glass-border),\s*rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*(?:0?\.\d+|1(?:\.0+)?)\s*\)\)/gi, 'var(--border-subtle)')
      .replace(WHITE_ALPHA, 'var(--border-subtle)');
    return next === text ? null : {
      start: initializer.getStart(),
      end: initializer.end,
      text: next,
    };
  }

  if (SURFACE_PROPERTIES.has(name)) {
    let next = text
      .replace(/var\(--(?:bg-card|nested-block-bg),\s*rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*(?:0?\.\d+|1(?:\.0+)?)\s*\)\)/gi, (match) => (
        match.startsWith('var(--bg-card') ? 'var(--bg-card)' : 'var(--nested-block-bg)'
      ))
      .replace(WHITE_ALPHA, 'var(--nested-block-bg)');
    if (DARK_ALPHA.test(next) || DARK_GRADIENT.test(next)) {
      const quote = next[0] === '"' || next[0] === "'" || next[0] === '`' ? next[0] : "'";
      next = `${quote}var(--nested-block-bg)${quote}`;
    }
    return next === text ? null : {
      start: initializer.getStart(),
      end: initializer.end,
      text: next,
    };
  }

  if (TEXT_PROPERTIES.has(name)) {
    const parent = property.parent;
    const hasSemanticBackground = ts.isObjectLiteralExpression(parent)
      && parent.properties.some((sibling) => {
        const siblingName = nameOf(sibling);
        if (!SURFACE_PROPERTIES.has(siblingName)) return false;
        const siblingText = sibling.initializer.getText();
        return ![
          'transparent',
          'none',
          'var(--bg-',
          'var(--nested-block-bg',
          'rgba(255',
        ].some((signal) => siblingText.includes(signal));
      });
    if (hasSemanticBackground) return null;

    const next = text.replace(WHITE_ALPHA, (match) => {
      const alphaMatch = match.match(/,\s*(0?\.\d+|1(?:\.0+)?)\s*\)$/);
      const alpha = Number(alphaMatch?.[1] ?? 1);
      if (alpha >= 0.8) return 'var(--text-primary)';
      if (alpha >= 0.5) return 'var(--text-secondary)';
      return 'var(--text-muted)';
    });
    return next === text ? null : {
      start: initializer.getStart(),
      end: initializer.end,
      text: next,
    };
  }

  return null;
}

function collectEdits(sourceFile) {
  const edits = [];
  function visit(node) {
    if (ts.isPropertyAssignment(node)) {
      const edit = migrateInitializer(sourceFile.text, node);
      if (edit !== null) edits.push(edit);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return edits.sort((left, right) => right.start - left.start);
}

let changedFiles = 0;
let changedValues = 0;
let skippedIntentional = 0;

for (const filePath of filePaths) {
  const absolutePath = path.resolve(filePath);
  const relativePath = path.relative(sourceRoot, absolutePath).replace(/\\/g, '/');
  if (intentionalPaths.has(relativePath)) {
    skippedIntentional += 1;
    continue;
  }

  const source = readFileSync(absolutePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    absolutePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const edits = collectEdits(sourceFile);
  if (edits.length === 0) continue;

  let output = source;
  for (const edit of edits) {
    output = `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`;
  }
  if (write) writeFileSync(absolutePath, output);
  changedFiles += 1;
  changedValues += edits.length;
  console.log(`${write ? 'migrated' : 'would migrate'} ${relativePath}: ${edits.length} values`);
}

console.log(
  `${write ? 'Migrated' : 'Would migrate'} ${changedFiles} files and ${changedValues} adaptive values; skipped ${skippedIntentional} classified intentional files.`,
);
