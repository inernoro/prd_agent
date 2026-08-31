import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * `components/ui/button.tsx` 用 `[&_svg]:size-*` 强制按钮内图标的占比（cds/CLAUDE.md §1
 * 的「Icon-to-button ratio ≥ 55%」）。这条覆盖的特异度是 (0,1,1)，压得过子元素自己写的
 * `h-4`(0,1,0)，tailwind-merge 又只在同一元素上合并 —— 所以调用点写的尺寸**不生效**。
 *
 * 后果不是「样式不对」，而是「读到的不是渲染的」：有人写 14px、看到 20px，以为哪里算错了，
 * 于是跑去别处再硬编码一个尺寸，档位就这么一层层长出来。2026-08-31 一次清掉 113 处。
 *
 * 这条守卫钉死零残留。要改按钮内图标的大小，改 button.tsx 的档位，不要在调用点写死。
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** 只认这个文件自己 import 进来的 lucide 图标名——别的大写组件（含嵌套 Button）尺寸是有效的。 */
function lucideNames(source: string): Set<string> {
  const m = /import\s*\{([^}]*)\}\s*from\s*'lucide-react'/s.exec(source);
  if (!m) return new Set();
  return new Set(
    m[1].split(',')
      .map((piece) => piece.trim().split(/\s+as\s+/).pop()!.trim())
      .filter((name) => name && /^[A-Z]/.test(name)),
  );
}

function findDeadSizes(source: string): string[] {
  const icons = lucideNames(source);
  if (icons.size === 0) return [];
  const hits: string[] = [];
  for (const block of source.match(/<Button\b[\s\S]*?<\/Button>/g) || []) {
    const tagRe = /<([A-Z][A-Za-z0-9]*)\b[^>]*className="([^"]*)"/g;
    let tag: RegExpExecArray | null;
    while ((tag = tagRe.exec(block)) !== null) {
      if (!icons.has(tag[1])) continue;
      if (/\b(?:h-[\d.]+ w-[\d.]+|w-[\d.]+ h-[\d.]+)\b/.test(tag[2])) {
        hits.push(`<${tag[1]} className="${tag[2]}">`);
      }
    }
  }
  return hits;
}

describe('按钮内的 lucide 图标不许自带尺寸', () => {
  it('调用点写的尺寸会被 button.tsx 的 [&_svg]:size-* 吃掉，因此一处都不许留', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const source = fs.readFileSync(file, 'utf-8');
      if (!source.includes('<Button')) continue;
      for (const hit of findDeadSizes(source)) {
        offenders.push(`${path.relative(SRC, file)} → ${hit}`);
      }
    }
    expect(offenders, `这些尺寸不会生效（按钮档位说了算）。删掉它们，或改 button.tsx 的档位：\n${offenders.join('\n')}`)
      .toEqual([]);
  });

  it('守卫本身能认出违例 —— 不是永远返回空数组的空转判据', () => {
    const sample = [
      "import { Save, Trash2 } from 'lucide-react';",
      '<Button size="sm"><Save className="h-3.5 w-3.5" />保存</Button>',
      // 非 lucide 组件（含嵌套 Button）的尺寸是有效的，不该被报出来
      '<Button><Button className="h-8 w-8" />嵌套</Button>',
      // 只有 animate-spin、没有尺寸的写法是正确写法
      '<Button><Trash2 className="animate-spin" />删除</Button>',
    ].join('\n');
    const hits = findDeadSizes(sample);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('Save');
  });
});
