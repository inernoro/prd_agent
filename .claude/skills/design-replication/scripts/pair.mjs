#!/usr/bin/env node
/** 把同一状态、主题、视口和像素密度的两份取证拼在同一比例尺下。 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch } from './browser.mjs';

const captureKey = ({ state, theme, width }) => JSON.stringify([state, theme, width]);

function indexCaptures(records, side) {
  if (!records.length) throw new Error(`${side}没有截图记录`);
  const index = new Map();
  for (const capture of records) {
    const { state, theme, width, height, dpr, fullPage, file, valid } = capture;
    if (typeof state !== 'string' || !state || /[/\\]/.test(state)
        || !['dark', 'light'].includes(theme) || !Number.isSafeInteger(width) || width <= 0
        || (height !== undefined && (!Number.isSafeInteger(height) || height <= 0))
        || (dpr !== undefined && (!Number.isFinite(dpr) || dpr <= 0))
        || (fullPage !== undefined && typeof fullPage !== 'boolean')
        || typeof file !== 'string' || !file) {
      throw new Error(`${side}截图记录缺少有效的状态、视口、主题或文件`);
    }
    const key = captureKey(capture);
    if (valid === false) throw new Error(`${side}截图取证失败 ${key}`);
    if (index.has(key)) throw new Error(`${side}重复截图 ${key}`);
    index.set(key, capture);
  }
  return index;
}

export function matchCaptures(designRecords, implRecords) {
  const design = indexCaptures(designRecords, '设计稿');
  const impl = indexCaptures(implRecords, '实现页');
  const pairs = [];
  const problems = [];
  for (const [key, reference] of design) {
    const actual = impl.get(key);
    if (!actual) {
      problems.push(`实现页缺少截图 ${key}`);
      continue;
    }
    const differences = ['height', 'dpr', 'fullPage'].filter((prop) => reference[prop] !== actual[prop]);
    if (differences.length) {
      problems.push(`取证参数不一致 ${key}（${differences.join('、')}）`);
      continue;
    }
    pairs.push({ reference, actual });
  }
  if (problems.length) throw new Error(problems.join('\n'));
  const extra = [...impl.keys()].filter((key) => !design.has(key));
  return { pairs, extra };
}

const load = (dir) => fs.readdirSync(dir)
  .filter((file) => file.endsWith('.manifest.json'))
  .flatMap((file) => {
    const entries = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (!Array.isArray(entries)) throw new Error(`取证清单应为数组 ${file}`);
    return entries;
  });

async function main() {
  const args = process.argv.slice(2);
  const arg = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const designDir = arg('--design');
  const implDir = arg('--impl');
  const outDir = arg('--out');
  if (!designDir || !implDir || !outDir) throw new Error('必填 --design、--impl、--out');
  const { pairs, extra } = matchCaptures(load(designDir), load(implDir));
  if (extra.length) console.warn(`实现页多出的状态 ${extra.join('、')}`);
  if (pairs.some(({ reference }) => reference.dpr === undefined)) {
    console.warn('旧清单未记录视口高度、DPR 和截图方式。以下仅供目视参考，严格对照需重新取证。');
  }
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const { reference, actual } of pairs) {
      const { state, theme, width, dpr } = reference;
      await page.setContent(`<!doctype html><meta charset="utf-8">
        <style>
          body { margin: 0; background: #111; color: #eee; font: 13px/1.4 system-ui; }
          main { display: flex; align-items: flex-start; gap: 8px; width: max-content; }
          figure { margin: 0; }
          figcaption { padding: 6px 8px; background: #1d1d1d; }
          img { display: block; }
        </style>
        <main><figure><figcaption></figcaption><img alt="设计稿"></figure>
        <figure><figcaption></figcaption><img alt="实现页"></figure></main>`);
      const inputs = [reference, actual].map(({ file }, index) => ({
        src: `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`,
        label: `${index === 0 ? '设计稿' : '实现页'} ${state} / ${theme} / ${width}px`,
      }));
      const dimensions = await page.evaluate(async ({ inputs, dpr }) => {
        const figures = [...document.querySelectorAll('figure')];
        await Promise.all(figures.map(async (figure, index) => {
          const img = figure.querySelector('img');
          figure.querySelector('figcaption').textContent = inputs[index].label;
          img.src = inputs[index].src;
          await img.decode();
          img.style.width = `${img.naturalWidth / dpr}px`;
        }));
        const rect = document.querySelector('main').getBoundingClientRect();
        return { width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
      }, { inputs, dpr: dpr ?? 2 });
      await page.setViewportSize(dimensions);
      const out = path.join(outDir, `pair.${state}.${theme}.${width}.png`);
      await page.screenshot({ path: out });
      console.log(out);
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
