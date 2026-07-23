#!/usr/bin/env node
/* global console, process */

import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

const write = process.argv.includes('--write');
const filePaths = process.argv.slice(2).filter((value) => value !== '--write');

const VALUE_CLASSES = new Map([
  ['color:var(--text-primary)', 'text-token-primary'],
  ['color:var(--text-secondary)', 'text-token-secondary'],
  ['color:var(--text-muted)', 'text-token-muted'],
  ['color:var(--accent-primary)', 'text-token-accent'],
  ['color:var(--accent-gold)', 'text-token-accent'],
  ['color:var(--status-error)', 'text-token-error'],
  ['color:var(--status-done)', 'text-token-success'],
  ['color:var(--status-going)', 'text-token-warning'],
  ['background:var(--nested-block-bg)', 'bg-token-nested'],
  ['background:var(--bg-card)', 'bg-token-card'],
  ['background:var(--bg-input)', 'bg-token-input'],
  ['background:var(--bg-input-hover)', 'bg-token-input-hover'],
  ['background:var(--bg-card-hover)', 'bg-token-card-hover'],
  ['border:1px solid var(--border-subtle)', 'border border-token-subtle'],
  ['border:1px solid var(--border-default)', 'border border-token-default'],
  ['border:1px solid var(--nested-block-border)', 'border border-token-nested'],
  ['borderTop:1px solid var(--border-subtle)', 'border-t border-token-subtle'],
  ['borderTop:1px solid var(--nested-block-border)', 'border-t border-token-nested'],
  ['borderBottom:1px solid var(--border-subtle)', 'border-b border-token-subtle'],
  ['borderBottom:1px solid var(--nested-block-border)', 'border-b border-token-nested'],
  ['wordBreak:break-word', 'break-words'],
  ['alignItems:stretch', 'items-stretch'],
  ['minWidth:0', 'min-w-0'],
  ['margin:0', 'm-0'],
  ['overflow:auto', 'overflow-auto'],
  ['overflow:hidden', 'overflow-hidden'],
  ['display:block', 'block'],
  ['display:flex', 'flex'],
  ['flexDirection:column', 'flex-col'],
  ['width:100%', 'w-full'],
  ['objectFit:contain', 'object-contain'],
]);

function literalValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text.replace(/\s+/g, ' ').trim();
  }
  if (ts.isNumericLiteral(node)) {
    return node.text;
  }
  return null;
}

function propertyClass(property) {
  if (!ts.isPropertyAssignment(property) || property.name === undefined) {
    return null;
  }

  const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
    ? property.name.text
    : null;
  const value = literalValue(property.initializer);
  if (name === null || value === null) {
    return null;
  }

  if (name === 'opacity' && /^0(?:\.\d+)?$|^1$/.test(value)) {
    const percent = Math.round(Number(value) * 100);
    if ([0, 5, 10, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90, 95, 100].includes(percent)) {
      return `opacity-${percent}`;
    }
  }

  const normalizedValue = value
    .replace(/^var\(--bg-card,\s*[^)]+\)$/, 'var(--bg-card)')
    .replace(/\s+/g, ' ')
    .trim();
  return VALUE_CLASSES.get(`${name}:${normalizedValue}`) ?? null;
}

function styleClasses(attribute) {
  if (
    attribute.initializer === undefined
    || !ts.isJsxExpression(attribute.initializer)
    || attribute.initializer.expression === undefined
    || !ts.isObjectLiteralExpression(attribute.initializer.expression)
  ) {
    return null;
  }

  const classes = attribute.initializer.expression.properties.map(propertyClass);
  if (classes.length === 0 || classes.some((value) => value === null)) {
    return null;
  }
  return [...new Set(classes)].join(' ');
}

function classInsertion(source, attribute, classes) {
  const initializer = attribute.initializer;
  if (initializer === undefined) {
    return null;
  }
  if (ts.isStringLiteral(initializer)) {
    return { start: initializer.end - 1, end: initializer.end - 1, text: ` ${classes}` };
  }
  if (!ts.isJsxExpression(initializer) || initializer.expression === undefined) {
    return null;
  }

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
      if (styleAttribute !== undefined) {
        const classes = styleClasses(styleAttribute);
        if (classes !== null) {
          const classAttribute = attributes.find((attribute) => attribute.name.text === 'className');
          if (classAttribute === undefined) {
            edits.push({
              start: styleAttribute.getStart(sourceFile),
              end: styleAttribute.end,
              text: `className=${JSON.stringify(classes)}`,
            });
          } else {
            const insertion = classInsertion(source, classAttribute, classes);
            if (insertion !== null) {
              edits.push(insertion);
              edits.push({
                start: styleAttribute.getFullStart(),
                end: styleAttribute.end,
                text: '',
              });
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

let totalEdits = 0;
let changedFiles = 0;

for (const filePath of filePaths) {
  const source = readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const edits = collectEdits(source, sourceFile);
  if (edits.length === 0) {
    continue;
  }

  let output = source;
  for (const edit of edits) {
    output = `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`;
  }
  changedFiles += 1;
  totalEdits += edits.length;
  if (write) {
    writeFileSync(filePath, output);
  }
  console.log(`${write ? 'migrated' : 'would migrate'} ${filePath}: ${edits.length} source edits`);
}

console.log(`${write ? 'Migrated' : 'Would migrate'} ${changedFiles} files with ${totalEdits} source edits.`);
