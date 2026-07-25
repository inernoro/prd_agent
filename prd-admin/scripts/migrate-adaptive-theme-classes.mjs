#!/usr/bin/env node
/* global console, process */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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

const BORDER_CLASS = /\b(border(?:-[tblrxy])?)-(?:white|black)(?:\/(?:\d+|\[[^\]]+\]))?\b/g;
const DIVIDE_CLASS = /\b(divide(?:-[xy])?)-(?:white|black)(?:\/(?:\d+|\[[^\]]+\]))?\b/g;
const HOVER_SURFACE_CLASS = /\bhover:bg-white(?:\/(?:\d+|\[[^\]]+\]))?\b/g;
const SURFACE_CLASS = /(?<!hover:)\bbg-white\/(?:\d+|\[[^\]]+\])/g;
const FIXED_DARK_SURFACE_CLASS = /\bbg-\[#(?:0c0d0f|16171a|16171b|1a1c20)\]\b/gi;

function borderReplacement(_match, prefix) {
  const side = prefix.slice('border'.length);
  return `border${side}-token-subtle`;
}

function divideReplacement() {
  return 'divide-token-subtle';
}

function migrate(source) {
  return source
    .replace(HOVER_SURFACE_CLASS, 'hover-bg-soft')
    .replace(BORDER_CLASS, borderReplacement)
    .replace(DIVIDE_CLASS, divideReplacement)
    .replace(FIXED_DARK_SURFACE_CLASS, 'bg-token-nested')
    .replace(SURFACE_CLASS, 'bg-token-nested');
}

let changedFiles = 0;
let changedOccurrences = 0;
let skippedIntentional = 0;

for (const filePath of filePaths) {
  const relativePath = path.relative(sourceRoot, path.resolve(filePath)).replace(/\\/g, '/');
  if (intentionalPaths.has(relativePath)) {
    skippedIntentional += 1;
    continue;
  }
  const source = readFileSync(filePath, 'utf8');
  const output = migrate(source);
  if (output === source) continue;

  const beforeRiskCount = [
    ...source.matchAll(BORDER_CLASS),
    ...source.matchAll(DIVIDE_CLASS),
    ...source.matchAll(HOVER_SURFACE_CLASS),
    ...source.matchAll(FIXED_DARK_SURFACE_CLASS),
    ...source.matchAll(SURFACE_CLASS),
  ].length;
  const afterRiskCount = [
    ...output.matchAll(BORDER_CLASS),
    ...output.matchAll(DIVIDE_CLASS),
    ...output.matchAll(HOVER_SURFACE_CLASS),
    ...output.matchAll(FIXED_DARK_SURFACE_CLASS),
    ...output.matchAll(SURFACE_CLASS),
  ].length;

  changedFiles += 1;
  changedOccurrences += beforeRiskCount - afterRiskCount;
  if (write) writeFileSync(filePath, output);
  console.log(`${write ? 'migrated' : 'would migrate'} ${filePath}`);
}

console.log(
  `${write ? 'Migrated' : 'Would migrate'} ${changedFiles} files and removed ${changedOccurrences} adaptive class risks; skipped ${skippedIntentional} classified intentional files.`,
);
