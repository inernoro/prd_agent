#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

function findRepoRoot() {
  const candidates = [
    process.cwd(),
    path.resolve(process.cwd(), '..'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'cds/web/src/pages/BranchListPage.tsx'))) {
      return candidate;
    }
  }
  throw new Error('Cannot locate repo root from current working directory');
}

const root = findRepoRoot();
const files = {
  branchList: path.join(root, 'cds/web/src/pages/BranchListPage.tsx'),
  drawer: path.join(root, 'cds/web/src/components/BranchDetailDrawer.tsx'),
  splitButton: path.join(root, 'cds/web/src/components/branch/PreviewActionSplitButton.tsx'),
  css: path.join(root, 'cds/web/src/index.css'),
};

const source = Object.fromEntries(
  Object.entries(files).map(([key, file]) => [key, fs.readFileSync(file, 'utf8')]),
);

const failures = [];
const passes = [];

function pass(name) {
  passes.push(name);
}

function fail(name, detail) {
  failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}

function requireContains(key, needle, name) {
  if (source[key].includes(needle)) pass(name);
  else fail(name, `${path.relative(root, files[key])} must contain ${JSON.stringify(needle)}`);
}

function requireNotContains(key, needle, name) {
  if (!source[key].includes(needle)) pass(name);
  else fail(name, `${path.relative(root, files[key])} must not contain ${JSON.stringify(needle)}`);
}

function requireRegex(key, regex, name) {
  if (regex.test(source[key])) pass(name);
  else fail(name, `${path.relative(root, files[key])} must match ${regex}`);
}

// Branch list wide-screen layout: this prevents regression to a fixed 3-column
// grid or to the generic 1360px workspace cap that caused the large empty area.
requireContains('branchList', '<Workspace wide className="cds-branch-list-workspace">', 'branch list uses page-scoped workspace');
requireContains('branchList', 'className="cds-branch-card-grid"', 'branch list uses adaptive grid class');
requireNotContains('branchList', 'grid gap-4 sm:grid-cols-2 2xl:grid-cols-3', 'branch list does not use fixed 3-column Tailwind grid');
requireContains('css', '.cds-workspace.cds-branch-list-workspace', 'branch list workspace overrides generic cap with higher specificity');
requireContains('css', 'max-width: 3000px', 'branch list workspace has wide cap');
requireContains('css', 'grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr));', 'branch grid keeps empty tracks so a single card does not stretch full-width');
requireNotContains('css', 'grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr));', 'branch grid avoids auto-fit single-card stretch regression');

// Preview/release action: the release action must live inside the preview split
// menu on both the branch card and detail drawer. Separate strong action buttons
// in the footer were a known visual regression.
requireContains('splitButton', 'export function PreviewActionSplitButton', 'shared preview split button exists');
requireContains('branchList', "import { PreviewActionSplitButton }", 'branch card imports split preview action');
requireContains('branchList', '<PreviewActionSplitButton', 'branch card renders split preview action');
requireContains('drawer', "import { PreviewActionSplitButton }", 'detail drawer imports split preview action');
requireContains('drawer', '<PreviewActionSplitButton', 'detail drawer renders split preview action');
requireNotContains('branchList', 'title="发布到目标"', 'branch card has no standalone release icon button');
requireNotContains('branchList', 'window.confirm', 'branch card keeps CDS confirm popover instead of native browser confirm');

// Resource chip tone: keep chips subdued but alive. This guards against both
// over-bright chips and the "looks stopped" dim regression. 2026-06-26: chip tone
// gained a leading `isInfra ?` subdued branch (基础设施依赖弱化为次要)，所以断言从
// 「行首 const chipToneClass = chipStatus ===」放宽为「仍按 chipStatus 显式分态映射」，
// 意图不变（line 80 仍钉运行态色值，防 helper 化 / 过亮 / 看着停了的回归）。
requireContains('branchList', "chipStatus === 'running'", 'resource chips use explicit per-status tone mapping');
requireContains('branchList', 'border-emerald-500/25 bg-emerald-500/[0.055]', 'running resource chip has live but subdued tone');

// Database workbench: these are the product-level invariants from the database
// panel redesign. The exact implementation can evolve, but removing these
// signals means the user loses the large workbench / data visibility loop.
requireContains('drawer', 'function ResourceWorkbenchModal', 'resource workbench modal exists');
requireContains('drawer', 'max-w-[1760px]', 'resource workbench has large operation canvas');
requireContains('drawer', "language: 'sql' | 'json' | 'mongo'", 'code editor keeps sql/json/mongo highlighting');
requireContains('drawer', 'function chooseMongoDatabase', 'Mongo default database selector exists');
requireContains('drawer', 'configuredDatabaseNotice', 'Mongo configured/default database feedback exists');
requireContains('drawer', 'function MongoResourceDataPanel', 'Mongo workbench panel exists');
requireContains('drawer', 'function SqlResourceDataPanel', 'SQL workbench panel exists');
requireRegex('drawer', /grid min-h-0 text-sm lg:grid-cols-\[320px_minmax\(0,1fr\)\]/, 'workbench uses side tree plus main operation canvas');

if (failures.length > 0) {
  console.error('CDS UI regression audit failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(`\nPassed checks: ${passes.length}`);
  process.exit(1);
}

console.log(`CDS UI regression audit passed (${passes.length} checks).`);
