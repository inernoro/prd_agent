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

  /*
   * 平台注入的浮层不属于被审对象：CDS 会往每个预览页塞一个分支徽章
   * （#bt-branch-badge），它不在仓库源码里、这个 PR 也改不了它。
   * 不排除的话每条路由都会稳定多报一处，真实回归反而被淹没。
   * 排除范围写死成具体 id，不做宽泛通配 —— 免得顺手把应用自己的东西也滤掉。
   */
  const PLATFORM_OVERLAY = '#bt-branch-badge';
  const isPlatformOverlay = (el) => !!el.closest(PLATFORM_OVERLAY);

  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };

  /**
   * 元素自身与祖先链累计的 opacity。
   * getComputedStyle(el).color 是**未经 opacity 衰减**的原色，直接拿去算对比度
   * 会把 opacity-50 的文字当成全强度前景 —— 实际渲染只有一半浓度，
   * 真实对比度低于 4.5:1 的也会被判达标（仓库里 DataTransferPage 就有 opacity-50 的计数标签）。
   */
  const cumulativeOpacity = (el) => {
    let o = 1, node = el;
    while (node && node !== document.documentElement) {
      const v = parseFloat(getComputedStyle(node).opacity);
      if (!Number.isNaN(v)) o *= v;
      node = node.parentElement;
    }
    return o;
  };

  /** 把前景色按累计 opacity 衰减后再合成到底色上，得到浏览器**实际画出来**的那个颜色。 */
  const composeFg = (color, bg, el) => {
    const o = cumulativeOpacity(el);
    if (o >= 0.999) return compose(color, bg);
    const solid = compose(color, bg);
    if (!solid) return null;
    // 整个元素带 opacity 时，等价于把「已合成的前景」再按 o 混回底色
    return [0, 1, 2].map((i) => Math.round(solid[i] * o + bg[i] * (1 - o)));
  };

  /*
   * WCAG 1.4.3 的 Incidental 例外：失效（inactive）控件不受对比度约束。
   * 不排除的话，空数据页上一排 disabled:opacity-40 的按钮会被当成缺陷反复报出来
   * （/arena 的「发送」在无阵容时就是这样，压暗 60% 后 1.78:1，但它本来就点不动）。
   * 判据取真实态：原生 disabled 或 aria-disabled，自身或任一祖先命中即跳过。
   */
  const inactive = (el) => {
    let n = el, guard = 0;
    while (n && n !== document.body && guard++ < 12) {
      if (n.disabled === true) return true;
      if (n.getAttribute && n.getAttribute('aria-disabled') === 'true') return true;
      n = n.parentElement;
    }
    return false;
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
  let auditId = 0;
  document.querySelectorAll('[data-audit-id]').forEach((n) => n.removeAttribute('data-audit-id'));

  for (const el of document.querySelectorAll('body *')) {
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasText || !visible(el) || inactive(el) || isPlatformOverlay(el)) continue;
    const cs = getComputedStyle(el);
    if (isTransparent(cs.color)) continue;
    const { bg, needsEye } = effectiveBg(el);
    const composed = composeFg(cs.color, bg, el);
    if (!composed) continue;
    const c = contrast(composed, bg);
    /*
     * WCAG 的「大字」是 18pt / 14pt 粗体，而 getComputedStyle().fontSize 给的是 **CSS 像素**。
     * 1pt = 4/3 px，所以换算过来是 24px / 18.67px 粗体 —— 原来直接拿 18.66 和 14 去比像素，
     * 等于把 18.66~24px 的正文、14~18.67px 的粗体标签统统放宽到 3:1，
     * 落在 3~4.5 之间的真实缺陷就此消失在一份「干净」的报告里（Codex 在 PR #1374 第五轮抓到）。
     */
    const size = parseFloat(cs.fontSize);
    const bold = +cs.fontWeight >= 700;
    const need = (size >= 24 || (size >= 18.67 && bold)) ? 3 : 4.5;
    /*
     * needsEye（底是渐变/背景图）时不许在这里以「近似达标」为由丢弃。
     * 祖先链推断出的底色在渐变上本来就不可信：深字压在真实很暗的渐变上，
     * 而推断一路穿到白色页底，算出来是「深压白、达标」—— 一丢，
     * resampleGradientFindings 就再也没机会拿真实像素纠正它，报告显示 0 而缺陷仍在。
     * 全部留到重采样之后，由调用方按 ratio < need 过滤（两个审计脚本都已这么做）。
     */
    if (c >= need && !needsEye) continue;
    const key = `${cs.color}|${bg}|${label(el)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = el.getBoundingClientRect();
    el.setAttribute('data-audit-id', String(++auditId));
    out.push({ auditId, kind: 'text', text: el.textContent.trim().slice(0, 24), sel: label(el),
      fg: cs.color, bg: `rgb(${bg})`, ratio: +c.toFixed(2), need, needsEye,
      box: { x: Math.round(r.x), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
      vbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } });
  }

  for (const el of document.querySelectorAll('svg')) {
    if (!visible(el) || inactive(el)) continue;
    const cs = getComputedStyle(el);
    const strokeOn = cs.stroke && cs.stroke !== 'none';
    const raw = strokeOn ? cs.stroke : (cs.fill && cs.fill !== 'none') ? cs.fill : cs.color;
    // 多色装饰 svg：自己没描边、fill 是 UA 默认黑、但子元素各自带 fill/stroke。
    // 这种取根节点的黑是假的（第一版因此误报 44 条路由）。
    if (!strokeOn && cs.fill === 'rgb(0, 0, 0)'
        && el.querySelector('[fill],[stroke],stop')) continue;
    if (isTransparent(raw) || isPlatformOverlay(el)) continue;
    const { bg, needsEye } = effectiveBg(el.parentElement || el);
    const composed = composeFg(raw, bg, el);
    if (!composed) continue;
    const c = contrast(composed, bg);
    if (c >= 3 && !needsEye) continue;   // 同文字分支：渐变底上的「达标」是近似值，留给重采样定夺
    const key = `svg|${raw}|${bg}|${label(el)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = el.getBoundingClientRect();
    el.setAttribute('data-audit-id', String(++auditId));
    out.push({ auditId, kind: 'icon', text: '', sel: label(el), fg: raw, bg: `rgb(${bg})`,
      ratio: +c.toFixed(2), need: 3, needsEye,
      box: { x: Math.round(r.x), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
      vbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } });
  }

  /*
   * 全量返回，不在页内截断。
   * 原来这里 slice(0, 60)，截断发生在 resampleGradientFindings **之前** ——
   * 候选超过 60 的页面，尾部真实缺陷被永久丢弃；而前 60 条若被重采样纠正为达标，
   * 报告就会显示「0 处」，实际还有一批从没查过（Codex 在 PR #1374 第三轮抓到）。
   * 展示用的上限放到 renderMarkdown 里，只影响呈现、不影响判定。
   */
  return out.sort((a, b) => a.ratio - b.ratio);
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

/** 报告表格的展示上限。只影响呈现，判定与 report.json 始终是全量。 */
const TABLE_LIMIT = 40;

export function renderMarkdown({ title, base, routeCount, report, groups, note }) {
  const total = report.reduce((s, r) => s + r.findings.length, 0);
  return [
    `# ${title}`, '',
    `站点 ${base}｜路由 ${routeCount} 条｜命中 ${total} 处｜配色组 ${groups.length}`,
    ...(note ? ['', `> ${note}`] : []), '',
    '## 按配色聚合（影响路由数从多到少）', '',
    '| 影响路由数 | 类型 | 前景 | 背景 | 实测 | 需要 | 样例元素 |',
    '|---|---|---|---|---|---|---|',
    ...groups.slice(0, TABLE_LIMIT).map((g) =>
      `| ${g.routeCount} | ${g.kind} | \`${g.fg}\` | \`${g.bg}\` | ${g.ratio}:1 | ${g.need}:1 | \`${g.samples[0]}\` |`),
    // 截断必须说出来：省略了多少条如果不写，读者会把这张表当成全集
    ...(groups.length > TABLE_LIMIT
      ? ['', `> 表内只列前 ${TABLE_LIMIT} 组，另有 ${groups.length - TABLE_LIMIT} 组未列出，完整数据见 report.json。`]
      : []),
  ].join('\n');
}


/**
 * 祖先链上有渐变/背景图时，算出来的底色是假的（会一路穿到页面底色）。
 * 这里改为从本屏截图里**真实采样**该元素边缘的像素当底色重算 —— 采样点取元素框内
 * 左上 2px 处，绕开字形。采样不到就保留 needsEye 标记交人工，不硬判失败。
 */
/**
 * 渐变/背景图上的元素，祖先链推不出真实底色。
 * 做法：把候选元素的前景临时设为透明、重截一屏，再在元素**正中**取色 ——
 * 正中就是文字真正压着的地方，天然绕开圆角、外发光、阴影环。
 *
 * 前两版分别在「左上角内 2px」（落在圆角外，采到页面底）和「四边中点」
 * （落在按钮外发光环上）翻过车，都会把好按钮误判成失败。
 */
export async function resampleGradientFindings(page, _unused, findings) {
  const targets = findings.filter((f) => f.needsEye && f.auditId);
  if (!targets.length) return findings;

  const ids = targets.map((f) => f.auditId);
  // 隐前景
  await page.evaluate((idList) => {
    window.__auditRestore = [];
    for (const id of idList) {
      const el = document.querySelector(`[data-audit-id="${id}"]`);
      if (!el) continue;
      window.__auditRestore.push([el, el.style.color, el.style.fill, el.style.stroke]);
      el.style.setProperty('color', 'transparent', 'important');
      el.style.setProperty('fill', 'transparent', 'important');
      el.style.setProperty('stroke', 'transparent', 'important');
    }
  }, ids);
  /*
   * 必须整页截图。此前用默认的**视口**截图，而候选是按 getBoundingClientRect 收的、
   * 不限于首屏 —— 屏下的渐变底元素坐标一夹紧就无效，重采样返回 null，
   * 于是那条留着不可信的祖先近似值，既可能假失败也可能假通过。
   */
  const clean = await page.screenshot({ fullPage: true });
  // 还原
  await page.evaluate(() => {
    for (const [el, c, f, st] of window.__auditRestore || []) {
      el.style.color = c; el.style.fill = f; el.style.stroke = st;
    }
    delete window.__auditRestore;
  });

  const results = await page.evaluate(async ({ b64, idList }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    // 整页截图 → 用文档宽度定标，坐标也要换成文档坐标（见下方 r.x + scrollX）
    const docW = Math.max(document.documentElement.scrollWidth, window.innerWidth);
    const scale = img.width / docW;
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

    return idList.map(({ id, fg }) => {
      const el = document.querySelector(`[data-audit-id="${id}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      // 文档坐标（配整页截图）；视口坐标只在首屏成立，屏下元素会被夹成空框
      const dx = r.x + window.scrollX;
      const dy = r.y + window.scrollY;
      const x0 = Math.max(0, Math.round(dx * scale));
      const y0 = Math.max(0, Math.round(dy * scale));
      const x1 = Math.min(img.width, Math.round((dx + r.width) * scale));
      const y1 = Math.min(img.height, Math.round((dy + r.height) * scale));
      if (x1 - x0 < 2 || y1 - y0 < 2) return null;
      /*
       * 取元素框内的**众数色**当底色，而不是正中一个点。
       * 单点采样在小控件上会翻车：把前景设成 transparent 这一步偶尔不生效
       * （React 重渲染会抹掉临时 inline style），正中恰好压着字形，采到的
       * 就是文字色本身 —— 报出来是 fg === bg、比值 1.00 的假阳性
       * （/pa-agent 的 A- 按钮就是这样被误报的）。字形只占框内少数像素，
       * 众数天然是底色，所以即使隐前景失败这一层也兜得住。
       */
      const px = cx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      const buckets = new Map();
      for (let i = 0; i < px.length; i += 4) {
        const key = (px[i] >> 3 << 10) | (px[i + 1] >> 3 << 5) | (px[i + 2] >> 3);
        let b = buckets.get(key);
        if (!b) buckets.set(key, (b = [0, 0, 0, 0]));
        b[0] += px[i]; b[1] += px[i + 1]; b[2] += px[i + 2]; b[3] += 1;
      }
      let best = null;
      for (const b of buckets.values()) if (!best || b[3] > best[3]) best = b;
      if (!best) return null;
      const bg = [Math.round(best[0] / best[3]), Math.round(best[1] / best[3]), Math.round(best[2] / best[3])];
      const composed = compose(fg, bg);
      if (!composed) return null;
      return { bg, ratio: +contrast(composed, bg).toFixed(2) };
    });
  }, { b64: clean.toString('base64'), idList: targets.map((f) => ({ id: f.auditId, fg: f.fg })) });

  targets.forEach((f, i) => {
    const r = results[i];
    if (!r) return;
    f.bg = `rgb(${r.bg})`;
    f.ratio = r.ratio;
    f.sampled = true;
  });
  return findings;
}
