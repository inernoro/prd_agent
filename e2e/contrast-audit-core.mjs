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

  /**
   * 自底向上收集背景层，再由下往上依次合成 —— 半透明叠半透明也算得准。
   *
   * **opacity 作用在整组上，不只作用在字上。**
   * 原来的写法把每层背景都当成不透明的照合，只在最后拿累计 opacity 去衰减前景。
   * 但 CSS 的 opacity 是把「这个元素连同它的背景和后代」整组画到一个缓冲区，
   * 再整组按 o 混到它背后的画面上 —— 背景同样会被冲淡。
   * 于是「半透明的深色卡 + 浅色字」会被算高：
   *   白页上 opacity:.5 的黑底白字，真实是 白字 255 压 灰底 127 → 4.0:1，
   *   而旧算法给的是 灰字 127 压 黑底 0 → 5.25:1，一处真缺陷就此判达标
   *   （Codex 在 PR #1374 第三十一轮抓到）。
   *
   * 现在按「组」算：找到最外层那个带 opacity 的祖先，它之外的背景合成为 backdrop
   * （不打折），它之内的背景照常合成为 groupBg，最后整组按 o 混回 backdrop。
   * 前景走同一条链（`paint`），保证字和底用的是同一套口径。
   *
   * 已知边界：多层 opacity 嵌套时取各层乘积，与浏览器「逐层成组再混」在
   * 半透明背景叠半透明组的极端组合下有小数级偏差；本仓库未见两层以上嵌套。
   */
  const effectiveBg = (el) => {
    const chain = [];
    let node = el, needsEye = false;
    while (node && node.nodeType === 1) {
      const cs = getComputedStyle(node);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') needsEye = true;
      const o = parseFloat(cs.opacity);
      chain.push({
        bg: isTransparent(cs.backgroundColor) ? null : cs.backgroundColor,
        o: Number.isNaN(o) ? 1 : o,
      });
      node = node.parentElement;
    }
    const fade = (color, o, backdrop) =>
      [0, 1, 2].map((i) => Math.round(color[i] * o + backdrop[i] * (1 - o)));

    // 最外层那个带 opacity 的祖先：从它开始往里，背景与字属于同一个组，一起被冲淡
    let outermost = -1;
    for (let i = chain.length - 1; i >= 0; i -= 1) if (chain[i].o < 0.999) { outermost = i; break; }

    // 组外的底：只合成该祖先**之外**的背景层，这部分不受组 opacity 影响
    let backdrop = [255, 255, 255];
    for (let i = chain.length - 1; i > outermost; i -= 1) {
      if (chain[i].bg) backdrop = compose(chain[i].bg, backdrop) || backdrop;
    }
    // 组内的底：组内背景层照常合成（组内互相之间不打折）
    let groupBg = backdrop;
    for (let i = outermost; i >= 0; i -= 1) {
      if (chain[i].bg) groupBg = compose(chain[i].bg, groupBg) || groupBg;
    }
    // 组的整体不透明度 = 链上各层 opacity 之积
    let o = 1;
    for (let i = 0; i <= outermost; i += 1) o *= chain[i].o;

    const bg = outermost < 0 ? groupBg : fade(groupBg, o, backdrop);

    /** 把前景色按同一条链画出来，得到浏览器实际画在屏幕上的那个颜色。 */
    const paint = (color) => {
      const c = compose(color, groupBg);
      if (!c) return null;
      return outermost < 0 ? c : fade(c, o, backdrop);
    };
    return { bg, needsEye, paint, node: el };
  };

  /*
   * 平台注入的浮层不属于被审对象：CDS 会往每个预览页塞一个分支徽章
   * （#bt-branch-badge），它不在仓库源码里、这个 PR 也改不了它。
   * 不排除的话每条路由都会稳定多报一处，真实回归反而被淹没。
   * 排除范围写死成具体 id，不做宽泛通配 —— 免得顺手把应用自己的东西也滤掉。
   */
  /*
   * 只排除**外部注入**的浮层，别把自家组件也滤掉。
   *
   * `#bt-branch-badge` 其实是仓库自己的 `components/BranchBadge.tsx`，由 App.tsx 直接挂载，
   * 本 PR 还改过它的配色 —— 我当初当成平台注入物排掉，等于让审计对一个自己刚改过的
   * 组件永久失明（Codex 在 PR #1374 第二十三轮抓到）。
   * 真正外部注入的是 CDS 的 `#cds-widget` / `.cds-badge`：不在仓库源码里、本 PR 改不了，
   * 且它一家在全量扫描里贡献 412 条（占 24%），不排除会把真实缺陷压在排序下面。
   */
  const PLATFORM_OVERLAY = '#cds-widget, .cds-badge';
  const isPlatformOverlay = (el) => !!el.closest(PLATFORM_OVERLAY);

  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
    /*
     * opacity **不继承**：祖先 opacity:0 时，子元素自己报的仍是 1。
     * 只看自己就会把「hover 才出现的控件」当成可见元素测量 —— 而下面的
     * cumulativeOpacity 又会把它的前景按 0 合成到底色上，于是稳定产出一条
     * 「fg === bg、比值 1:1」的假阳性。MarkdownViewer 的复制按钮
     * （外层 opacity-0、内层 svg opacity 1）就是这个形状，它出现在每一个
     * 渲染 markdown 的页面上（Codex 在 PR #1374 第十六轮抓到）。
     * 判可见性必须走整条祖先链。
     */
    if (cumulativeOpacity(el) === 0) return false;
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

  /**
   * 把前景色画成浏览器实际画出来的那个颜色。
   *
   * 主体交给 `info.paint` —— 它与底色 `info.bg` 走的是**同一条** opacity 链，
   * 保证字和底一个口径（见 effectiveBg 的说明）。
   * 只有一种情况要补：SVG 子形状拿父元素的底色算，而子形状自己可能另有 opacity；
   * 这时按「子相对父」多出来的那一截再衰减一次。
   */
  const composeFg = (color, info, el) => {
    const base = info.paint(color);
    if (!base) return null;
    if (!el || el === info.node) return base;
    const extra = cumulativeOpacity(el) / Math.max(cumulativeOpacity(info.node), 1e-6);
    if (extra >= 0.999) return base;
    return [0, 1, 2].map((i) => Math.round(base[i] * extra + info.bg[i] * (1 - extra)));
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

  /*
   * 一个元素可能同时是多个候选：SVG 子形状的 fill 与 stroke 是两个独立通道，
   * 各自成一条 finding。直接 setAttribute 会让后写的把先写的覆盖掉 ——
   * 重采样时先那条 querySelector 找不到，被判 element-gone 计成「没量成」，
   * 于是一个完全达标的图标也能让整轮非零退出（Codex 在 PR #1374 第二十四轮抓到，
   * 是我上一轮加双通道时引入的）。
   * 改成空格分隔累加，查询侧用 ~= （whitespace-separated 属性选择器）。
   */
  const tagAudit = (node, id) => {
    const prev = node.getAttribute('data-audit-id');
    node.setAttribute('data-audit-id', prev ? `${prev} ${id}` : String(id));
  };

  const out = [], seen = new Set();
  let auditId = 0;
  document.querySelectorAll('[data-audit-id]').forEach((n) => n.removeAttribute('data-audit-id'));

  for (const el of document.querySelectorAll('body *')) {
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasText || !visible(el) || inactive(el) || isPlatformOverlay(el)) continue;
    const cs = getComputedStyle(el);
    /*
     * `background-clip: text` 的渐变文字：真正画出来的是被裁切的背景渐变本身，
     * 而 `color` 是 transparent —— 任何按 color 取值的判据都够不着它，于是这类
     * 文字（StatsStrip 的渐变大数就是）从来没进过报告，一屏不可读的标题也能报绿
     * （Codex 在 PR #1374 第二十六轮抓到）。
     *
     * 要真量它得逐字形采像素，属独立工程；现在先**如实计成「没量成」**，
     * 不猜数、也不再当它不存在 —— 这一桶有专门的退出码和复核提示。
     */
    const clipped = (cs.webkitBackgroundClip === 'text' || cs.backgroundClip === 'text')
      && isTransparent(cs.color);
    if (clipped) {
      const ck = `clip|${label(el)}`;
      if (seen.has(ck)) continue;
      seen.add(ck);
      const cr = el.getBoundingClientRect();
      tagAudit(el, ++auditId);
      out.push({ auditId, kind: 'text', text: el.textContent.trim().slice(0, 24), sel: label(el),
        fg: cs.backgroundImage.slice(0, 60), bg: 'rgb(0,0,0)', ratio: 0, need: 4.5, needsEye: false,
        unresolved: true, unresolvedWhy: 'background-clip-text', fgOpacity: cumulativeOpacity(el),
        box: { x: Math.round(cr.x), y: Math.round(cr.y + scrollY), w: Math.round(cr.width), h: Math.round(cr.height) },
        vbox: { x: Math.round(cr.x), y: Math.round(cr.y), w: Math.round(cr.width), h: Math.round(cr.height) } });
      continue;
    }
    if (isTransparent(cs.color)) continue;
    const info = effectiveBg(el);
    const { bg, needsEye } = info;
    const composed = composeFg(cs.color, info, el);
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
    /*
     * 需要像素采样的候选（needsEye）不许在采样前去重。
     * 一列卡片各压在不同渐变/封面图上时，effectiveBg 推不出真底色，返回的
     * fallback bg 与 label 完全相同 —— 于是第一张达标就把后面所有张吞掉，
     * 后面那张真正看不清的永远进不了报告，还能让整轮报绿
     * （Codex 在 PR #1374 第三十轮抓到）。
     * 这类候选把 auditId 掺进键，逐个留到重采样之后由真实像素定夺。
     */
    const key = needsEye
      ? `${cs.color}|${bg}|${label(el)}|#${auditId + 1}`
      : `${cs.color}|${bg}|${label(el)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = el.getBoundingClientRect();
    tagAudit(el, ++auditId);
    out.push({ auditId, kind: 'text', text: el.textContent.trim().slice(0, 24), sel: label(el),
      fg: cs.color, bg: `rgb(${bg})`, ratio: +c.toFixed(2), need, needsEye,
      fgOpacity: cumulativeOpacity(el),
      box: { x: Math.round(r.x), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
      vbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } });
  }

  /*
   * 表单控件要单独测：input / textarea 的**值**与 **placeholder** 都不是 DOM 文本节点，
   * 上面那条 `hasText`（只认 nodeType === 3）对它们永远为 false，于是整类控件从来没被量过。
   * 一个全是输入框的页面因此可以报「干净」，而用户看到的主要文字恰恰就在框里
   * （Codex 在 PR #1374 第十六轮抓到）。
   *
   * placeholder 的颜色取伪元素：getComputedStyle(el, '::placeholder')。
   * 有值时量 cs.color，没值且有 placeholder 时量伪元素色 —— 用户当下看到的是哪个就量哪个。
   */
  for (const el of document.querySelectorAll('input, textarea, select')) {
    if (!visible(el) || inactive(el) || isPlatformOverlay(el)) continue;
    if (el.type === 'hidden' || el.type === 'checkbox' || el.type === 'radio') continue;
    const cs = getComputedStyle(el);
    /*
     * select 的显示值同样量不到：它没有直接文本节点（子节点是 <option>），
     * 而 option 在收起状态下没有布局盒，visible() 判 false。于是「收起的下拉框
     * 显示的那行字」整类从没被量过 —— 本 PR 恰好两次改动原生 select/option 的
     * 主题绘制，改的正是这块（Codex 在 PR #1374 第十八轮抓到）。
     * 取当前选中项的文案 + select 自身的 color 即可；展开后的弹层由 UA 绘制、
     * 不在文档流里，本审计够不着，属已知边界。
     */
    const isSelect = el.tagName === 'SELECT';
    const selText = isSelect ? ((el.selectedOptions && el.selectedOptions[0]?.text) || '').trim() : '';
    const hasValue = isSelect ? !!selText : !!(el.value || '').trim();
    const ph = isSelect ? '' : (el.getAttribute('placeholder') || '').trim();
    if (!hasValue && !ph) continue;
    const isPh = !hasValue;
    const fg = isPh ? getComputedStyle(el, '::placeholder').color : cs.color;
    if (!fg || isTransparent(fg)) continue;
    const info = effectiveBg(el);
    const { bg, needsEye } = info;
    const composed = composeFg(fg, info, el);
    if (!composed) continue;
    const c = contrast(composed, bg);
    const size = parseFloat(cs.fontSize);
    const bold = +cs.fontWeight >= 700;
    const need = (size >= 24 || (size >= 18.67 && bold)) ? 3 : 4.5;
    if (c >= need && !needsEye) continue;
    const key = `${fg}|${bg}|${label(el)}|${isPh ? 'ph' : 'val'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = el.getBoundingClientRect();
    tagAudit(el, ++auditId);
    out.push({ auditId, kind: isPh ? 'placeholder' : (isSelect ? 'select' : 'input'),
      text: (isPh ? ph : (isSelect ? selText : el.value)).slice(0, 24), sel: label(el),
      fg, bg: `rgb(${bg})`, ratio: +c.toFixed(2), need, needsEye,
      fgOpacity: cumulativeOpacity(el),
      box: { x: Math.round(r.x), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
      vbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } });
  }

  for (const el of document.querySelectorAll('svg')) {
    if (!visible(el) || inactive(el)) continue;
    const cs = getComputedStyle(el);
    const strokeOn = cs.stroke && cs.stroke !== 'none';
    const raw = strokeOn ? cs.stroke : (cs.fill && cs.fill !== 'none') ? cs.fill : cs.color;
    /*
     * 多色 svg：根节点自己没描边、fill 是 UA 默认黑（或显式 none），真正的颜色在子形状上。
     * 取根节点那个黑是假的（第一版因此误报 44 条路由），但**直接跳过整个 svg 也是错的** ——
     * 那等于整类多色图标从没被量过。本 PR 刚改的 LevelHat 正是这种：根 fill="none"，
     * 七级帽子的颜色全在各个 path 的 fill/stroke 上（Codex 在 PR #1374 第二十二轮抓到）。
     * 正解：不取根节点的假色，改为遍历**真正上色的子形状**逐个判。
     */
    const rootPaintUseless = !strokeOn
      && (cs.fill === 'rgb(0, 0, 0)' || cs.fill === 'none')
      && el.querySelector('[fill],[stroke],stop');
    if (rootPaintUseless) {
      const sInfo = effectiveBg(el.parentElement || el);
      const { bg: sbg, needsEye: sEye } = sInfo;
      for (const kid of el.querySelectorAll('path,circle,rect,polygon,polyline,ellipse,line')) {
        const ks = getComputedStyle(kid);
        /*
         * fill 与 stroke 是**两个独立通道**，都要各判一次。
         * 原来写成 `stroke ? stroke : fill`，同时有描边和填充时只量描边 ——
         * LevelHat 的帽冠正是 `fill={t.tassel} stroke={t.board}`，流苏色一次都没被量过
         * （Codex 在 PR #1374 第二十三轮抓到，又是我自己刚改的那个组件）。
         */
        const kPaints = [];
        if (ks.stroke && ks.stroke !== 'none') kPaints.push(ks.stroke);
        if (ks.fill && ks.fill !== 'none') kPaints.push(ks.fill);
        for (const kRaw of kPaints) {
        if (!kRaw || isTransparent(kRaw)) continue;
        /*
         * paint server（url(#grad)）取不出颜色，硬算会得到一个假的 1:1。
         * 它的真实颜色只有像素采样知道 —— 标 needsEye 交给重采样，
         * 别在报告里塞一条「比值 1:1」的噪音（那正是我一直在骂的那种数字）。
         */
        const isPaintServer = /^url\(/.test(kRaw);
        if (isPaintServer) {
          const kKeyU = `svgkid|paint-server|${sbg}|${label(el)}`;
          if (seen.has(kKeyU)) continue;
          seen.add(kKeyU);
          const kru = el.getBoundingClientRect();
          tagAudit(kid, ++auditId);
          /*
           * 直接标 unresolved，不走 needsEye —— 重采样同样解析不了 url()，
           * 交给它只会composed 出一个假的 1:1 回来（第一版就是这样，噪音换了个来源）。
           * 「没量成」有专门的桶和退出码，这条属于那一类：真实比值未知，需人工看。
           */
          out.push({ auditId, kind: 'icon', text: '', sel: `${label(el)}>${kid.tagName}`,
            fg: kRaw, bg: `rgb(${sbg})`, ratio: 0, need: 3, needsEye: false,
            unresolved: true, unresolvedWhy: 'paint-server',
            fgOpacity: cumulativeOpacity(kid),
            box: { x: Math.round(kru.x), y: Math.round(kru.y + scrollY), w: Math.round(kru.width), h: Math.round(kru.height) },
            vbox: { x: Math.round(kru.x), y: Math.round(kru.y), w: Math.round(kru.width), h: Math.round(kru.height) } });
          continue;
        }
        /*
         * 低透明度描边基本是「进度环底槽 / 分隔线」这类纯装饰，本来就该若隐若现，
         * 按 3:1 判它等于要求装饰件跟内容一样显眼 —— 会稳定灌进一批没人会去"修"的噪音。
         * WCAG 1.4.11 只约束「理解内容所必需」的图形部件，底槽不在其列。
         */
        const kAlphaOnly = kRaw.match(/^rgba?\([^)]*,\s*([\d.]+)\s*\)$/);
        if (kAlphaOnly && parseFloat(kAlphaOnly[1]) < 0.25) continue;
        const kComposed = composeFg(kRaw, sInfo, kid);
        if (!kComposed) continue;
        const kc = contrast(kComposed, sbg);
        if (kc >= 3 && !sEye) continue;
        const kKey = `svgkid|${kRaw}|${sbg}|${label(el)}`;
        if (seen.has(kKey)) continue;
        seen.add(kKey);
        const kr = el.getBoundingClientRect();   // 报根节点的框：子形状的框常常小到取不出像素
        tagAudit(kid, ++auditId);
        out.push({ auditId, kind: 'icon', text: '', sel: `${label(el)}>${kid.tagName}`,
          fg: kRaw, bg: `rgb(${sbg})`, ratio: +kc.toFixed(2), need: 3, needsEye: sEye,
          fgOpacity: cumulativeOpacity(kid),
          box: { x: Math.round(kr.x), y: Math.round(kr.y + scrollY), w: Math.round(kr.width), h: Math.round(kr.height) },
          vbox: { x: Math.round(kr.x), y: Math.round(kr.y), w: Math.round(kr.width), h: Math.round(kr.height) } });
        }
      }
      continue;
    }
    if (isTransparent(raw) || isPlatformOverlay(el)) continue;
    const pInfo = effectiveBg(el.parentElement || el);
    const { bg, needsEye } = pInfo;
    const composed = composeFg(raw, pInfo, el);
    if (!composed) continue;
    const c = contrast(composed, bg);
    if (c >= 3 && !needsEye) continue;   // 同文字分支：渐变底上的「达标」是近似值，留给重采样定夺
    const key = `svg|${raw}|${bg}|${label(el)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = el.getBoundingClientRect();
    tagAudit(el, ++auditId);
    out.push({ auditId, kind: 'icon', text: '', sel: label(el), fg: raw, bg: `rgb(${bg})`,
      ratio: +c.toFixed(2), need: 3, needsEye, fgOpacity: cumulativeOpacity(el),
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
      /*
       * 键必须带视口。加了视口矩阵之后，同一处缺陷在 desktop 与 mobile 各命中一次，
       * 而 `theme:route` 把两次折成一个 —— routeCount 系统性偏低，而我恰恰是用
       * routeCount 给缺陷排优先级的，等于按一份偏低的数排序
       * （Codex 在 PR #1374 第三十轮抓到；又是「加维度没回头改按旧维度建的键」，
       * 这个形状第四次出现了）。
       */
      g.routes.add(`${r.viewport || 'desktop'}:${r.theme}:${r.route}`);
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
    ...(() => {
      // 「没量成」必须与「实测不达标」分开报：前者是工具没够着，后者才是缺陷
      const un = report.reduce((s2, r) => s2 + r.findings.filter((f) => f.unresolved).length, 0);
      return un ? ['', `> 其中 ${un} 处是**采样失败**（渐变底没量成，不是实测不达标），需人工看一眼。`] : [];
    })(),
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

  /*
   * 为什么不是「整页截一张、按文档坐标采样」——那是上一版，前提是错的。
   *
   * 本应用遵守 full-height-layout：外壳撑满视口、滚动发生在**内层容器**里，
   * 于是 document.scrollHeight === 视口高度，`fullPage: true` 截出来的就是
   * 视口那一张（实测 imgH 恒为 900）。而候选是按 getBoundingClientRect 收的，
   * 首屏以下的元素 r.y 会到 1500+，一律落在图外 —— 单是首页就有 84 个候选
   * 因此从来没被真实测量过，只是被标成 unresolved。这个洞在第十七轮把
   * unresolved 计入不合格之后才暴露出来，此前它一直是静默的。
   *
   * 改成「按屏采样」：把还没采到的目标滚进视口（scrollIntoView 会自动滚动
   * 它所在的那个内层容器），截当前视口，然后把**此刻落在视口内**的目标一次采完。
   * 复杂度是 O(屏数) 而不是 O(元素数)，一页通常 3~6 屏。
   */
  const pending = new Map(targets.map((f) => [f.auditId, f]));
  let guard = 0;

  while (pending.size && guard < 24) {
    guard += 1;
    const ids = [...pending.keys()];

    // 把第一个还没采到的目标滚进视口（连带滚动它所在的内层滚动容器）
    const ok = await page.evaluate((idList) => {
      for (const id of idList) {
        const el = document.querySelector(`[data-audit-id~="${id}"]`);
        if (!el) continue;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        return true;
      }
      return false;
    }, ids);
    if (!ok) break;
    await page.waitForTimeout(150);

    // 隐前景（只隐还没采到的），截当前视口，再还原
    await page.evaluate((idList) => {
      /*
       * 同一个元素只能记一次原样式。
       * SVG 子形状的 fill 与 stroke 是两条候选、却落在同一个 DOM 节点上，
       * 按 id 遍历会把它记两遍 —— 第二遍记下的是**已经被改成 transparent 的值**。
       * 还原时先写回原值、再写回 transparent，结果这个形状永久隐形，
       * 后续候选的截图里它就消失了，底色自然采错（Codex 在 PR #1374 第二十七轮抓到，
       * 又是我加双通道时引入的连带伤害）。
       */
      window.__auditRestore = [];
      const seenEl = new Set();
      for (const id of idList) {
        const el = document.querySelector(`[data-audit-id~="${id}"]`);
        if (!el || seenEl.has(el)) continue;
        seenEl.add(el);
        window.__auditRestore.push([el, el.style.color, el.style.fill, el.style.stroke]);
        el.style.setProperty('color', 'transparent', 'important');
        el.style.setProperty('fill', 'transparent', 'important');
        el.style.setProperty('stroke', 'transparent', 'important');
      }
    }, ids);
    const shot = await page.screenshot();          // 视口截图，配视口坐标
    await page.evaluate(() => {
      for (const [el, c, f, st] of window.__auditRestore || []) {
        el.style.color = c; el.style.fill = f; el.style.stroke = st;
      }
      delete window.__auditRestore;
    });

    const batch = await page.evaluate(async ({ b64, idList }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const scale = img.width / window.innerWidth;   // 视口截图 → 用视口宽定标
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

      const out = {};
      for (const { id, fg, opacity } of idList) {
        const el = document.querySelector(`[data-audit-id~="${id}"]`);
        if (!el) { out[id] = { why: 'element-gone' }; continue; }
        const r = el.getBoundingClientRect();
        // 只处理此刻真正落在视口内的；其余留到下一屏
        if (r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth) continue;
        const x0 = Math.max(0, Math.round(r.x * scale));
        const y0 = Math.max(0, Math.round(r.y * scale));
        const x1 = Math.min(img.width, Math.round((r.x + r.width) * scale));
        const y1 = Math.min(img.height, Math.round((r.y + r.height) * scale));
        if (x1 - x0 < 2 || y1 - y0 < 2) { out[id] = { why: 'box-too-small' }; continue; }
        /*
         * 采样区向内缩，别把元素自己的边缘算成底色。
         *
         * 小圆徽章最典型：AvatarProgressRing 的等级角标只有 14×14，还带 1.5px 的
         * 环形描边，整框采样里「描边 + 抗锯齿边缘 + 背后头像」混出来的颜色能占到
         * 显著比例 —— 于是报出 4.16:1，而字实际压着的纯底色是 6.0~8.2:1。
         * 这一条在全量结果里横跨 121 个组合，是最大的一组「缺陷」，实为测量假象。
         * 缩进取 20%（上下左右各 10%），小框至少留 2px，避免缩没了。
         */
        const insetX = Math.min(Math.floor((x1 - x0) * 0.2), Math.max(0, Math.floor((x1 - x0 - 2) / 2)));
        const insetY = Math.min(Math.floor((y1 - y0) * 0.2), Math.max(0, Math.floor((y1 - y0 - 2) / 2)));
        const sx0 = x0 + insetX, sy0 = y0 + insetY;
        const sx1 = x1 - insetX, sy1 = y1 - insetY;
        /*
         * 取元素框内的**众数色**当底色，而不是正中一个点。
         * 单点采样在小控件上会翻车：隐前景那一步偶尔不生效（React 重渲染会抹掉
         * 临时 inline style），正中恰好压着字形就采到文字色本身 —— 报出来是
         * fg === bg、比值 1.00 的假阳性。字形只占框内少数像素，众数天然是底色。
         */
        const sw = sx1 - sx0, sh = sy1 - sy0;
        const px = cx.getImageData(sx0, sy0, sw, sh).data;
        /*
         * 按**空间网格**取最差，不按颜色直方图。
         *
         * 上一版的做法是「量化成 5bit 色桶、只看占比 ≥12% 的桶」。它对平滑渐变失效：
         * 渐变把像素摊到几十个桶里，每个桶都不到 12%，于是全部被丢掉、退回众数 ——
         * 又变回「按占地最多的那段判」，等于修了个寂寞（Codex 在 PR #1374 第二十五轮抓到）。
         *
         * 改成把采样区切成网格，每格取**去掉近前景色像素后的均值**，再在各格之间取
         * 最差对比度。均值天然压掉字形抗锯齿，网格天然覆盖渐变两端，两个毛病一起治。
         */
        const COLS = 5, ROWS = 3;
        const fgProbe = compose(fg, [128, 128, 128]);
        const nearFg = (r, g, b) => fgProbe
          && Math.abs(r - fgProbe[0]) + Math.abs(g - fgProbe[1]) + Math.abs(b - fgProbe[2]) < 24;
        const cells = [];
        for (let cy = 0; cy < ROWS; cy += 1) {
          for (let cx2 = 0; cx2 < COLS; cx2 += 1) {
            const x0c = Math.floor((cx2 * sw) / COLS), x1c = Math.floor(((cx2 + 1) * sw) / COLS);
            const y0c = Math.floor((cy * sh) / ROWS), y1c = Math.floor(((cy + 1) * sh) / ROWS);
            let r = 0, g = 0, b = 0, n = 0;
            for (let y = y0c; y < y1c; y += 1) {
              for (let x = x0c; x < x1c; x += 1) {
                const i = (y * sw + x) * 4;
                if (nearFg(px[i], px[i + 1], px[i + 2])) continue;   // 极可能是没隐掉的字形
                r += px[i]; g += px[i + 1]; b += px[i + 2]; n += 1;
              }
            }
            if (n < 4) continue;   // 这一格几乎全是字形，取不出可信底色
            cells.push([Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
          }
        }
        if (!cells.length) {
          // 整框都被字形占满：退回全框均值，宁可保守也不要凭空判失败
          let r = 0, g = 0, b = 0, n = 0;
          for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; b += px[i + 2]; n += 1; }
          if (!n) { out[id] = { why: 'no-pixels' }; continue; }
          cells.push([Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
        }
        const o = typeof opacity === 'number' ? opacity : 1;
        let worst = null;
        for (const bg of cells) {
          const solid = compose(fg, bg);
          if (!solid) continue;
          const composed = o >= 0.999
            ? solid
            : [0, 1, 2].map((i) => Math.round(solid[i] * o + bg[i] * (1 - o)));
          const ratio = +contrast(composed, bg).toFixed(2);
          if (!worst || ratio < worst.ratio) worst = { bg, ratio };
        }
        if (!worst) { out[id] = { why: 'compose-failed' }; continue; }
        out[id] = worst;
      }
      return out;
    }, { b64: shot.toString('base64'), idList: ids.map((id) => ({ id, fg: pending.get(id).fg, opacity: pending.get(id).fgOpacity ?? 1 })) });

    let progressed = false;
    for (const [idStr, r] of Object.entries(batch)) {
      const id = Number(idStr);
      const f = pending.get(id);
      if (!f) continue;
      progressed = true;
      if (r.why) { f.unresolved = true; f.unresolvedWhy = r.why; f.ratio = 0; }
      else { f.bg = `rgb(${r.bg})`; f.ratio = r.ratio; f.sampled = true; }
      pending.delete(id);
    }
    // 这一屏一个都没推进（滚动没生效 / 目标始终不在视口）——再转下去也是死循环
    if (!progressed) break;
  }

  /*
   * 采样失败 ≠ 达标。剩下没采到的显式标成未解析并把比值压 0 ——
   * 两个调用方随后一律 `filter(f => f.ratio < f.need)`，若留着祖先推断的近似值，
   * 「近似恰好判达标、真实值从没量过」的候选就被静默丢掉。
   * unresolved 供报告区分「实测不达标」与「没量成」，两者都算不合格。
   */
  for (const f of pending.values()) {
    f.unresolved = true;
    f.unresolvedWhy = f.unresolvedWhy || 'not-reached';
    f.ratio = 0;
  }
  return findings;
}

/*
 * ── 两个入口的共享入参判据 ────────────────────────────────────────────────
 *
 * 为什么非抽不可：路由清单与视口这两处判据，之前各自在远端版和本地版抄了一份。
 * 结果是同一个坑修两遍还漏一遍 —— 第十八轮给远端加视口矩阵、本地没加；
 * 第二十轮给远端加空清单兜底、本地没加；第二十一轮两条一起被抓回来。
 * 这正是 predicate-and-wiring-discipline 形状 3（判据分裂后各自漂移）。
 * 从此判据只此一份，两个入口都从这里取。
 */

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

/**
 * 解析 AUDIT_VIEWPORTS。拼错名字或解析成空一律抛错 ——
 * 否则循环跑 0 次、expected 也是 0，一次什么都没扫的运行会 exit 0。
 */
export function resolveViewports(raw) {
  const requested = (raw || 'desktop,mobile').split(',').map((x) => x.trim()).filter(Boolean);
  const unknown = requested.filter((x) => !VIEWPORTS[x]);
  const active = requested.filter((x) => VIEWPORTS[x]);
  if (unknown.length || !active.length) {
    throw new Error(`AUDIT_VIEWPORTS 无效：${unknown.join(', ') || '(空)'}；可选 ${Object.keys(VIEWPORTS).join(' / ')}`);
  }
  return active;
}

/**
 * 审计路由清单：navRegistry（前端 SSOT）+ App.tsx（嵌套写法只在这里）+ 显式的 `/`。
 *
 * `/` 必须显式留着：它原本被 `p !== '/'` 过滤掉，靠 /login、/stats、/prd-agent
 * 三条重定向路由「顺带」扫到；那三条一旦按落地地址正确排除，首页就会变成零覆盖 ——
 * 全站最重要的一屏一次都没量过，报告还显示满覆盖。
 *
 * 参数化（含 `:`）与通配（含 `*`）跳过：要真实 id 才打得开，走 AUDIT_ROUTES 传具体路径。
 * AUDIT_ONLY 里有名字没匹配上、或最终清单为空，一律抛错而不是静默跑 0 条。
 */
export function resolveRoutes({ adminDir, readFile, routesFile, only }) {
  let list;
  if (routesFile) {
    list = JSON.parse(readFile(routesFile));
  } else {
    const grab = (rel, re) => [...readFile(`${adminDir}/${rel}`).matchAll(re)].map((m) => m[1]);
    const all = [
      ...grab('src/app/navRegistry.tsx', /path:\s*'([^']+)'/g),
      ...grab('src/app/App.tsx', /<Route\s+path="([^"]+)"/g),
      '/',
    ]
      .map((p) => (p.startsWith('/') ? p : `/${p}`))   // App.tsx 的嵌套写法没有前导斜杠
      .filter((p) => !p.includes(':') && !p.includes('*'));
    list = [...new Set(all)].sort();
  }
  const wanted = (only || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (wanted.length) {
    const missing = wanted.filter((p) => !list.includes(p));
    if (missing.length) throw new Error(`AUDIT_ONLY 里这些路由不在清单中：${missing.join(', ')}`);
    list = list.filter((p) => wanted.includes(p));
  }
  if (!list.length) throw new Error('路由清单为空（检查 AUDIT_ROUTES / AUDIT_ONLY）——空清单不许当成一次成功的审计');
  return list;
}

/** 参数化路由（从来没扫过的那批），供收尾如实声明未覆盖范围。 */
export function parameterizedRoutes(adminDir, readFile) {
  const grab = (rel, re) => [...readFile(`${adminDir}/${rel}`).matchAll(re)].map((m) => m[1]);
  return [...new Set([
    ...grab('src/app/navRegistry.tsx', /path:\s*'([^']+)'/g),
    ...grab('src/app/App.tsx', /<Route\s+path="([^"]+)"/g),
  ])].filter((p) => p.includes(':'));
}
