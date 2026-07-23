export interface AgentTerritoryProjectSize {
  id: string;
  branchCount?: number;
  runningBranchCount?: number;
  runningServiceCount?: number;
}

interface TerritorySeed {
  key: string;
  weight: number;
}

interface WeightedArea {
  key: string;
  area: number;
}

interface LayoutBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AgentTerritoryRect {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  areaPercent: number;
}

const MIN_AREA_FACTOR = 0.72;
const MAX_AREA_FACTOR = 1.65;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function projectActivity(project: AgentTerritoryProjectSize): number {
  return Math.max(0, project.branchCount || 0)
    + Math.max(0, project.runningBranchCount || 0) * 1.5
    + Math.max(0, project.runningServiceCount || 0) * 0.5;
}

/**
 * 以项目真实规模预测地块面积，同时限制极端比例。
 *
 * 分支数是主权重，运行分支和服务只做轻量修正；开平方抑制大项目的面积膨胀，
 * 最后将每个项目限制在典型地块的 0.72 到 1.65 倍，保证名称可读且地块可点击。
 */
export function createAgentTerritoryWeights(projects: AgentTerritoryProjectSize[]): TerritorySeed[] {
  const rawProjectWeights = projects.map((project) => ({
    key: `project:${project.id}`,
    weight: Math.sqrt(1 + projectActivity(project)),
  }));
  const sortedWeights = rawProjectWeights.map((item) => item.weight).sort((left, right) => left - right);
  const middleIndex = Math.floor(sortedWeights.length / 2);
  const typicalWeight = sortedWeights.length === 0
    ? 1
    : sortedWeights.length % 2 === 0
      ? (sortedWeights[middleIndex - 1] + sortedWeights[middleIndex]) / 2
      : sortedWeights[middleIndex];
  const minWeight = typicalWeight * MIN_AREA_FACTOR;
  const maxWeight = typicalWeight * MAX_AREA_FACTOR;
  const projectWeights = rawProjectWeights.map((item) => ({
    ...item,
    weight: clamp(item.weight, minWeight, maxWeight),
  }));

  return [
    { key: 'system', weight: typicalWeight * 0.92 },
    ...projectWeights,
    { key: 'new', weight: typicalWeight * MIN_AREA_FACTOR },
  ];
}

function rowWorstRatio(row: WeightedArea[], side: number): number {
  if (row.length === 0 || side <= 0) return Number.POSITIVE_INFINITY;
  const sum = row.reduce((total, item) => total + item.area, 0);
  const largest = Math.max(...row.map((item) => item.area));
  const smallest = Math.min(...row.map((item) => item.area));
  const sideSquared = side * side;
  const sumSquared = sum * sum;
  return Math.max(
    (sideSquared * largest) / sumSquared,
    sumSquared / (sideSquared * smallest),
  );
}

function layoutRow(
  row: WeightedArea[],
  bounds: LayoutBounds,
): { territories: AgentTerritoryRect[]; remaining: LayoutBounds } {
  const rowArea = row.reduce((sum, item) => sum + item.area, 0);
  const territories: AgentTerritoryRect[] = [];

  if (bounds.width >= bounds.height) {
    const rowWidth = rowArea / bounds.height;
    let nextY = bounds.y;
    for (const item of row) {
      const itemHeight = item.area / rowWidth;
      territories.push({
        key: item.key,
        x: bounds.x,
        y: nextY,
        width: rowWidth,
        height: itemHeight,
        areaPercent: 0,
      });
      nextY += itemHeight;
    }
    return {
      territories,
      remaining: {
        x: bounds.x + rowWidth,
        y: bounds.y,
        width: Math.max(0, bounds.width - rowWidth),
        height: bounds.height,
      },
    };
  }

  const rowHeight = rowArea / bounds.width;
  let nextX = bounds.x;
  for (const item of row) {
    const itemWidth = item.area / rowHeight;
    territories.push({
      key: item.key,
      x: nextX,
      y: bounds.y,
      width: itemWidth,
      height: rowHeight,
      areaPercent: 0,
    });
    nextX += itemWidth;
  }
  return {
    territories,
    remaining: {
      x: bounds.x,
      y: bounds.y + rowHeight,
      width: bounds.width,
      height: Math.max(0, bounds.height - rowHeight),
    },
  };
}

export function createAgentTerritoryLayout(
  projects: AgentTerritoryProjectSize[],
  aspectRatio = 2.4,
): AgentTerritoryRect[] {
  const seeds = createAgentTerritoryWeights(projects)
    .sort((left, right) => right.weight - left.weight || left.key.localeCompare(right.key));
  if (seeds.length === 0) return [];

  const canvasWidth = Math.max(0.5, aspectRatio) * 100;
  const canvasHeight = 100;
  const canvasArea = canvasWidth * canvasHeight;
  const totalWeight = seeds.reduce((sum, item) => sum + item.weight, 0);
  const weightedAreas = seeds.map((item) => ({
    key: item.key,
    area: (item.weight / totalWeight) * canvasArea,
  }));
  let bounds: LayoutBounds = { x: 0, y: 0, width: canvasWidth, height: canvasHeight };
  let row: WeightedArea[] = [];
  const output: AgentTerritoryRect[] = [];

  for (const item of weightedAreas) {
    const side = Math.min(bounds.width, bounds.height);
    const nextRow = [...row, item];
    if (row.length === 0 || rowWorstRatio(nextRow, side) <= rowWorstRatio(row, side)) {
      row = nextRow;
      continue;
    }
    const laidOut = layoutRow(row, bounds);
    output.push(...laidOut.territories);
    bounds = laidOut.remaining;
    row = [item];
  }
  if (row.length > 0) {
    output.push(...layoutRow(row, bounds).territories);
  }

  return output.map((territory) => ({
    ...territory,
    x: (territory.x / canvasWidth) * 100,
    y: (territory.y / canvasHeight) * 100,
    width: (territory.width / canvasWidth) * 100,
    height: (territory.height / canvasHeight) * 100,
    areaPercent: ((territory.width * territory.height) / canvasArea) * 100,
  }));
}
