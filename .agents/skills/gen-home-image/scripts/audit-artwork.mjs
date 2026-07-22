#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function roots() {
  const cwd = process.cwd();
  if (existsSync(path.join(cwd, 'prd-admin', 'src'))) return { admin: path.join(cwd, 'prd-admin') };
  if (existsSync(path.join(cwd, 'src', 'stores', 'toolboxStore.ts'))) return { admin: cwd };
  throw new Error('无法从当前目录定位 prd-admin。');
}

function uniqueMatches(source, regex) {
  return [...new Set(Array.from(source.matchAll(regex), (match) => match[1] ?? match[2]))].sort();
}

function webpDimensions(filePath) {
  const buffer = readFileSync(filePath);
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    throw new Error('不是 WebP 文件');
  }
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const type = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const data = offset + 8;
    if (type === 'VP8X') {
      return { width: 1 + buffer.readUIntLE(data + 4, 3), height: 1 + buffer.readUIntLE(data + 7, 3) };
    }
    if (type === 'VP8 ') {
      return { width: buffer.readUInt16LE(data + 6) & 0x3fff, height: buffer.readUInt16LE(data + 8) & 0x3fff };
    }
    if (type === 'VP8L') {
      const bits = buffer.readUInt32LE(data + 1);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
    offset = data + size + (size % 2);
  }
  throw new Error('无法读取 WebP 尺寸');
}

const { admin } = roots();
const storeSource = readFileSync(path.join(admin, 'src/stores/toolboxStore.ts'), 'utf8');
const builtinSource = storeSource.slice(
  storeSource.indexOf('export const BUILTIN_TOOLS'),
  storeSource.indexOf('export const useToolboxStore'),
);
const homeLauncherSource = readFileSync(path.join(admin, 'src/lib/homeLauncherItems.ts'), 'utf8');
const keys = [...new Set([
  ...uniqueMatches(builtinSource, /agentKey:\s*'([^']+)'/g),
  ...uniqueMatches(homeLauncherSource, /agentKey:\s*'([^']+)'/g),
])].sort();

const presentationSource = readFileSync(path.join(admin, 'src/components/agent-shell/AgentCardArtwork.tsx'), 'utf8');
const presentationBlock = presentationSource.slice(
  presentationSource.indexOf('const AGENT_CARD_PRESENTATION'),
  presentationSource.indexOf('export function hasAgentCardArtwork'),
);
const presentationKeys = new Set(uniqueMatches(
  presentationBlock,
  /^\s*(?:'([^']+)'|([a-z][a-z0-9-]*)):\s*\{\s*task:/gm,
));
const tokens = readFileSync(path.join(admin, 'src/styles/tokens.css'), 'utf8');
const artDir = path.join(admin, 'src/assets/agent-card-art');

const failures = [];
for (const key of keys) {
  if (!presentationKeys.has(key)) failures.push(`${key}: 缺少展示职责`);
  const darkToken = `--agent-card-artwork-${key}: url('../assets/agent-card-art/${key}.webp');`;
  const lightToken = `--agent-card-artwork-${key}: url('../assets/agent-card-art/${key}-light.webp');`;
  if (!tokens.includes(darkToken)) failures.push(`${key}: 缺少深色 token`);
  if (!tokens.includes(lightToken)) failures.push(`${key}: 缺少浅色 token`);
  for (const suffix of ['', '-light']) {
    const asset = path.join(artDir, `${key}${suffix}.webp`);
    if (!existsSync(asset)) {
      failures.push(`${key}: 缺少${suffix ? '浅色' : '深色'}图片`);
      continue;
    }
    try {
      const { width, height } = webpDimensions(asset);
      if (width !== 960 || height !== 600) failures.push(`${key}${suffix}: 尺寸为 ${width}x${height}，应为 960x600`);
    } catch (error) {
      failures.push(`${key}${suffix}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

const report = { builtinItems: keys.length, passed: failures.length === 0, failures };
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`首页与百宝箱主题图片审计：${keys.length} 个内置入口`);
  if (failures.length === 0) console.log('通过：展示职责、明暗 token、成对图片与 960x600 尺寸全部完整。');
  else failures.forEach((failure) => console.error(`- ${failure}`));
}
if (failures.length > 0) process.exitCode = 1;
