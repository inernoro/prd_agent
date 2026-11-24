import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { compare } from './metrics.mjs';
const [resultPath, baselinePath, outputFlag, outputPath] = process.argv.slice(2);
if (!resultPath || !baselinePath || (outputFlag && (outputFlag !== '--out' || !outputPath)))
  throw new Error('用法: node compare.mjs result.json baseline.json [--out evaluation.json]');
const rawResult = fs.readFileSync(resultPath), rawBaseline = fs.readFileSync(baselinePath);
const result = JSON.parse(rawResult), baseline = JSON.parse(rawBaseline);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const evaluation = { schema: 1, evaluatedAt: new Date().toISOString(), policyVersion: baseline.policyVersion ?? 1,
  sourceCommit: result.commit, resultSha256: hash(rawResult), baselineSha256: hash(rawBaseline),
  originalComparison: result.comparison ?? null, comparison: compare(result, baseline) };
if (outputPath) fs.writeFileSync(outputPath, JSON.stringify(evaluation, null, 2) + '\n');
console.log(JSON.stringify(evaluation, null, 2));
if (!evaluation.comparison.pass) process.exitCode = 1;
