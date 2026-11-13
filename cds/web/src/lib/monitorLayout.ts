/** Space-driven density planning from the supplied monitoring artwork. */
export type MonitorDensity = 'auto' | 'L1' | 'L2' | 'L3';
export type MonitorLevel = Exclude<MonitorDensity, 'auto'>;
export interface LayoutCategory { id: string; count: number; reserve?: number }
export interface DensityLevel { key: MonitorLevel; name: string; minWidth: number; rowHeight: number; gap: number; head: number; pad: number }
export const MONITOR_LEVELS: Record<MonitorLevel, DensityLevel> = {
  L1: { key: 'L1', name: '卡片', minWidth: 210, rowHeight: 112, gap: 6, head: 44, pad: 8 },
  L2: { key: 'L2', name: '两行', minWidth: 176, rowHeight: 44, gap: 3, head: 44, pad: 8 },
  L3: { key: 'L3', name: '单行', minWidth: 168, rowHeight: 22, gap: 2, head: 40, pad: 8 },
};
const RICHER: Partial<Record<MonitorLevel, MonitorLevel>> = { L3: 'L2', L2: 'L1' };
interface Unit { indices: number[]; stacked: boolean }
interface StackPlan { height: number; columns: number }
export interface LayoutPart { indices: number[]; stacked: boolean; span: number; width: number; columns: number; rows: number; visible: number; stackColumns?: number }
export interface LayoutBand { level: DensityLevel; parts: LayoutPart[]; rows: number; height: number; spans: number[] }
export interface MonitorLayout { bands: LayoutBand[]; fits: boolean; height: number; width: number; availableHeight: number; narrow: boolean; overflow: boolean }

/** Inputs are the measured workspace, without assumptions about the host navigation. */
export function planMonitorLayout(categories: readonly LayoutCategory[], workspaceWidth: number, workspaceHeight: number, density: MonitorDensity = 'auto', narrow = false): MonitorLayout {
  const width = Math.max(1, workspaceWidth - 24), availableHeight = Math.max(1, workspaceHeight - 12);
  const base = { width, availableHeight, narrow };
  if (!categories.length) return { ...base, bands: [], fits: true, height: 0, overflow: false };
  const countOf = (i: number) => Math.max(1, categories[i].count + (categories[i].reserve ?? 0));
  const unitWidth = Math.max(8, (width - 230) / 24);
  const widthOf = (span: number) => span * unitWidth + (span - 1) * 10;
  if (narrow) {
    return { ...base, fits: false, height: 0, overflow: true, bands: categories.map((category, i) => {
      const visible = category.count <= 8 ? category.count : 6;
      return { level: MONITOR_LEVELS.L2, height: 0, rows: Math.ceil(visible / 2), spans: [24], parts: [{ indices: [i], stacked: false, span: 24, width, columns: 2, rows: Math.ceil(visible / 2) + (visible < category.count ? 1 : 0), visible }] };
    }) };
  }
  const makeUnits = (stacked: boolean, threshold = categories.length > 12 ? 9 : 5): Unit[] => {
    const result: Unit[] = []; let run: number[] = [], accumulated = 0;
    const flush = () => { if (run.length >= 2) result.push({ indices: run, stacked: true }); else run.forEach(i => result.push({ indices: [i], stacked: false })); run = []; };
    categories.forEach((category, i) => {
      if (stacked && category.count <= threshold) { if (accumulated + countOf(i) > 24 && run.length) { flush(); accumulated = 0; } run.push(i); accumulated += countOf(i); }
      else { flush(); accumulated = 0; result.push({ indices: [i], stacked: false }); }
    }); flush(); return result;
  };
  const weightOf = (unit: Unit) => unit.stacked ? unit.indices.reduce((sum, i) => sum + countOf(i) + 1, 0) : countOf(unit.indices[0]);
  const minSpan = (level: DensityLevel) => Math.min(24, Math.max(3, Math.ceil((level.minWidth + 26) / (unitWidth + 10))));
  const stackHeight = (level: DensityLevel, unit: Unit, partWidth: number, columns: number): StackPlan | undefined => {
    if (columns > 1 && (partWidth - 16 - (columns - 1) * 10) / columns < level.minWidth) return undefined;
    const heights = unit.indices.map(i => 26 + countOf(i) * (level.rowHeight + level.gap) - level.gap + 8);
    const target = heights.reduce((a, b) => a + b, 0) / columns, used = [0]; let column = 0;
    heights.forEach(height => { if (used[column] > 0 && used[column] + height > target + 12 && column < columns - 1) used[++column] = 0; used[column] += height; });
    return { height: Math.max(...used) + 8, columns };
  };
  const evaluateBand = (level: DensityLevel, units: Unit[], spans: number[]): LayoutBand => {
    let rows = 0;
    const parts: LayoutPart[] = units.map((unit, p) => {
      const partWidth = widthOf(spans[p]), columns = unit.stacked ? 1 : Math.max(1, Math.min(countOf(unit.indices[0]), Math.floor((partWidth - 10) / (level.minWidth + 6))));
      const need = unit.stacked ? 0 : Math.ceil(countOf(unit.indices[0]) / columns); rows = Math.max(rows, need);
      return { indices: unit.indices, stacked: unit.stacked, span: spans[p], width: partWidth, columns, rows: need, visible: 0 };
    });
    const serviceHeight = rows ? level.head + rows * level.rowHeight + (rows - 1) * level.gap + level.pad : 0;
    let height = serviceHeight;
    parts.forEach((part, i) => {
      if (!part.stacked) return;
      const maxColumns = Math.max(1, Math.floor((part.width - 6) / (level.minWidth + 10))); let best: StackPlan | undefined;
      for (let columns = 1; columns <= maxColumns; columns++) { const value = stackHeight(level, units[i], part.width, columns); if (!value) continue; if (serviceHeight && value.height <= serviceHeight) { best = value; break; } if (!best || value.height < best.height) best = value; }
      if (best) { height = Math.max(height, best.height); part.stackColumns = best.columns; }
    });
    return { level, parts, rows: Math.max(1, rows), height, spans: [...spans] };
  };
  const band = (level: DensityLevel, units: Unit[], refine = false): LayoutBand | undefined => {
    const minimum = minSpan(level); if (units.length * minimum > 24) return undefined;
    const weights = units.map(weightOf), total = weights.reduce((a, b) => a + b, 0);
    const raw = weights.map(weight => Math.max(minimum, 24 * weight / total)), spans = raw.map(Math.floor);
    let remaining = 24 - spans.reduce((a, b) => a + b, 0), cursor = 0;
    const order = raw.map((value, i) => ({ fraction: value - Math.floor(value), i })).sort((a, b) => b.fraction - a.fraction);
    while (remaining > 0) { spans[order[cursor++ % order.length].i]++; remaining--; }
    while (remaining < 0) { let largest = -1; spans.forEach((value, i) => { if (value > minimum && (largest < 0 || value > spans[largest])) largest = i; }); if (largest < 0) return undefined; spans[largest]--; remaining++; }
    let result = evaluateBand(level, units, spans);
    if (refine) {
      for (let iteration = 0; iteration < 40; iteration++) {
        let improved = false;
        for (let a = 0; a < spans.length && !improved; a++) for (let b = 0; b < spans.length && !improved; b++) {
          if (a === b || result.spans[a] - 1 < minimum) continue;
          const candidate = [...result.spans]; candidate[a]--; candidate[b]++;
          const next = evaluateBand(level, units, candidate); if (next.height < result.height - .5) { result = next; improved = true; }
        }
        if (!improved) break;
      }
    }
    return result;
  };
  const totalHeight = (bands: LayoutBand[]) => bands.reduce((sum, value) => sum + value.height, 0) + (bands.length - 1) * 10;
  const candidates = (level: DensityLevel, units: Unit[]): LayoutBand[][] => {
    const memo = new Map<string, LayoutBand | undefined>();
    const at = (i: number, j: number) => { const key = `${i}:${j}`; if (!memo.has(key)) memo.set(key, band(level, units.slice(i, j), true)); return memo.get(key); };
    const result: LayoutBand[][] = [], count = units.length;
    if (count <= 12) {
      for (let mask = 0; mask < 2 ** (count - 1); mask++) {
        const bands: LayoutBand[] = []; let start = 0, valid = true;
        for (let j = 1; j <= count && valid; j++) if (j === count || mask >> (j - 1) & 1) { const entry = at(start, j); if (!entry) valid = false; else bands.push(entry); start = j; }
        if (valid && bands.length <= 6) result.push(bands);
      }
    } else {
      const perRow = Math.max(1, Math.floor(24 / minSpan(level)));
      for (let rows = Math.ceil(count / perRow); rows <= Math.min(count, 6); rows++) {
        const costs: number[][] = [[0]], previous: number[][] = [[]], average = count / rows;
        for (let r = 1; r <= rows; r++) { costs[r] = []; previous[r] = []; for (let j = 1; j <= count; j++) { costs[r][j] = Infinity; for (let i = r - 1; i < j; i++) { const value = at(i, j); if (!value || !Number.isFinite(costs[r - 1]?.[i])) continue; const cost = costs[r - 1][i] + value.height + (j - i - average) ** 2 * .5; if (cost < costs[r][j]) { costs[r][j] = cost; previous[r][j] = i; } } } }
        if (!Number.isFinite(costs[rows]?.[count])) continue;
        const bands: LayoutBand[] = []; let end = count;
        for (let r = rows; r > 0; r--) { const start = previous[r][end]; bands.unshift(at(start, end)!); end = start; } result.push(bands);
      }
    }
    return result;
  };
  const score = (bands: LayoutBand[]) => {
    const height = totalHeight(bands); if (height > availableHeight) return Infinity;
    let waste = 0, area = 0;
    bands.forEach(entry => { area += entry.height * width; entry.parts.forEach(part => {
      if (part.stacked) { const value = stackHeight(entry.level, { indices: part.indices, stacked: true }, part.width, part.stackColumns ?? 1); waste += Math.max(0, entry.height - (value?.height ?? entry.height)) * part.width; }
      else { const count = categories[part.indices[0]].count, pitch = entry.level.rowHeight + entry.level.gap, natural = entry.level.head + entry.rows * pitch - entry.level.gap + entry.level.pad; waste += Math.max(0, entry.rows * part.columns - count) * part.width / part.columns * pitch + Math.max(0, entry.height - natural) * part.width; }
    }); });
    return waste / Math.max(1, area) + .45 * (availableHeight / Math.max(1, height) - 1) + .02 * bands.length;
  };
  const unitSets = (level: DensityLevel) => {
    const sets = level.key === 'L1' ? [makeUnits(false)] : [makeUnits(true), makeUnits(true, 5), makeUnits(false)];
    const seen = new Set<string>(); return sets.filter(units => { const key = units.map(unit => `${unit.stacked ? 's' : ''}${unit.indices.join('.')}`).join('|'); if (seen.has(key)) return false; seen.add(key); return true; });
  };
  const cap = (bands: LayoutBand[]): { bands: LayoutBand[]; shown: number } => {
    const state = bands.map(entry => {
      const stack = Math.max(0, ...entry.parts.filter(part => part.stacked).map(part => stackHeight(entry.level, { indices: part.indices, stacked: true }, part.width, part.stackColumns ?? 1)?.height ?? 0));
      return { entry, stack, rows: Math.min(entry.rows, 2) };
    });
    const heightOf = (value: typeof state[number]) => Math.max(value.entry.level.head + value.rows * value.entry.level.rowHeight + (value.rows - 1) * value.entry.level.gap + value.entry.level.pad, value.stack);
    const utility = (shown: number, count: number) => count ** .3 * shown ** .7;
    const shownBy = (value: typeof state[number], rows: number) => value.entry.parts.reduce((sum, part) => part.stacked ? sum + part.indices.reduce((n, i) => n + utility(categories[i].count, categories[i].count), 0) : sum + utility(categories[part.indices[0]].count <= part.columns * rows ? categories[part.indices[0]].count : Math.max(0, (rows - 1) * part.columns), categories[part.indices[0]].count), 0);
    let height = state.reduce((sum, value) => sum + heightOf(value), 0) + (state.length - 1) * 10;
    for (let guard = 0; guard < 400; guard++) {
      let best: { value: typeof state[number]; gain: number; height: number } | undefined;
      state.forEach(value => { if (value.rows >= value.entry.rows) return; const before = heightOf(value); value.rows++; const delta = heightOf(value) - before, gain = shownBy(value, value.rows) - shownBy(value, value.rows - 1); value.rows--; if (height + delta > availableHeight || gain <= 0 && delta > 0) return; const ratio = delta <= 0 ? 1e9 + gain : gain / delta; if (!best || ratio > best.gain) best = { value, gain: ratio, height: delta }; });
      if (!best) break; best.value.rows++; height += best.height;
    }
    return { bands: state.map(value => ({ ...value.entry, rows: value.rows, height: heightOf(value), parts: value.entry.parts.map(part => ({ ...part })) })), shown: state.reduce((sum, value) => sum + shownBy(value, value.rows), 0) };
  };
  let selected: LayoutBand[] | undefined, lastCandidates: LayoutBand[][] = [];
  const order: MonitorLevel[] = density === 'auto' ? ['L1', 'L2', 'L3'] : [density];
  for (const key of order) {
    const level = MONITOR_LEVELS[key], choices = unitSets(level).flatMap(units => candidates(level, units));
    if (!choices.length) continue; lastCandidates = choices;
    let bestScore = Infinity; choices.forEach(choice => { const value = score(choice); if (value < bestScore) { bestScore = value; selected = choice; } });
    if (selected) break;
  }
  let overflow = false;
  if (selected && density === 'auto') {
    let richBands: LayoutBand[] = selected;
    let bestScore = score(richBands), improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < richBands.length; i++) {
        const richer = RICHER[richBands[i].level.key]; if (!richer) continue;
        const replacement = band(MONITOR_LEVELS[richer], richBands[i].parts.map(part => ({ indices: part.indices, stacked: part.stacked })), true); if (!replacement) continue;
        const trial: LayoutBand[] = [...richBands]; trial[i] = replacement; const value = score(trial);
        if (value < bestScore - .005) { richBands = trial; bestScore = value; improved = true; break; }
      }
    }
    selected = richBands;
  }
  if (!selected) {
    overflow = true; let best: { score: number; bands: LayoutBand[] } | undefined;
    lastCandidates.forEach(choice => { const limited = cap(choice); if (totalHeight(limited.bands) > availableHeight + 1) return; const value = limited.shown * 100 - choice.length; if (!best || value > best.score) best = { score: value, bands: limited.bands }; });
    if (!best) lastCandidates.forEach(choice => { const limited = cap(choice), value = -totalHeight(limited.bands); if (!best || value > best.score) best = { score: value, bands: limited.bands }; });
    selected = best?.bands;
  }
  if (!selected) selected = categories.map((category, i) => ({ level: MONITOR_LEVELS.L3, height: 48 + category.count * 24, rows: category.count, spans: [24], parts: [{ indices: [i], stacked: false, span: 24, width, columns: 1, rows: category.count, visible: category.count }] }));
  selected.forEach(entry => entry.parts.forEach(part => { if (!part.stacked) { const count = categories[part.indices[0]].count; part.rows = entry.rows; part.visible = count <= part.columns * entry.rows ? count : Math.max(0, (entry.rows - 1) * part.columns); } }));
  const height = totalHeight(selected);
  return { ...base, bands: selected, fits: height <= availableHeight + 1, height, overflow };
}

export function categoryMonitorLayout(count: number, width: number, height: number): { level: MonitorLevel; columns: number; rowHeight: number; gap: number } {
  const options = [{ level: 'L1' as const, minWidth: 236, rowHeight: 110, gap: 8 }, { level: 'L2' as const, minWidth: 206, rowHeight: 48, gap: 4 }, { level: 'L3' as const, minWidth: 220, rowHeight: 26, gap: 3 }];
  for (const option of options) { const columns = Math.max(1, Math.floor((width - 32) / (option.minWidth + 8))), rows = Math.ceil(count / columns); if (rows * option.rowHeight + (rows - 1) * option.gap <= height - 90 || option.level === 'L3') return { ...option, columns }; }
  return { level: 'L3', columns: 1, rowHeight: 26, gap: 3 };
}
