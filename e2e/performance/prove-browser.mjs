import fs from 'node:fs';
import { executionErrors, workload, stats } from './metrics.mjs';
const result = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const hits = result.browserInjection?.applied ?? [];
if (executionErrors(result).length || result.failure || result.browserInjection?.delayMs !== 10000
    || new Set(hits.filter(hit => hit.stage === 'home').map(hit => hit.round)).size < workload.browserRepetitions
    || result.comparison?.pass !== false
    || !result.comparison.failures.some(line => line.startsWith('browser/home: ready p95'))
    || result.comparison.failures.some(line => !line.startsWith('browser/')))
  throw new Error('负例未证明：真实首页脚本交付变慢、API未退化且用户可用耗时门禁拒绝');
console.log(JSON.stringify({ detected: true, homeReadyP95Ms: stats(result.browser.samples.home).p95,
  injectedAssetRequests: hits.length, failures: result.comparison.failures }, null, 2));
