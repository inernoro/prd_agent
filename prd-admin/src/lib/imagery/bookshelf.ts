import type { ImageryModule } from './types';

/**
 * 公共藏书阁的卷面图 —— 七卷，每卷一张。
 *
 * ## 为什么是七张，不是每个位置一张
 *
 * 这张图要同时服务四个位置：卷页顶部通栏、手机落地页七卷行的 56×44 缩略、
 * 落地页处境卡的卡顶图、桌面卷卡。一卷一张、四处复用，而不是每个位置各生一张 ——
 * 处境卡有 8 条、分属 6 个卷，各生一张的话「同一卷的两张图不像一次创作出来的」
 * 是迟早的事，而这件事在同一屏里最刺眼。
 *
 * ## 画面怎么定的
 *
 * 每一卷取一个**能一眼认出的实物意象**，对应那一卷讲的事：开机是刚亮的灯与空白本子、
 * 立规矩是量具、懂业务是剖开的机器、会设计是榫卯、能审人是检具与校样、驭 AI 是仪表盘、
 * 上台面是讲台。不用抽象的「科技感」——抽象图在 56px 缩略里等于一块糊掉的色块。
 *
 * 拍法走「书脊静物」：近距离台面静物、侧光、实物质感。风景照会把「这是一卷书」
 * 这件事冲掉。
 *
 * ## 没配图会怎样
 *
 * 回落到原来的卷序汉字方块，页面照常成立（`ImagerySlot` 的硬约定）。
 * 卷面图是替换，不是前提。
 *
 * ## 书封
 *
 * 51 本书的封面**不在这里**，也不打算做：那是有版权的实物封面，让模型编一张出来
 * 既不像又不合适。书目行保持文字排版。
 */
export const BOOKSHELF_IMAGERY: ImageryModule = {
  id: 'bookshelf',
  label: '公共藏书阁',
  route: '/bookshelf',
  reach: 'internal',
  defaultStyle: 'bookspine',
  hint: '七卷各一张卷面图，同一张同时用在卷页通栏、手机七卷行、处境卡顶图和桌面卷卡。',
  slots: [
    {
      id: 'vol-boot',
      slot: 'bookshelf.vol.boot',
      label: '卷一 · 开机',
      where: '卷页通栏 / 七卷行第 1 条 / 处境卡顶图 / 桌面卷卡',
      size: '1536x1024',
      subject:
        'Subject: a workbench at the very start of the day. A single desk lamp has just been switched on and throws ' +
        'a warm pool of light across bare wood; at the edge of that pool sit a closed pocket notebook with completely ' +
        'blank covers, a mechanical pencil, and a mug. Everything beyond the lamp falls away into cool shadow. ' +
        'The surfaces are clean and nothing has been started yet.',
    },
    {
      id: 'vol-rules',
      slot: 'bookshelf.vol.rules',
      label: '卷二 · 立规矩',
      where: '卷页通栏 / 七卷行第 2 条 / 处境卡顶图 / 桌面卷卡',
      size: '1536x1024',
      subject:
        'Subject: precision measuring tools laid out in a deliberate row on a workbench — a steel try square, ' +
        'a vernier caliper, a marking gauge, a folding rule half opened. The metal is worn bright at the edges ' +
        'from use and tarnished elsewhere. Raking light catches the machined edges and the fine scale divisions ' +
        'without any numbers being legible. Ordered, deliberate, nothing out of line.',
    },
    {
      id: 'vol-domain',
      slot: 'bookshelf.vol.domain',
      label: '卷三 · 懂业务',
      where: '卷页通栏 / 七卷行第 3 条 / 处境卡顶图 / 桌面卷卡',
      size: '1536x1024',
      subject:
        'Subject: a small machine opened up on a bench with its cover removed, so the whole mechanism is visible ' +
        'at once — brass gears, a linkage arm, a belt drive, a spring. Warm brass against cold steel, fine dust ' +
        'settled on the surfaces. The point is that nothing is hidden: you can follow how one part drives the next ' +
        'all the way through the frame.',
    },
    {
      id: 'vol-design',
      slot: 'bookshelf.vol.design',
      label: '卷四 · 会设计',
      where: '卷页通栏 / 七卷行第 4 条 / 处境卡顶图 / 桌面卷卡',
      size: '1536x1024',
      subject:
        'Subject: a hand-cut mortise and tenon joint resting on a workbench, the two halves pulled slightly apart ' +
        'so the interlocking shoulders are visible. Dry oak with a clear open grain, crisp chisel facets on the ' +
        'cut faces, a few shavings around it. Side light rakes across the joint so the fit — tight, square, ' +
        'intentional — is the subject of the photograph.',
    },
    {
      id: 'vol-review',
      slot: 'bookshelf.vol.review',
      label: '卷五 · 能审人',
      where: '卷页通栏 / 七卷行第 5 条 / 处境卡顶图 / 桌面卷卡',
      size: '1536x1024',
      subject:
        'Subject: an inspection station on a workbench — a magnifying loupe on a stand, a dial indicator gauge, ' +
        'and a stack of blank uncut proof sheets with a red pencil resting across them. The paper is entirely ' +
        'blank, no printing and no writing on it. Cool light from one side, deep shadow behind. ' +
        'Everything in frame exists to check something else.',
    },
    {
      id: 'vol-ai',
      slot: 'bookshelf.vol.ai',
      label: '卷六 · 驭 AI',
      where: '卷页通栏 / 七卷行第 6 条 / 处境卡顶图 / 桌面卷卡',
      size: '1536x1024',
      subject:
        'Subject: the control panel of an old precision instrument seen at a shallow angle — brushed metal face, ' +
        'a row of knurled calibration knobs, two analogue dial gauges with plain unmarked faces and thin needles, ' +
        'a single toggle switch. Warm tungsten light from the left, the right half of the panel in shadow. ' +
        'It reads as a machine that a person is expected to understand and adjust, not a black box.',
    },
    {
      id: 'vol-stage',
      slot: 'bookshelf.vol.stage',
      label: '卷七 · 上台面',
      where: '卷页通栏 / 七卷行第 7 条 / 处境卡顶图 / 桌面卷卡',
      size: '1536x1024',
      subject:
        'Subject: a wooden lectern photographed from just behind and to the side, a neat stack of blank unprinted ' +
        'pages resting on its slope, and beyond it an empty room falling off into soft darkness. ' +
        'One warm light falls on the lectern top; the room past it is unlit and out of focus. ' +
        'The moment before someone speaks.',
    },
  ],
};

/**
 * 卷 id → 这一卷的图位 slot 字符串。
 *
 * 图位的 `id` 刻意就用 catalog 里那个卷 id（`vol-boot` 等），不另起一套编号：
 * 两套 id 意味着要维护一张对照表，而对照表一定会在加卷的那天漏掉一行。
 * 守卫直接断言「图位 id 集合 === VOLUMES id 集合」，多一个少一个都红。
 */
export function bookshelfVolumeSlot(volumeId: string): string | undefined {
  return BOOKSHELF_IMAGERY.slots.find((s) => s.id === volumeId)?.slot;
}
