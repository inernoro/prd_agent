import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 一条豁免要成立，必须四样俱全：明确开关、说得出理由、留得下决定人和日期、有复审期限。
// 缺任何一样都按「没登记」处理——半条豁免比没有豁免更危险，它看着像有人决定过。
const REQUIRED_TEXT_FIELDS = ['reason', 'decidedBy', 'decidedAt', 'reviewBy', 'residualRisk'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function evaluateExemption(registry, family, environment, today) {
  const entry = registry?.[family]?.[environment];
  if (!entry || typeof entry !== 'object') {
    return { exempt: false, status: 'not-registered' };
  }
  if (entry.exempt !== true) {
    return { exempt: false, status: 'not-registered' };
  }

  const missing = REQUIRED_TEXT_FIELDS.filter(
    (field) => typeof entry[field] !== 'string' || entry[field].trim() === '',
  );
  if (missing.length > 0) {
    return { exempt: false, status: 'incomplete', missing };
  }
  if (!ISO_DATE.test(entry.decidedAt) || !ISO_DATE.test(entry.reviewBy)) {
    return { exempt: false, status: 'bad-date' };
  }
  // 到期即失效：临时决定不许无声变成永久盲区，到点必须有人再看一眼。
  if (entry.reviewBy < today) {
    return { exempt: false, status: 'expired', reviewBy: entry.reviewBy, entry };
  }
  return { exempt: true, status: 'active', entry };
}

export function loadRegistry(registryPath) {
  if (!fs.existsSync(registryPath)) return {};
  return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

export function runCli() {
  const family = argumentValue('--family');
  const environment = argumentValue('--environment');
  const today = argumentValue('--today') || new Date().toISOString().slice(0, 10);
  const registryPath = argumentValue('--registry')
    || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'external-audit-exemptions.json');

  if (!family || !environment) throw new Error('usage: --family <ipv4|ipv6> --environment <name>');

  const result = evaluateExemption(loadRegistry(registryPath), family, environment, today);

  if (result.status === 'incomplete') {
    console.log(`::error::${environment} 的 ${family} 豁免登记不完整，缺少：${result.missing.join(', ')}。`);
    console.log('豁免必须写清理由、决定人、决定日期、复审日期与残留风险，否则无法与「忘了配」区分。');
    process.exitCode = 2;
    return;
  }
  if (result.status === 'bad-date') {
    console.log(`::error::${environment} 的 ${family} 豁免登记日期格式不对，需为 YYYY-MM-DD。`);
    process.exitCode = 2;
    return;
  }
  if (result.status === 'expired') {
    console.log(`::error::${environment} 的 ${family} 豁免已于 ${result.reviewBy} 到期，需要重新决定。`);
    console.log('要么恢复巡检（换一个有该协议出网能力的观测点），要么延长登记并写明为什么仍可接受。');
    process.exitCode = 2;
    return;
  }
  if (!result.exempt) {
    console.log('exempt=false');
    return;
  }

  console.log('exempt=true');
  console.log(`::notice::${environment} 的 ${family} 对外端口巡检按登记豁免，本次未扫描。`);
  console.log(`理由：${result.entry.reason}`);
  console.log(`残留风险：${result.entry.residualRisk}`);
  console.log(`决定人 ${result.entry.decidedBy}，决定于 ${result.entry.decidedAt}，复审期限 ${result.entry.reviewBy}。`);
  console.log('注意：这不代表该暴露面安全，只代表已有人决定不查。');
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) runCli();
