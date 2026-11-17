import fs from 'node:fs';
import { executionErrors } from './metrics.mjs';
const result = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (executionErrors(result).length || result.failure || result.injectionMs !== 350 || result.comparison?.pass !== false
    || !result.comparison.failures.some(line => /(?:document-open|write-save|write-readback): app p95/.test(line))) {
  throw new Error('负例未证明真实应用耗时退化被检测，基础设施失败或契约不匹配不算成功');
}
console.log(JSON.stringify({ injectedMs: result.injectionMs, detected: true, failures: result.comparison.failures }, null, 2));
