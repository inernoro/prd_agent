/**
 * 项目路由智能体 Agent 卡片内联动态插画
 *
 * 视觉隐喻：方案 .md → AI 抽取 → 多仓库克隆 → routemap 命中项目路径
 *
 * 设计要点：
 *   - 与 ReviewAgentCardArt 同 viewBox (300×400)、同尺寸语言（preserveAspectRatio="xMidYMid slice"）
 *   - 暗色基调 + 三个 radial 光晕 (sky / violet / emerald) 营造层次
 *   - 动效全部走 SVG <animate>，零 JS 依赖，对低端机 / 低电量友好
 *   - 4 处持续动画：顶部扫描线、3 条连接线 dash 流动、仓库节点脉冲、命中路径行的高亮闪烁
 */
export function ProjectRouteAgentCardArt() {
  return (
    <div className="absolute inset-0 z-0 overflow-hidden">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 300 400"
        className="absolute inset-0 w-full h-full"
        preserveAspectRatio="xMidYMid slice"
      >
        <defs>
          {/* 背景 radial 光晕 —— 三色叠加（sky 顶 / violet 右 / emerald 底） */}
          <radialGradient id="pra-gTop" cx="150" cy="0" r="240" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#0EA5E9" stopOpacity="0.55" />
            <stop offset="70%" stopColor="#0EA5E9" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#0EA5E9" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="pra-gRight" cx="290" cy="170" r="170" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#8B5CF6" stopOpacity="0.42" />
            <stop offset="100%" stopColor="#8B5CF6" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="pra-gBtm" cx="40" cy="400" r="230" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#10B981" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#10B981" stopOpacity="0" />
          </radialGradient>

          {/* 连接线渐变 */}
          <linearGradient id="pra-line" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#0EA5E9" stopOpacity="0" />
            <stop offset="30%" stopColor="#38BDF8" stopOpacity="0.85" />
            <stop offset="70%" stopColor="#67E8F9" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#10B981" stopOpacity="0" />
          </linearGradient>

          {/* 仓库节点渐变 */}
          <linearGradient id="pra-repo" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(56,189,248,0.32)" />
            <stop offset="100%" stopColor="rgba(56,189,248,0.08)" />
          </linearGradient>
          <linearGradient id="pra-repoMid" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(139,92,246,0.32)" />
            <stop offset="100%" stopColor="rgba(139,92,246,0.08)" />
          </linearGradient>
          <linearGradient id="pra-repoEmer" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(16,185,129,0.32)" />
            <stop offset="100%" stopColor="rgba(16,185,129,0.08)" />
          </linearGradient>

          {/* 文档卡片渐变 */}
          <linearGradient id="pra-doc" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(14,165,233,0.18)" />
            <stop offset="100%" stopColor="rgba(14,165,233,0.04)" />
          </linearGradient>

          {/* 滤镜 */}
          <filter id="pra-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="pra-blur2" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.2" />
          </filter>
          <filter id="pra-blur4" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" />
          </filter>

          {/* dot grid 背景 */}
          <pattern id="pra-dot" x="0" y="0" width="22" height="22" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.9" fill="rgba(255,255,255,0.13)" />
          </pattern>
        </defs>

        {/* ── Base ── */}
        <rect width="300" height="400" fill="#060A14" />
        <rect width="300" height="400" fill="url(#pra-dot)" />
        <rect width="300" height="400" fill="url(#pra-gTop)" />
        <rect width="300" height="400" fill="url(#pra-gRight)" />
        <rect width="300" height="400" fill="url(#pra-gBtm)" />

        {/* ── 顶部状态条 LIVE ── */}
        <rect x="50" y="20" width="200" height="22" rx="11"
          fill="rgba(8,14,30,0.7)" stroke="rgba(14,165,233,0.4)" strokeWidth="1" />
        <circle cx="62" cy="31" r="3" fill="#10B981" filter="url(#pra-blur2)" opacity="0.85">
          <animate attributeName="opacity" values="0.4;1;0.4" dur="1.6s" repeatCount="indefinite" />
        </circle>
        <circle cx="62" cy="31" r="1.8" fill="#A7F3D0">
          <animate attributeName="opacity" values="0.5;1;0.5" dur="1.6s" repeatCount="indefinite" />
        </circle>
        <text x="74" y="34" fill="rgba(255,255,255,0.78)" fontSize="8" fontFamily="monospace" letterSpacing="2.5">
          AI PROJECT ROUTING · LIVE
        </text>
        <circle cx="238" cy="31" r="2" fill="#38BDF8" />
        <text x="246" y="34" fill="rgba(56,189,248,0.85)" fontSize="7" fontFamily="monospace">v2</text>

        {/* ── 左侧：方案 .md 文档卡 ── */}
        <g>
          {/* glow */}
          <rect x="24" y="64" width="86" height="120" rx="8"
            fill="none" stroke="rgba(14,165,233,0.5)" strokeWidth="1.5"
            filter="url(#pra-blur4)" />
          {/* card */}
          <rect x="26" y="66" width="82" height="116" rx="7"
            fill="url(#pra-doc)" stroke="rgba(14,165,233,0.55)" strokeWidth="1" />
          {/* header bar */}
          <rect x="26" y="66" width="82" height="16" rx="7"
            fill="rgba(14,165,233,0.28)" />
          <text x="34" y="77" fill="rgba(255,255,255,0.85)" fontSize="7" fontFamily="monospace" letterSpacing="1.2">
            方案.md
          </text>
          <circle cx="99" cy="74" r="1.5" fill="#67E8F9" />
          {/* 文档头小节标题 */}
          <text x="32" y="96" fill="rgba(255,255,255,0.55)" fontSize="6.5" fontFamily="monospace" letterSpacing="0.8">
            # 一、文档头
          </text>
          {/* 应用 list item */}
          <rect x="32" y="102" width="2" height="2" fill="#0EA5E9" />
          <text x="38" y="105" fill="rgba(255,255,255,0.7)" fontSize="6.5" fontFamily="monospace">应用:</text>
          <text x="38" y="114" fill="rgba(56,189,248,0.9)" fontSize="6.5" fontFamily="monospace">智能营销</text>
          {/* 业务模块 list item */}
          <rect x="32" y="122" width="2" height="2" fill="#0EA5E9" />
          <text x="38" y="125" fill="rgba(255,255,255,0.7)" fontSize="6.5" fontFamily="monospace">业务模块:</text>
          <text x="38" y="134" fill="rgba(56,189,248,0.9)" fontSize="6.5" fontFamily="monospace">营销后台</text>
          {/* divider */}
          <line x1="32" y1="144" x2="102" y2="144"
            stroke="rgba(255,255,255,0.08)" strokeWidth="0.5" />
          {/* fake lines */}
          <rect x="32" y="150" width="64" height="2" rx="1" fill="rgba(255,255,255,0.18)" />
          <rect x="32" y="156" width="48" height="2" rx="1" fill="rgba(255,255,255,0.14)" />
          <rect x="32" y="162" width="56" height="2" rx="1" fill="rgba(255,255,255,0.12)" />
          <rect x="32" y="168" width="40" height="2" rx="1" fill="rgba(255,255,255,0.10)" />
        </g>

        {/* ── 中间：三条连接线（方案 → 仓库），dash 流动动画 ── */}
        {/* line 1 → repo top */}
        <path d="M 110 90 C 140 90, 150 95, 178 100"
          fill="none" stroke="url(#pra-line)" strokeWidth="1.2" strokeDasharray="6 4">
          <animate attributeName="stroke-dashoffset" from="0" to="-30" dur="1.4s" repeatCount="indefinite" />
        </path>
        {/* line 2 → repo mid */}
        <path d="M 110 125 C 140 125, 150 130, 178 135"
          fill="none" stroke="url(#pra-line)" strokeWidth="1.2" strokeDasharray="6 4">
          <animate attributeName="stroke-dashoffset" from="0" to="-30" dur="1.6s" repeatCount="indefinite" />
        </path>
        {/* line 3 → repo bottom */}
        <path d="M 110 160 C 140 160, 150 165, 178 170"
          fill="none" stroke="url(#pra-line)" strokeWidth="1.2" strokeDasharray="6 4">
          <animate attributeName="stroke-dashoffset" from="0" to="-30" dur="1.8s" repeatCount="indefinite" />
        </path>

        {/* ── 中间：3 个仓库节点 + 脉冲 ── */}
        {/* Repo 1 (sky) */}
        <g>
          <circle cx="194" cy="100" r="14"
            fill="none" stroke="rgba(56,189,248,0.55)" strokeWidth="1"
            filter="url(#pra-blur4)" opacity="0.7" />
          <circle cx="194" cy="100" r="11" fill="url(#pra-repo)" stroke="rgba(56,189,248,0.7)" strokeWidth="1" />
          {/* git fork glyph (mini) */}
          <circle cx="190" cy="96" r="1.6" fill="#67E8F9" />
          <circle cx="198" cy="96" r="1.6" fill="#67E8F9" />
          <circle cx="194" cy="105" r="1.6" fill="#67E8F9" />
          <line x1="190" y1="97.5" x2="190" y2="100" stroke="#67E8F9" strokeWidth="0.8" />
          <line x1="198" y1="97.5" x2="198" y2="100" stroke="#67E8F9" strokeWidth="0.8" />
          <line x1="190" y1="100" x2="198" y2="100" stroke="#67E8F9" strokeWidth="0.8" />
          <line x1="194" y1="100" x2="194" y2="103.5" stroke="#67E8F9" strokeWidth="0.8" />
          {/* pulse ring */}
          <circle cx="194" cy="100" r="11" fill="none" stroke="rgba(56,189,248,0.9)" strokeWidth="1">
            <animate attributeName="r" values="11;18;11" dur="2.4s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.8;0;0.8" dur="2.4s" repeatCount="indefinite" />
          </circle>
        </g>
        {/* Repo 2 (violet) */}
        <g>
          <circle cx="194" cy="135" r="14"
            fill="none" stroke="rgba(139,92,246,0.55)" strokeWidth="1"
            filter="url(#pra-blur4)" opacity="0.7" />
          <circle cx="194" cy="135" r="11" fill="url(#pra-repoMid)" stroke="rgba(139,92,246,0.7)" strokeWidth="1" />
          <circle cx="190" cy="131" r="1.6" fill="#C4B5FD" />
          <circle cx="198" cy="131" r="1.6" fill="#C4B5FD" />
          <circle cx="194" cy="140" r="1.6" fill="#C4B5FD" />
          <line x1="190" y1="132.5" x2="190" y2="135" stroke="#C4B5FD" strokeWidth="0.8" />
          <line x1="198" y1="132.5" x2="198" y2="135" stroke="#C4B5FD" strokeWidth="0.8" />
          <line x1="190" y1="135" x2="198" y2="135" stroke="#C4B5FD" strokeWidth="0.8" />
          <line x1="194" y1="135" x2="194" y2="138.5" stroke="#C4B5FD" strokeWidth="0.8" />
          <circle cx="194" cy="135" r="11" fill="none" stroke="rgba(139,92,246,0.9)" strokeWidth="1">
            <animate attributeName="r" values="11;18;11" dur="2.6s" begin="0.4s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.8;0;0.8" dur="2.6s" begin="0.4s" repeatCount="indefinite" />
          </circle>
        </g>
        {/* Repo 3 (emerald) */}
        <g>
          <circle cx="194" cy="170" r="14"
            fill="none" stroke="rgba(16,185,129,0.55)" strokeWidth="1"
            filter="url(#pra-blur4)" opacity="0.7" />
          <circle cx="194" cy="170" r="11" fill="url(#pra-repoEmer)" stroke="rgba(16,185,129,0.7)" strokeWidth="1" />
          <circle cx="190" cy="166" r="1.6" fill="#6EE7B7" />
          <circle cx="198" cy="166" r="1.6" fill="#6EE7B7" />
          <circle cx="194" cy="175" r="1.6" fill="#6EE7B7" />
          <line x1="190" y1="167.5" x2="190" y2="170" stroke="#6EE7B7" strokeWidth="0.8" />
          <line x1="198" y1="167.5" x2="198" y2="170" stroke="#6EE7B7" strokeWidth="0.8" />
          <line x1="190" y1="170" x2="198" y2="170" stroke="#6EE7B7" strokeWidth="0.8" />
          <line x1="194" y1="170" x2="194" y2="173.5" stroke="#6EE7B7" strokeWidth="0.8" />
          <circle cx="194" cy="170" r="11" fill="none" stroke="rgba(16,185,129,0.9)" strokeWidth="1">
            <animate attributeName="r" values="11;18;11" dur="2.8s" begin="0.8s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.8;0;0.8" dur="2.8s" begin="0.8s" repeatCount="indefinite" />
          </circle>
        </g>

        {/* ── 仓库 → routemap 连接线 ── */}
        <path d="M 205 100 C 230 100, 235 110, 232 124"
          fill="none" stroke="rgba(56,189,248,0.45)" strokeWidth="1" strokeDasharray="3 3">
          <animate attributeName="stroke-dashoffset" from="0" to="-18" dur="2s" repeatCount="indefinite" />
        </path>
        <path d="M 205 135 C 234 135, 246 140, 256 144"
          fill="none" stroke="rgba(139,92,246,0.45)" strokeWidth="1" strokeDasharray="3 3">
          <animate attributeName="stroke-dashoffset" from="0" to="-18" dur="2.2s" repeatCount="indefinite" />
        </path>
        <path d="M 205 170 C 234 170, 246 168, 256 164"
          fill="none" stroke="rgba(16,185,129,0.45)" strokeWidth="1" strokeDasharray="3 3">
          <animate attributeName="stroke-dashoffset" from="0" to="-18" dur="2.4s" repeatCount="indefinite" />
        </path>

        {/* ── 右下：routemap 项目路径 list ── */}
        <g>
          <rect x="36" y="218" width="228" height="124" rx="8"
            fill="rgba(8,14,30,0.7)" stroke="rgba(255,255,255,0.08)" strokeWidth="0.8" />
          {/* head */}
          <rect x="36" y="218" width="228" height="20" rx="8"
            fill="rgba(56,189,248,0.18)" />
          <rect x="36" y="232" width="228" height="6"
            fill="rgba(56,189,248,0.18)" />
          <line x1="50" y1="238" x2="250" y2="238" stroke="rgba(56,189,248,0.35)" strokeWidth="0.6" />
          {/* folder glyph */}
          <path d="M 48 226 L 52 226 L 53.5 228 L 60 228 L 60 234 L 48 234 Z"
            fill="rgba(56,189,248,0.4)" stroke="#67E8F9" strokeWidth="0.6" />
          <text x="68" y="232" fill="rgba(255,255,255,0.78)" fontSize="8" fontFamily="monospace" letterSpacing="1.5">
            routemap / 项目路径
          </text>
          <text x="246" y="232" textAnchor="end" fill="rgba(56,189,248,0.85)" fontSize="7" fontFamily="monospace">3 命中</text>

          {/* path rows */}
          {([
            { y: 250, color: '#67E8F9', text: 'apps/marketing/awards.json', hit: 'Hit' },
            { y: 268, color: '#C4B5FD', text: 'apps/marketing/orders.json', hit: 'Hit' },
            { y: 286, color: '#6EE7B7', text: 'services/sync-cutoff.md', hit: 'Hit' },
            { y: 304, color: 'rgba(255,255,255,0.32)', text: 'apps/dist/legacy.json', hit: '—' },
          ] as const).map((row, idx) => (
            <g key={row.text}>
              {/* tree connector */}
              <line x1="48" y1={row.y - 4} x2="48" y2={row.y + 4}
                stroke="rgba(255,255,255,0.12)" strokeWidth="0.6" />
              <line x1="48" y1={row.y + 1} x2="56" y2={row.y + 1}
                stroke="rgba(255,255,255,0.12)" strokeWidth="0.6" />
              {/* dot */}
              <circle cx="58" cy={row.y + 1} r="2" fill={row.color}>
                {row.hit === 'Hit' && (
                  <animate attributeName="opacity" values="0.55;1;0.55"
                    dur="1.8s" begin={`${idx * 0.3}s`} repeatCount="indefinite" />
                )}
              </circle>
              {/* path text */}
              <text x="66" y={row.y + 4} fill={row.hit === 'Hit' ? 'rgba(255,255,255,0.88)' : 'rgba(255,255,255,0.32)'}
                fontSize="7.5" fontFamily="monospace">
                {row.text}
              </text>
              {/* badge */}
              <rect x="216" y={row.y - 5} width="34" height="11" rx="3"
                fill={row.hit === 'Hit' ? 'rgba(16,185,129,0.18)' : 'rgba(255,255,255,0.05)'}
                stroke={row.hit === 'Hit' ? 'rgba(16,185,129,0.5)' : 'rgba(255,255,255,0.12)'}
                strokeWidth="0.6" />
              <text x="233" y={row.y + 2} textAnchor="middle"
                fill={row.hit === 'Hit' ? '#6EE7B7' : 'rgba(255,255,255,0.4)'}
                fontSize="6.5" fontFamily="monospace">
                {row.hit}
              </text>
            </g>
          ))}

          {/* divider before stats */}
          <line x1="46" y1="320" x2="254" y2="320"
            stroke="rgba(255,255,255,0.08)" strokeWidth="0.6" />
          {/* stats */}
          <text x="68" y="334" fill="rgba(255,255,255,0.32)" fontSize="6.5" fontFamily="monospace" letterSpacing="1">
            REPOS
          </text>
          <text x="68" y="335" fill="rgba(56,189,248,0.95)" fontSize="11" fontWeight="bold" fontFamily="monospace"
            dx="32">
            3
          </text>
          <line x1="124" y1="324" x2="124" y2="338" stroke="rgba(255,255,255,0.1)" strokeWidth="0.6" />
          <text x="138" y="334" fill="rgba(255,255,255,0.32)" fontSize="6.5" fontFamily="monospace" letterSpacing="1">
            PATHS
          </text>
          <text x="138" y="335" fill="rgba(139,92,246,0.95)" fontSize="11" fontWeight="bold" fontFamily="monospace"
            dx="32">
            12
          </text>
          <line x1="190" y1="324" x2="190" y2="338" stroke="rgba(255,255,255,0.1)" strokeWidth="0.6" />
          <text x="204" y="334" fill="rgba(255,255,255,0.32)" fontSize="6.5" fontFamily="monospace" letterSpacing="1">
            HIT
          </text>
          <text x="204" y="335" fill="rgba(16,185,129,0.95)" fontSize="11" fontWeight="bold" fontFamily="monospace"
            dx="24">
            87%
          </text>
        </g>

        {/* ── 角落装饰点 ── */}
        <circle cx="20" cy="36" r="2.5" fill="rgba(14,165,233,0.5)" filter="url(#pra-blur2)" />
        <circle cx="280" cy="58" r="2" fill="rgba(139,92,246,0.55)" />
        <circle cx="22" cy="200" r="2" fill="rgba(16,185,129,0.5)" />
        <circle cx="280" cy="200" r="2.5" fill="rgba(56,189,248,0.55)" />

        {/* ── 顶部 shimmer 扫描线 ── */}
        <rect x="0" y="0" width="300" height="2" fill="rgba(14,165,233,0.45)" opacity="0.55">
          <animateTransform attributeName="transform" type="translate"
            from="0 -2" to="0 402" dur="4.8s" repeatCount="indefinite" />
        </rect>
      </svg>
    </div>
  );
}
