#!/usr/bin/env node
/* global console, process */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const write = process.argv.includes('--write');
const includeIntentional = process.argv.includes('--include-intentional');
const filePaths = process.argv
  .slice(2)
  .filter((value) => value !== '--write' && value !== '--include-intentional');
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

const WHITE_ALPHA = /rgba\(\s*255\s*,\s*255\s*,\s*255\s*,/i;
const THEME_BORDER_FALLBACK = /var\(--(?:border-(?:subtle|faint)|glass-border),/i;

function literalValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text.replace(/\s+/g, ' ').trim();
  }
  return null;
}

function propertyName(property) {
  if (!ts.isPropertyAssignment(property)) return null;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) {
    return property.name.text;
  }
  return null;
}

function adaptiveClasses(property) {
  const name = propertyName(property);
  const value = ts.isPropertyAssignment(property) ? literalValue(property.initializer) : null;
  if (name === null || value === null) return null;

  if (
    (name === 'background' || name === 'backgroundColor')
    && WHITE_ALPHA.test(value)
    && !value.includes('gradient')
  ) {
    return ['bg-token-nested'];
  }

  const borderProperty = {
    border: ['border', 'border-token-subtle'],
    borderTop: ['border-t', 'border-t-token-subtle'],
    borderRight: ['border-r', 'border-r-token-subtle'],
    borderBottom: ['border-b', 'border-b-token-subtle'],
    borderLeft: ['border-l', 'border-l-token-subtle'],
    borderColor: ['border-token-subtle'],
  }[name];
  if (borderProperty === undefined) return null;
  if (!WHITE_ALPHA.test(value) && !THEME_BORDER_FALLBACK.test(value)) return null;

  if (name === 'borderColor') return borderProperty;
  if (!/^1px solid /i.test(value)) return null;
  return borderProperty;
}

function classInsertion(sourceFile, classAttribute, classes) {
  if (classAttribute === undefined) return null;
  const initializer = classAttribute.initializer;
  if (initializer === undefined) return null;
  if (ts.isStringLiteral(initializer)) {
    return { start: initializer.end - 1, end: initializer.end - 1, text: ` ${classes}` };
  }
  if (!ts.isJsxExpression(initializer) || initializer.expression === undefined) return null;

  const expression = initializer.expression;
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return { start: expression.end - 1, end: expression.end - 1, text: ` ${classes}` };
  }
  if (ts.isTemplateExpression(expression)) {
    return { start: expression.end - 1, end: expression.end - 1, text: ` ${classes}` };
  }
  if (
    ts.isCallExpression(expression)
    && ts.isIdentifier(expression.expression)
    && ['cn', 'clsx'].includes(expression.expression.text)
  ) {
    const prefix = expression.arguments.length === 0 ? '' : ', ';
    return {
      start: expression.end - 1,
      end: expression.end - 1,
      text: `${prefix}${JSON.stringify(classes)}`,
    };
  }
  return null;
}

function collectEdits(source, sourceFile) {
  const edits = [];

  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
      const styleAttribute = attributes.find((attribute) => attribute.name.text === 'style');
      if (
        styleAttribute?.initializer !== undefined
        && ts.isJsxExpression(styleAttribute.initializer)
        && styleAttribute.initializer.expression !== undefined
        && ts.isObjectLiteralExpression(styleAttribute.initializer.expression)
      ) {
        const styleObject = styleAttribute.initializer.expression;
        const migrated = styleObject.properties
          .map((property) => ({ property, classes: adaptiveClasses(property) }))
          .filter((entry) => entry.classes !== null);

        if (migrated.length > 0) {
          const classes = [...new Set(migrated.flatMap((entry) => entry.classes))].join(' ');
          const classAttribute = attributes.find((attribute) => attribute.name.text === 'className');
          const insertion = classInsertion(sourceFile, classAttribute, classes);
          if (classAttribute === undefined || insertion !== null) {
            const migratedProperties = new Set(migrated.map((entry) => entry.property));
            const remaining = styleObject.properties.filter(
              (property) => !migratedProperties.has(property),
            );
            const styleReplacement = remaining.length === 0
              ? ''
              : `style={{ ${remaining.map((property) => property.getText(sourceFile)).join(', ')} }}`;
            edits.push({
              start: styleAttribute.getStart(sourceFile),
              end: styleAttribute.end,
              text: styleReplacement,
            });
            if (classAttribute === undefined) {
              edits.push({
                start: styleAttribute.getStart(sourceFile),
                end: styleAttribute.getStart(sourceFile),
                text: `className=${JSON.stringify(classes)} `,
              });
            } else {
              edits.push(insertion);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return edits.sort((left, right) => right.start - left.start);
}

let changedFiles = 0;
let totalEdits = 0;
let skippedIntentional = 0;

for (const filePath of filePaths) {
  const absolutePath = path.resolve(filePath);
  const relativePath = path.relative(sourceRoot, absolutePath).replace(/\\/g, '/');
  if (!includeIntentional && intentionalPaths.has(relativePath)) {
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
  const edits = collectEdits(source, sourceFile);
  if (edits.length === 0) continue;

  let output = source;
  for (const edit of edits) {
    output = `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`;
  }
  if (write) writeFileSync(absolutePath, output);
  changedFiles += 1;
  totalEdits += edits.length;
  console.log(`${write ? 'migrated' : 'would migrate'} ${relativePath}: ${edits.length} source edits`);
}

console.log(
  `${write ? 'Migrated' : 'Would migrate'} ${changedFiles} files with ${totalEdits} source edits; skipped ${skippedIntentional} classified intentional files.`,
);
