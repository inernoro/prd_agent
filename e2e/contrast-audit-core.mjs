/**
 * 对比度审计的共享判据（远端版与本地 dist 版共用，避免两份拷贝漂移）。
 *  - 文本 4.5:1；≥18.66px 或 ≥14px+bold 按 WCAG 大字号放宽到 3:1
 *  - 图标（svg）3:1
 *  - 背景沿祖先链合成；碰到渐变/背景图标 needsEye，不武断判失败
 */
export const AUDIT_FN = () => {
  const chan = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = ([r, g, b]) => 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  // 颜色一律交给浏览器自己的色彩引擎解析 + 合成。
  // 手写正则解析过一版，Chromium 对 Tailwind 透明度色返回 oklab(L a b / alpha)，
  // 正则把 oklab 分量当成 RGB，整批算成近黑、对比度全是 1.0x —— 全是假阳性。
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  /** 把任意合法颜色字符串合成到已知 sRGB 底色上，返回合成后的 sRGB。 */
  const compose = (color, bg) => {
    cx.clearRect(0, 0, 1, 1);
    cx.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
    cx.fillRect(0, 0, 1, 1);
    cx.fillStyle = '#000';
    try { cx.fillStyle = color; } catch { return null; }
    cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  /** 该颜色是否完全透明（合成到黑与白结果都等于底色）。 */
  const isTransparent = (color) => {
    const onBlack = compose(color, [0, 0, 0]);
    const onWhite = compose(color, [255, 255, 255]);
    if (!onBlack || !onWhite) return true;
    return onBlack.join() === '0,0,0' && onWhite.join() === '255,255,255';
  };

  /** 自底向上收集背景层，再由下往上依次合成 —— 半透明叠半透明也算得准。 */
  const effectiveBg = (el) => {
    const layers = [];
    let node = el, needsEye = false;
    while (node && node.nodeType === 1) {
      const cs = getComputedStyle(node);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') needsEye = true;
      if (!isTransparent(cs.backgroundColor)) layers.push(cs.backgroundColor);
      node = node.parentElement;
    }
    let bg = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i -= 1) bg = compose(layers[i], bg) || bg;
    return { bg, needsEye };
  };

  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };

  const label = (el) => {
    const parts = [];
    let n = el, guard = 0;
    while (n && n.tagName !== 'BODY' && guard++ < 4) {
      if (n.id) { parts.unshift(`#${n.id}`); break; }
      const cls = (n.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      parts.unshift(n.tagName.toLowerCase() + (cls ? `.${cls}` : ''));
      n = n.parentElement;
    }
    return parts.join('>');
  };

  const out = [], seen = new Set();

  for (const el of document.querySelectorAll('body *')) {
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasText || !visible(el)) continue;
    const cs = getComputedStyle(el);
    if (isTransparent(cs.color)) continue;
    const { bg, needsEye } = effectiveBg(el);
    const composed = compose(cs.color, bg);
    if (!composed) continue;
    const c = contrast(composed, bg);
    const size = parseFloat(cs.fontSize);
    const need = (size >= 18.66 || (size >= 14 && +cs.fontWeight >= 700)) ? 3 : 4.5;
    if (c >= need) continue;
    const key = `${cs.color}|${bg}|${label(el)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = el.getBoundingClientRect();
    out.push({ kind: 'text', text: el.textContent.trim().slice(0, 24), sel: label(el),
      fg: cs.color, bg: `rgb(${bg})`, ratio: +c.toFixed(2), need, needsEye,
      box: { x: Math.round(r.x), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
      vbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } });
  }

  for (const el of document.querySelectorAll('svg')) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    const strokeOn = cs.stroke && cs.stroke !== 'none';
    const raw = strokeOn ? cs.stroke : (cs.fill && cs.fill !== 'none') ? cs.fill : cs.color;
    // 多色装饰 svg：自己没描边、fill 是 UA 默认黑、但子元素各自带 fill/stroke。
    // 这种取根节点的黑是假的（第一版因此误报 44 条路由）。
    if (!strokeOn && cs.fill === 'rgb(0, 0, 0)'
        && el.querySelector('[fill],[stroke],stop')) continue;
    if (isTransparent(raw)) continue;
    const { bg, needsEye } = effectiveBg(el.parentElement || el);
    const composed = compose(raw, bg);
    if (!composed) continue;
    const c = contrast(composed, bg);
    if (c >= 3) continue;
    const key = `svg|${raw}|${bg}|${label(el)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = el.getBoundingClientRect();
    out.push({ kind: 'icon', text: '', sel: label(el), fg: raw, bg: `rgb(${bg})`,
      ratio: +c.toFixed(2), need: 3, needsEye,
      box: { x: Math.round(r.x), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
      vbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } });
  }

  return out.sort((a, b) => a.ratio - b.ratio).slice(0, 60);
};

/** 按「同一组前景/背景配色」聚合：公共组件坏掉会在几十条路由上重复命中，聚合后排最前的就是病根。 */
export function aggregate(report) {
  const byColor = new Map();
  for (const r of report) {
    for (const f of r.findings) {
      const k = `${f.kind}|${f.fg}|${f.bg}`;
      if (!byColor.has(k)) byColor.set(k, { ...f, routes: new Set(), samples: [] });
      const g = byColor.get(k);
      g.routes.add(`${r.theme}:${r.route}`);
      if (g.samples.length < 3 && !g.samples.includes(f.sel)) g.samples.push(f.sel);
    }
  }
  return [...byColor.values()]
    .map((g) => ({ ...g, routeCount: g.routes.size, routes: [...g.routes].slice(0, 6) }))
    .sort((a, b) => b.routeCount - a.routeCount || a.ratio - b.ratio);
}

export function renderMarkdown({ title, base, routeCount, report, groups, note }) {
  const total = report.reduce((s, r) => s + r.findings.length, 0);
  return [
    `# ${title}`, '',
    `站点 ${base}｜路由 ${routeCount} 条｜命中 ${total} 处｜配色组 ${groups.length}`,
    ...(note ? ['', `> ${note}`] : []), '',
    '## 按配色聚合（影响路由数从多到少）', '',
    '| 影响路由数 | 类型 | 前景 | 背景 | 实测 | 需要 | 样例元素 |',
    '|---|---|---|---|---|---|---|',
    ...groups.slice(0, 40).map((g) =>
      `| ${g.routeCount} | ${g.kind} | \`${g.fg}\` | \`${g.bg}\` | ${g.ratio}:1 | ${g.need}:1 | \`${g.samples[0]}\` |`),
  ].join('\n');
}


/**
 * 祖先链上有渐变/背景图时，算出来的底色是假的（会一路穿到页面底色）。
 * 这里改为从本屏截图里**真实采样**该元素边缘的像素当底色重算 —— 采样点取元素框内
 * 左上 2px 处，绕开字形。采样不到就保留 needsEye 标记交人工，不硬判失败。
 */
export async function resampleGradientFindings(page, shotBuffer, findings) {
  const targets = findings.filter((f) => f.needsEye && f.vbox && f.vbox.w > 4 && f.vbox.h > 4);
  if (!targets.length) return findings;
  const results = await page.evaluate(async ({ b64, items }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const scale = img.width / window.innerWidth;
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0);

    const one = document.createElement('canvas');
    one.width = one.height = 1;
    const oc = one.getContext('2d', { willReadFrequently: true });
    const compose = (color, bg) => {
      oc.clearRect(0, 0, 1, 1);
      oc.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
      oc.fillRect(0, 0, 1, 1);
      try { oc.fillStyle = color; } catch { return null; }
      oc.fillRect(0, 0, 1, 1);
      const d = oc.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    const chan = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const lum = ([r, g, b]) => 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
    const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

    return items.map(({ vbox, fg }) => {
      const px = Math.round((vbox.x + 2) * scale);
      const py = Math.round((vbox.y + 2) * scale);
      if (px < 0 || py < 0 || px >= img.width || py >= img.height) return null;
      const d = cx.getImageData(px, py, 1, 1).data;
      const bg = [d[0], d[1], d[2]];
      const composed = compose(fg, bg);
      if (!composed) return null;
      return { bg, ratio: +contrast(composed, bg).toFixed(2) };
    });
  }, { b64: shotBuffer.toString('base64'), items: targets.map((f) => ({ vbox: f.vbox, fg: f.fg })) });

  targets.forEach((f, i) => {
    const r = results[i];
    if (!r) return;
    f.bg = `rgb(${r.bg})`;
    f.ratio = r.ratio;
    f.sampled = true;          // 底色来自截图真实像素，不是祖先链推断
  });
  return findings;
}
