/**
 * 印相台：视觉创作首页的背景美术层。
 *
 * 为什么不是「灯 + 粒子」：那两样是屏保的语言，谁家产品都能贴，贴上去只说明
 * 这里需要点东西填空。这一层用**这个产品自己的对象**：暗房 / 印房里的东西。
 *
 *   1. 版面墨块 —— 两块柔边色场（暖赤陶 + 冷靛），故意错开一点点套印，
 *                  riso / 丝网印的失准感，是「印」不是「亮」；
 *   2. 灰阶梯尺 —— 一条从黑到白的阶调标尺，摄影暗房用来校准影调的那把尺；
 *   3. 色标条   —— 印刷厂在版边留的那排小色块，用来对色；
 *   4. 网点     —— 极细的半调网点，印刷的皮肤；
 *   5. 套准十字 —— 四角的印刷套准标记。整页唯一的「说明性」符号。
 *
 * 两条被推翻的做法，写在这里免得再来一遍：
 *
 * - **不用胶片语言**。第一版画的是 35mm 接触印样：一格格画面 + 齿孔边条。
 *   用户看完说「用电影的背景就有点奇怪了」——对的：齿孔和连续画格是**动态影像**
 *   的符号，这里是静态图像工具，隔壁才是视频创作。改成灰阶梯尺和色标条，
 *   同样是暗房/印房的东西，但属于静态图像那一支。
 * - **网点不能大**。第一版 9px 周期、半径 1.6（覆盖率约 10%），铺满整页之后
 *   规则的圆点阵列读出来就是马赛克（用户原话：你的背景长得像马赛克）。
 *   现在 16px 周期、半径 0.75（覆盖率约 0.7%），并且**半径跟着遮罩衰减**，
 *   靠近边缘才有——那才是「网点」，不是格子。
 *
 * 全部是静态 SVG + CSS，没有 canvas 循环；唯一的动画是墨块极慢的呼吸，
 * prefers-reduced-motion 下停掉。
 */

/** 灰阶梯尺：多少级、多大。真实的柯达阶调尺是 21 级，这里取 15 级够用。 */
const WEDGE_STEPS = 15;
const WEDGE_W = 104;
const WEDGE_H = 132;
const WEDGE_X = -140;
const WEDGE_Y = 92;
const WEDGE_ROTATE = -7.5;

/** 色标条：印刷版边那排对色块。 */
const BAR_SWATCH = 30;
const BAR_X = 986;
const BAR_Y = 902;

/** 梯尺每一级的亮度。从近乎全黑推到中灰——整条不许推到亮，那会变成一条白带子。 */
function wedgeOpacity(i: number): number {
  return 0.006 + (i / (WEDGE_STEPS - 1)) * 0.055;
}

export function DarkroomPlate() {
  return (
    <div className="plate" aria-hidden>
      <svg
        className="plate__svg"
        viewBox="0 0 1440 1020"
        preserveAspectRatio="xMidYMid slice"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/* 网点。16px 周期、半径 0.75：覆盖率不到 1%，整页尺度上读作纸的纹理。
              第一版 9px / 1.6 覆盖率约 10%，那是马赛克不是网点。 */}
          <pattern id="plate-halftone" width="16" height="16" patternUnits="userSpaceOnUse">
            <circle cx="8" cy="8" r="0.75" className="plate__dot" />
          </pattern>

          {/* 墨块的柔边。印出来的墨没有硬边，这一步是「像印的」的关键。 */}
          <filter id="plate-bleed" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="46" />
          </filter>
          <filter id="plate-bleed-soft" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="70" />
          </filter>

          {/*
           * 中间要淡下去——但**不能空掉**。
           *
           * 取证过三版：铺满 → 标题压在线条上糊成一片；彻底挖空 → 磨砂玻璃背后
           * 一片纯色，那块卡退化成实心方块（磨砂的意义正在于透出后面那点东西）；
           * 留三成 → 对。遮罩一律写成「白 + 不透明度」而不是灰阶 hex：
           * 遮罩看的是亮度，白 30% 和 30% 灰等效，但前者一眼看得出「这里露三成」，
           * 也不会被双皮肤棘轮误判成新增的深色硬编码。
           * （棘轮是连注释一起扫的，所以这段话里也不能出现那个字面量。）
           */}
          <radialGradient id="plate-clear" cx="50%" cy="44%" r="66%">
            <stop offset="0%" stopColor="#fff" stopOpacity="0.29" />
            <stop offset="42%" stopColor="#fff" stopOpacity="0.34" />
            <stop offset="76%" stopColor="#fff" stopOpacity="0.88" />
            <stop offset="100%" stopColor="#fff" stopOpacity="1" />
          </radialGradient>
          <mask id="plate-edges">
            <rect x="0" y="0" width="1440" height="1020" fill="url(#plate-clear)" />
          </mask>

          {/* 网点只在四周，中间完全不铺——中间是内容区，一点纹理都不该有。 */}
          <radialGradient id="plate-dot-falloff" cx="50%" cy="46%" r="70%">
            <stop offset="0%" stopColor="#fff" stopOpacity="0" />
            <stop offset="52%" stopColor="#fff" stopOpacity="0" />
            <stop offset="100%" stopColor="#fff" stopOpacity="1" />
          </radialGradient>
          <mask id="plate-dot-mask">
            <rect x="0" y="0" width="1440" height="1020" fill="url(#plate-dot-falloff)" />
          </mask>
        </defs>

        {/* --- 1. 版面墨块：两块，错开套印。
             位置是取证调的：必须有一块**从输入卡背后穿过去**，
             否则磨砂玻璃后面没有明暗，玻璃就白磨了。 --- */}
        <g className="plate__inks">
          <ellipse cx="600" cy="330" rx="520" ry="300" className="plate__ink-warm" filter="url(#plate-bleed)" />
          <ellipse cx="1230" cy="820" rx="500" ry="300" className="plate__ink-cool" filter="url(#plate-bleed-soft)" />
          {/* 套印失准：同一块暖墨再印一次，偏 26px，只留很淡的一层。 */}
          <ellipse cx="626" cy="356" rx="520" ry="300" className="plate__ink-misreg" filter="url(#plate-bleed)" />
        </g>

        {/* --- 4. 网点 --- */}
        <rect x="0" y="0" width="1440" height="1020" fill="url(#plate-halftone)" mask="url(#plate-dot-mask)" />

        {/* --- 2. 灰阶梯尺。
             mask 挂在**没有 transform 的外层**：挂在旋转的组上遮罩会跟着转，
             中间那块留白就不在页面中间了。外层遮罩、内层旋转，顺序不能反。 --- */}
        <g mask="url(#plate-edges)">
          <g transform={`rotate(${WEDGE_ROTATE} 300 260)`}>
            {Array.from({ length: WEDGE_STEPS }).map((_, i) => (
              <rect
                key={`w-${i}`}
                x={WEDGE_X + i * WEDGE_W}
                y={WEDGE_Y}
                width={WEDGE_W}
                height={WEDGE_H}
                className="plate__wedge"
                style={{ opacity: wedgeOpacity(i) }}
              />
            ))}
            {/* 尺子的上下两条边线，让它读作一件器物而不是一排色块。 */}
            <line x1={WEDGE_X} y1={WEDGE_Y} x2={WEDGE_X + WEDGE_STEPS * WEDGE_W} y2={WEDGE_Y} className="plate__rule" />
            <line
              x1={WEDGE_X}
              y1={WEDGE_Y + WEDGE_H}
              x2={WEDGE_X + WEDGE_STEPS * WEDGE_W}
              y2={WEDGE_Y + WEDGE_H}
              className="plate__rule"
            />
          </g>

          {/* --- 3. 色标条：版边那排对色块，右下角，很小。 --- */}
          <g transform={`rotate(${WEDGE_ROTATE} 1200 900)`}>
            {['warm', 'warm2', 'cool', 'neutral', 'warm', 'cool', 'neutral', 'warm2'].map((kind, i) => (
              <rect
                key={`b-${i}`}
                x={BAR_X + i * (BAR_SWATCH + 4)}
                y={BAR_Y}
                width={BAR_SWATCH}
                height={BAR_SWATCH * 0.62}
                rx="1"
                className={`plate__swatch plate__swatch--${kind}`}
              />
            ))}
          </g>
        </g>

        {/* --- 5. 套准十字：四角，印刷标记 --- */}
        {[
          [58, 96], [1382, 96], [58, 946], [1382, 946],
        ].map(([cx, cy]) => (
          <g key={`${cx}-${cy}`} className="plate__reg">
            <circle cx={cx} cy={cy} r="11" />
            <line x1={cx - 19} y1={cy} x2={cx + 19} y2={cy} />
            <line x1={cx} y1={cy - 19} x2={cx} y2={cy + 19} />
          </g>
        ))}
      </svg>

      {/* 纸的颗粒。SVG 之上、内容之下，把上面所有硬边压回同一张纸上。 */}
      <div className="plate__grain" />
    </div>
  );
}
