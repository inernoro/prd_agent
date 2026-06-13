/**
 * 生成产品管理智能体全量功能目录测试 Excel（与 feature-import-structure 列格式一致）。
 * 用法：node scripts/generate-product-agent-feature-test-xlsx.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataPath = join(__dirname, 'data/product-agent-feature-catalog-test.json');
const outPath = join(__dirname, '../public/templates/product-agent-feature-catalog-test.xlsx');

const HEADERS = ['目录路径', '功能名称', '等级', '功能类型', '所属模块', '描述', '外部ID', '关键规则', '验收标准'];

const rows = JSON.parse(readFileSync(dataPath, 'utf8'));
const matrix = [
  HEADERS,
  ...rows.map((r) => [
    r.path,
    r.title,
    r.grade ?? '',
    r.type ?? '',
    r.module ?? '',
    r.desc ?? '',
    r.externalId ?? '',
    r.keyRules ?? '',
    r.acceptance ?? '',
  ]),
];

const workbook = XLSX.utils.book_new();
const sheet = XLSX.utils.aoa_to_sheet(matrix);
sheet['!cols'] = [
  { wch: 42 },
  { wch: 22 },
  { wch: 6 },
  { wch: 14 },
  { wch: 12 },
  { wch: 36 },
  { wch: 16 },
  { wch: 32 },
  { wch: 28 },
];
XLSX.utils.book_append_sheet(workbook, sheet, '功能目录');
writeFileSync(outPath, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
console.log(`Wrote ${rows.length} rows -> ${outPath}`);
