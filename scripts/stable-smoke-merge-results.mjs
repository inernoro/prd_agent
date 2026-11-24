import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function readRepeatedArgs(argv, name) {
  return argv.flatMap((value, index) => value === name && argv[index + 1] ? [argv[index + 1]] : []);
}

function readArg(argv, name, fallback = '') {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || fallback : fallback;
}

export function mergePlaywrightReports(reports) {
  const valid = reports.filter(Boolean);
  return {
    config: valid.at(-1)?.config || {},
    suites: valid.flatMap((report) => report.suites || []),
    errors: valid.flatMap((report) => report.errors || []),
    stats: valid.reduce((stats, report) => ({
      startTime: stats.startTime || report.stats?.startTime || '',
      duration: stats.duration + (report.stats?.duration || 0),
      expected: stats.expected + (report.stats?.expected || 0),
      unexpected: stats.unexpected + (report.stats?.unexpected || 0),
      flaky: stats.flaky + (report.stats?.flaky || 0),
      skipped: stats.skipped + (report.stats?.skipped || 0),
    }), { startTime: '', duration: 0, expected: 0, unexpected: 0, flaky: 0, skipped: 0 }),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const inputs = readRepeatedArgs(argv, '--input');
  const output = readArg(argv, '--output');
  if (inputs.length === 0 || !output) throw new Error('用法：--input <results.json> 可重复，且必须提供 --output');
  const reports = inputs.map((path) => JSON.parse(readFileSync(resolve(path), 'utf8')));
  writeFileSync(resolve(output), `${JSON.stringify(mergePlaywrightReports(reports), null, 2)}\n`, 'utf8');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
