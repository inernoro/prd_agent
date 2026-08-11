import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function readArg(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || '' : '';
}

function screenshotName(row, index) {
  const source = String(row.screenshot || row.path || '').trim();
  const stem = source ? basename(source, extname(source)) : String(row.slotId || `visual-${index + 1}`);
  return `${String(index + 1).padStart(3, '0')}-${stem}`;
}

const STATUS_SEVERITY = new Map([
  ['未记录', 0],
  ['通过', 10],
  ['部分通过', 20],
  ['未执行', 30],
  ['需补证', 40],
  ['需干预', 50],
  ['不通过', 60],
]);

function strictVisualStatus(row) {
  const candidates = [row.finalStatus, row.status, row.automatedStatus, row.manualStatus]
    .map((value) => String(value || '').trim())
    .filter((value) => STATUS_SEVERITY.has(value) && value !== '未记录');
  if (candidates.length === 0) return '';
  return candidates.reduce((strictest, current) =>
    STATUS_SEVERITY.get(current) > STATUS_SEVERITY.get(strictest) ? current : strictest);
}

export function normalizeVisualLedger(rows) {
  if (!Array.isArray(rows)) throw new Error('视觉台账必须是数组');
  return rows.map((row, index) => {
    const sourcePath = String(row.sourceScreenshot || row.screenshot || row.path || '').trim();
    const sourceManifestPath = sourcePath ? resolve(dirname(sourcePath), 'manifest.json') : '';
    let sourceEvidence = {};
    if (sourceManifestPath && existsSync(sourceManifestPath)) {
      try {
        const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, 'utf8'));
        const sourceName = basename(sourcePath, extname(sourcePath));
        sourceEvidence = sourceManifest.find((item) => item.name === sourceName || resolve(item.path || '') === resolve(sourcePath)) || {};
      } catch {
        sourceEvidence = {};
      }
    }
    const primaryState = String(row.primaryState || '').trim();
    const finalStatus = strictVisualStatus(row);
    return {
      name: screenshotName(row, index),
      module: row.module,
      slotId: row.slotId,
      primaryState,
      coverageStates: primaryState ? [primaryState] : [],
      testType: row.testType,
      status: finalStatus,
      automatedStatus: row.automatedStatus || '未记录',
      manualStatus: row.manualStatus || '未记录',
      theme: row.theme,
      viewportClass: row.viewportClass,
      methodAnchor: row.methodAnchor,
      breadcrumb: row.breadcrumb,
      caption: row.manualReason || '按当前主验收状态核对页面完整性与可操作性',
      path: row.screenshot || row.path,
      sha256: row.sha256,
      annotated: sourceEvidence.annotated,
      overview: sourceEvidence.overview,
      viewport: sourceEvidence.viewport,
      touchPoints: sourceEvidence.touchPoints,
      isMobile: sourceEvidence.isMobile,
      deviceName: sourceEvidence.deviceName,
      mobilePathId: sourceEvidence.mobilePathId,
      mobileStage: sourceEvidence.mobileStage,
      failureEvidence: finalStatus === '不通过' ? true : sourceEvidence.failureEvidence,
      failureReason: finalStatus === '不通过'
        ? row.manualReason || sourceEvidence.failureReason || '人工视觉复核判定该状态不通过'
        : sourceEvidence.failureReason,
      warnings: sourceEvidence.warnings,
    };
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const input = readArg(argv, '--input');
  const output = readArg(argv, '--output');
  if (!input || !output) throw new Error('必须提供 --input 和 --output');
  const rows = JSON.parse(readFileSync(resolve(input), 'utf8'));
  const manifest = normalizeVisualLedger(rows);
  writeFileSync(resolve(output), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ evidence: manifest.length, output: resolve(output) })}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
