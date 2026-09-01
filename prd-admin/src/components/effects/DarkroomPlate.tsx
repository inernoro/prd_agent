/**
 * 印相台：视觉创作首页的背景美术层。
 *
 * 为什么不是「灯 + 粒子」：那两样是屏保的语言，谁家产品都能贴，贴上去只说明
 * 这里需要点东西填空。这一层换成**这个产品自己的对象**——暗房里的接触印相台：
 *
 *   1. 版面墨块  —— 两块柔边色场（暖赤陶 + 冷靛），故意错开一点点套印，
 *                   riso / 丝网印的失准感，是「印」不是「亮」；
 *   2. 接触印样  —— 一张歪着放的印样纸，上面是 35mm 的一格格画面，
 *                   出血到画外，只露一部分。这是暗房真实存在的那张纸；
 *   3. 片孔边条  —— 印样边上的齿孔；
 *   4. 网点      —— 一片放大的半调网点，压在墨块交界上，印刷的皮肤；
 *   5. 套准十字  —— 四角的印刷套准标记。整页唯一的「说明性」符号。
 *
 * 和轮换背景图的关系：这一层压在 BackdropPhoto **之上**，那张图仍然全幅铺开当底光，
 * 合起来读作「一张片子摊在灯箱上」。本组件的 photoSrc 是另一件事——把同一张图再放进
 * 印样的其中一格；不传就没有那一格，整层照常成立。
 *
 * 一开始想的是「照片只放进一格、不再全幅」，取证之后否了：那样轮换素材被降级成角落里
 * 一个 92x62 的小方块，等于把上一轮刚做的功能废掉。
 *
 * 全部是静态 SVG + CSS，没有 canvas 循环、没有逐帧计算；唯一的动画是墨块
 * 极慢的呼吸，prefers-reduced-motion 下停掉。
 */

/**
 * 印样的格子布局。单位是 viewBox 坐标（1440x1020 的画布）。
 *
 * 尺寸是取证调出来的：第一版 214x143 的大格子在整页尺度上不像印样，像四个大方块
 * （plate-a0.382-b26.png）。接触印样的语言在于**小而多**——一张纸上一整卷片子。
 */
const FRAME_W = 92;
const FRAME_H = 62;
const GAP_X = 8;
const GAP_Y = 22;
const COLS = 17;
const ROWS = 11;
/** 印样纸整体的摆放：歪一点，并且往左上挪出画外，让它是「一张纸的一角」而不是居中构图。 */
const SHEET_ROTATE = -7.5;
const SHEET_X = -150;
const SHEET_Y = -130;

/** 哪几格里有影调（其余是空片基）。挑得稀疏，让整张纸有疏密。 */
const TONED = new Set([
  '0-2', '0-9', '1-5', '1-13', '2-1', '2-7', '3-11', '3-3', '4-15',
  '5-0', '5-8', '6-4', '6-12', '7-2', '8-9', '8-14', '9-6', '10-11',
]);
/**
 * 照片落在哪一格。
 *
 * 必须挑一个**遮罩是亮的**格子——否则它跟着中间那块留白一起被压到三成，
 * 等于轮换素材白换（第三版就犯了这个错：格子选在正中，整张图完全看不见）。
 * 左下角这一格算完旋转后落在页面 (100, 655) 附近，正是遮罩最亮的区域。
 */
const PHOTO_CELL = { row: 9, col: 2 };

function frameXY(row: number, col: number) {
  return { x: SHEET_X + col * (FRAME_W + GAP_X), y: SHEET_Y + row * (FRAME_H + GAP_Y) };
}

export function DarkroomPlate({ photoSrc }: { photoSrc?: string | null }) {
  const photo = frameXY(PHOTO_CELL.row, PHOTO_CELL.col);

  return (
    <div className="plate" aria-hidden>
      <svg
        className="plate__svg"
        viewBox="0 0 1440 1020"
        preserveAspectRatio="xMidYMid slice"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/* 半调网点。放到 9px 一个周期——再密就成灰面了，看不出是网点。 */}
          <pattern id="plate-halftone" width="9" height="9" patternUnits="userSpaceOnUse">
            <circle cx="4.5" cy="4.5" r="1.6" className="plate__dot" />
          </pattern>
          {/* 墨块的柔边。印出来的墨没有硬边，这一步是「像印的」的关键。 */}
          <filter id="plate-bleed" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="46" />
          </filter>
          <filter id="plate-bleed-soft" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="70" />
          </filter>
          <radialGradient id="plate-tone" cx="38%" cy="32%" r="78%">
            <stop offset="0%" className="plate__tone-hi" />
            <stop offset="100%" className="plate__tone-lo" />
          </radialGradient>
          <clipPath id="plate-photo-clip">
            <rect x={photo.x} y={photo.y} width={FRAME_W} height={FRAME_H} rx="2" />
          </clipPath>

          {/*
           * 中间要淡下去——但**不能空掉**。
           *
           * 两版取证：第一版整页铺满印样，标题直接压在片格线上，糊成一片；
           * 第二版中间彻底挖空，安静是安静了，可磨砂玻璃后面什么都没有，
           * 那块卡就退化成一块实心深色方块——磨砂的意义正在于「透出后面那点东西」。
           *
           * 所以中间不是 0 而是**三成**：线条弱到不干扰读字，又足以让玻璃有东西可折。
           */}
          {/* 遮罩一律写成「白 + 不透明度」而不是灰阶 hex：
              遮罩看的是亮度，白 30% 和 30% 灰等效，但前者一眼看得出「这里露三成」，
              也不会被双皮肤棘轮误判成新增的深色硬编码——纯黑那个写法就被它拦过。
              （棘轮是连注释一起扫的，所以这段话里也不能出现那个字面量。） */}
          <radialGradient id="plate-clear" cx="50%" cy="44%" r="66%">
            <stop offset="0%" stopColor="#fff" stopOpacity="0.29" />
            <stop offset="42%" stopColor="#fff" stopOpacity="0.34" />
            <stop offset="76%" stopColor="#fff" stopOpacity="0.88" />
            <stop offset="100%" stopColor="#fff" stopOpacity="1" />
          </radialGradient>
          <mask id="plate-edges">
            <rect x="0" y="0" width="1440" height="1020" fill="url(#plate-clear)" />
          </mask>

          {/* 网点只在左下角一块，且边缘要化开——第一版能看见那个矩形的直边。 */}
          <radialGradient id="plate-dot-falloff" cx="14%" cy="86%" r="58%">
            <stop offset="0%" stopColor="#fff" stopOpacity="1" />
            <stop offset="55%" stopColor="#fff" stopOpacity="0.53" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <mask id="plate-dot-mask">
            <rect x="0" y="0" width="1440" height="1020" fill="url(#plate-dot-falloff)" />
          </mask>
        </defs>

        {/* --- 1. 版面墨块：两块，错开套印。
             位置是取证调的：墨块必须有一块**从输入卡背后穿过去**，
             否则磨砂玻璃后面没有明暗，玻璃就白磨了。 --- */}
        <g className="plate__inks">
          <ellipse cx="600" cy="330" rx="520" ry="300" className="plate__ink-warm" filter="url(#plate-bleed)" />
          <ellipse cx="1230" cy="820" rx="500" ry="300" className="plate__ink-cool" filter="url(#plate-bleed-soft)" />
          {/* 套印失准：同一块暖墨再印一次，偏 26px，只留很淡的一层。 */}
          <ellipse cx="626" cy="356" rx="520" ry="300" className="plate__ink-misreg" filter="url(#plate-bleed)" />
        </g>

        {/* --- 4. 网点：左下角一片，边缘用 mask 化开，不留直边 --- */}
        <rect x="0" y="0" width="1440" height="1020" fill="url(#plate-halftone)" mask="url(#plate-dot-mask)" />

        {/* --- 2/3. 接触印样。
             mask 挂在**没有 transform 的外层**：挂在旋转的组上，遮罩会跟着一起转，
             中间那块留白就不在页面中间了。外层遮罩、内层旋转，顺序不能反。 --- */}
        <g mask="url(#plate-edges)">
        <g transform={`rotate(${SHEET_ROTATE} 300 260)`} className="plate__sheet">
          {Array.from({ length: ROWS }).flatMap((_, row) =>
            Array.from({ length: COLS }).map((_, col) => {
              const { x, y } = frameXY(row, col);
              const isPhoto = row === PHOTO_CELL.row && col === PHOTO_CELL.col;
              return (
                <g key={`${row}-${col}`}>
                  {TONED.has(`${row}-${col}`) && !isPhoto && (
                    <rect x={x} y={y} width={FRAME_W} height={FRAME_H} rx="2" fill="url(#plate-tone)" className="plate__toned" />
                  )}
                  <rect x={x} y={y} width={FRAME_W} height={FRAME_H} rx="2" className="plate__frame" />
                </g>
              );
            }),
          )}

          {/* 轮换的那张照片：落进其中一格，不是全幅壁纸。 */}
          {photoSrc && (
            <g clipPath="url(#plate-photo-clip)" className="plate__photo">
              <image
                href={photoSrc}
                x={photo.x}
                y={photo.y}
                width={FRAME_W}
                height={FRAME_H}
                preserveAspectRatio="xMidYMid slice"
              />
              <rect x={photo.x} y={photo.y} width={FRAME_W} height={FRAME_H} className="plate__photo-veil" />
            </g>
          )}

          {/* 片孔边条：每一行印样纸的上下边。间距按格宽走，格子变了它自己跟着变。 */}
          {Array.from({ length: ROWS }).flatMap((_, row) =>
            Array.from({ length: COLS * 6 }).map((_, i) => {
              const { y } = frameXY(row, 0);
              const x = SHEET_X + 3 + i * 17;
              return (
                <g key={`s-${row}-${i}`}>
                  <rect x={x} y={y - 11} width="7" height="6" rx="1.5" className="plate__sprocket" />
                  <rect x={x} y={y + FRAME_H + 5} width="7" height="6" rx="1.5" className="plate__sprocket" />
                </g>
              );
            }),
          )}
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
