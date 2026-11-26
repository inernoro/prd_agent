import { buildZip, type ZipEntry } from '../../src/utils/zip.js';
import { designAcceptancePolicy } from '../../src/shared/design-acceptance-standard.mjs';

type PriorFixture = { commit: string; addedScreens?: string[]; removedScreens?: string[]; changedRules?: string[] };

export function withAcceptanceStandard<T extends Record<string, unknown>>(manifest: T) {
  const rules: Record<string, unknown>[] = Array.isArray(manifest.acceptance) ? manifest.acceptance : [];
  const acceptance = rules.map(rule => ({ ...rule, dimension: rule.dimension ?? 'correctness' }));
  const required = new Set(['mece', 'compare', 'visual']);
  if (rules.some(rule => rule.how === 'human')) required.add('human');
  if (rules.some(rule => rule.interaction === true)) required.add('flow');
  const acceptancePlan = Object.fromEntries(designAcceptancePolicy.methods.map(({ id }) => [id, required.has(id)
    ? { applicable: true }
    : { applicable: false, reason: 'The synthetic fixture exercises only its declared screen and rules.' }]));
  const risks = designAcceptancePolicy.dimensions.filter(({ id }) => !acceptance.some(rule => rule.dimension === id))
    .map(({ id, label }) => ({ dimension: id, risk: label, reason: 'This dimension is outside the synthetic fixture.' }));
  return { acceptancePlan, risks, ...manifest, acceptance };
}

export function versionedDesignFixture(manifest: Record<string, unknown>, rationale: string, files: ZipEntry[], prior?: PriorFixture) {
  const version = prior ? 2 : 1;
  const history = prior ? [{ version: 1, commit: prior.commit }] : [];
  const json = (name: string, value: unknown): ZipEntry => ({ name, data: JSON.stringify(value) });
  const entry = { prototypeVersion: version, date: '2026-11-24', notes: '', rationale: '思路.md', prototype: 'dist/index.html',
    checks: 'checks/result.json', docs: [], ...manifest };
  const index = { to: version, from: [] as unknown[] };
  const published: ZipEntry[] = [json('design.json', withAcceptanceStandard(entry)),
    { name: '思路.md', data: `# Fixture purpose（V${version}）\n${rationale}` },
    { name: '交付说明.md', data: `# Fixture delivery（V${version}）\nOpen the archived example.` },
    json('checks/result.json', { passed: 0, total: 0, items: [] }), json('versions.json', { versions: history }),
  ];
  if (prior) {
    const summary = 'changes/v1-v2/summary.json';
    const notes = 'changes/v1-v2/changes.md';
    const screens = { added: (prior.addedScreens ?? []).map(id => ({ id })), removed: (prior.removedScreens ?? []).map(id => ({ id })), changed: [] };
    const acceptance = { added: [], removed: [], changed: (prior.changedRules ?? []).map(id => ({ id })) };
    index.from.push({ ...history[0], files: [summary, notes], sourceFiles: 0,
      acceptance: { added: 0, removed: 0, changed: acceptance.changed.length },
      screens: { added: screens.added.length, removed: screens.removed.length, changed: 0 } });
    published.push(json(summary, { from: history[0], to: { version }, direction: 'upgrade', screens, acceptance,
      source: { files: 0, bytes: 0 } }),
    { name: notes, data: '# Fixture revision\nSee the versioned screen list.' });
  }
  published.push(json('changes/index.json', index), ...files);
  return buildZip(published.map(file => ({ ...file, name: `bundle/${file.name}` })));
}
