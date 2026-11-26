import type { DesignMaterial, DesignVersion } from '../../../../src/shared/design-workspace';

export type StructureChange = { id: string; label: string; kind: '新增' | '修改' | '移除'; text: string };

const attributeNames: Record<string, string> = {
  name: '名称', value: '值', light: '浅色', dark: '深色', use: '用途', size: '字号', weight: '字重',
  colors: '颜色', typography: '字阶', font: '字体', spacing: '间距', radius: '圆角',
};

export function describeDesignValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(describeDesignValue).join('、');
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([key, item]) => `${attributeNames[key] ?? key} ${describeDesignValue(item)}`).join(' · ');
  }
  return String(value ?? '');
}

export function describeMaterialChange(row: StructureChange): { label: string; detail: string } | undefined {
  const group = row.label.split(' · ')[0];
  if (group === '令牌') {
    const key = row.label.split(' · ')[1].split('/').at(-1)!;
    return { label: group + ' · ' + (attributeNames[key] ?? key), detail: describeDesignValue(JSON.parse(row.text)) };
  }
  if (row.text.startsWith('|')) {
    const [title, ...details] = row.text.split('|').map(cell => cell.trim()).filter(Boolean);
    if (!title || /^(编号|名称|规则编号|组件)$/.test(title)) return;
    return { label: `${group} · ${title}`, detail: details.join(' · ') };
  }
  return { label: group, detail: row.text };
}

function compare(label: string, before: Map<string, string>, after: Map<string, string>) {
  const changed: StructureChange[] = [];
  for (const [key, value] of before) {
    if (!after.has(key)) changed.push({ id: `${label}/${key}`, label: `${label} · ${key}`, kind: '移除', text: value });
  }
  for (const [key, value] of after) {
    const original = before.get(key);
    if (original === value) continue;
    changed.push({ id: `${label}/${key}`, label: `${label} · ${key}`, kind: original === undefined ? '新增' : '修改', text: value });
  }
  return changed;
}

function markdown(source: string | undefined, group: string) {
  return new Map((source ?? '').trim().split(/\r?\n/).flatMap((line, index) => {
    const text = line.trim();
    if (!text || /^\|[ :|\-]+\|$/.test(text)) return [];
    const id = text.match(/^(?:\|\s*|#{2,4}\s+)(R[-_]\d+)/)?.[1] ?? String(index + 1);
    // If headings or table lines carry stable rule IDs, keep their real labels in the comparison.
    return [[`${group}/${id}`, text.replace(/^#{1,5}\s+/, '')] as const];
  }));
}

function tokens(material: DesignMaterial) {
  return new Map(Object.entries(material.tokens ?? {}).flatMap(([key, value]) => {
    if (key === 'source') return [];
    if (Array.isArray(value)) return value.map((row, index) => {
      const name = row && typeof row === 'object' ? row.name ?? row.use : undefined;
      return [`${key}/${typeof name === 'string' ? name : index + 1}`, JSON.stringify(row)] as const;
    });
    return [[key, JSON.stringify(value)] as const];
  }));
}

export function compareDesignMaterial(before: DesignMaterial, after: DesignMaterial) {
  const changes = compare('令牌', tokens(before), tokens(after));
  for (const [key, label] of ([['components', '组件'], ['skeleton', '骨架'], ['rules', '规则']] as const)) {
    changes.push(...compare(label, markdown(before[key], key), markdown(after[key], key)));
  }
  return changes;
}

export function compareDesignStructure(before: DesignVersion, after: DesignVersion) {
  const acceptance = (version: DesignVersion) => new Map(version.acceptance.map(rule =>
    [rule.id, `${rule.rule} · ${rule.how} · ${rule.slots.join(' / ')}${rule.expected ? ` · ${rule.expected}` : ''}`]));
  const checks = (version: DesignVersion) => new Map((Array.isArray(version.checks?.items) ? version.checks.items : []).flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    return [[String(item.id ?? index + 1), String(item.label ?? item.rule ?? item.title ?? JSON.stringify(item))] as const];
  }));
  return [...compareDesignMaterial(before.spec, after.spec), ...compare('验收项', acceptance(before), acceptance(after)),
    ...compare('自检', checks(before), checks(after))];
}
