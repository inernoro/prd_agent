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

const SEMANTIC_BACKGROUND =
  /\b(?:bg|from|via|to)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-/;
const DARK_OVERLAY_LAYOUT = /\b(?:absolute|fixed|inset-\d|inset-0|backdrop|top-\d|bottom-\d)\b/;
const TEXT_WHITE = /\btext-white(?:\/(\d+)|\/\[([^\]]+)\])?\b/g;
const FIXED_BLACK_SURFACE = /\bbg-black(?:\/(?:\d+|\[[^\]]+\]))?\b/g;
const FIXED_BLACK_HOVER = /\bhover:bg-black(?:\/(?:\d+|\[[^\]]+\]))?\b/g;

function opacityValue(integerOpacity, arbitraryOpacity) {
  if (integerOpacity !== undefined) return Number(integerOpacity) / 100;
  if (arbitraryOpacity !== undefined) {
    const parsed = Number(arbitraryOpacity);
    return Number.isFinite(parsed) ? parsed : 1;
  }
  return 1;
}

function tokenForOpacity(opacity) {
  if (opacity >= 0.8) return 'text-token-primary';
  if (opacity >= 0.5) return 'text-token-secondary';
  return 'text-token-muted';
}

function migrateClassText(text) {
  const semanticContrast = SEMANTIC_BACKGROUND.test(text);
  const darkOverlay = FIXED_BLACK_SURFACE.test(text) && DARK_OVERLAY_LAYOUT.test(text);
  FIXED_BLACK_SURFACE.lastIndex = 0;

  let output = text;
  if (!darkOverlay) {
    output = output
      .replace(FIXED_BLACK_HOVER, 'hover-bg-soft')
      .replace(FIXED_BLACK_SURFACE, 'bg-token-nested');
  }
  if (!semanticContrast && !darkOverlay) {
    output = output.replace(TEXT_WHITE, (_match, integerOpacity, arbitraryOpacity) => (
      tokenForOpacity(opacityValue(integerOpacity, arbitraryOpacity))
    ));
  }
  TEXT_WHITE.lastIndex = 0;
  return output;
}

function collectEdits(sourceFile) {
  const edits = [];
  function visit(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const next = migrateClassText(node.text);
      if (next !== node.text) {
        edits.push({
          start: node.getStart() + 1,
          end: node.end - 1,
          text: next,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return edits.sort((left, right) => right.start - left.start);
}

let changedFiles = 0;
let changedStrings = 0;
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
  changedStrings += edits.length;
  console.log(`${write ? 'migrated' : 'would migrate'} ${relativePath}: ${edits.length} class strings`);
}

console.log(
  `${write ? 'Migrated' : 'Would migrate'} ${changedFiles} files and ${changedStrings} class strings; skipped ${skippedIntentional} classified intentional files.`,
);
