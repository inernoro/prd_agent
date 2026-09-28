import { BAR, BEAT, FILM_DURATION, sceneStart, seeded } from './filmTimeline';

/**
 * 片花配乐：没有一个音频文件，全部由 Web Audio 现场合成。
 *
 * 为什么不放一段 mp3：
 *   1. 画面能拖进度条，音乐得跟着跳到同一拍——文件做得到，但「切镜踩在鼓点上」
 *      这件事就只能靠人工对轨，改一幕的长度就得重新混一遍；这里乐谱和画面读的是
 *      同一张时间轴（`filmTimeline.ts`），改一幕的小节数，鼓点自动跟过去。
 *   2. 版权干净：每一个音符都是这份代码写出来的。
 *   3. 同一份乐谱既能在浏览器里实时播，也能喂给 OfflineAudioContext 逐样本渲染，
 *      导出 MP4 时的音轨与页面上听到的是同一段声音。
 *
 * 结构：D 小调，i - VI - III - VII（Dm - Bb - F - C），120 BPM。
 * 引子只有铺底与琶音 → 视觉创作进半拍鼓 → 中段四踩 → 模型池那一幕上扬、
 * 最后两拍抽空 → CDS 一拍落地（整片最响的一下）→ 快切每拍一击 → 收口留长混响。
 */

export type Instrument =
  | 'kick'
  | 'clap'
  | 'hat'
  | 'openhat'
  | 'bass'
  | 'pad'
  | 'arp'
  | 'lead'
  | 'bell'
  | 'riser'
  | 'impact'
  | 'plop'
  | 'tick'
  | 'blip';

export interface ScoreEvent {
  t: number;
  /** 持续时长（打击乐为 0，由音色自己的包络决定） */
  dur: number;
  inst: Instrument;
  midi: number;
  vel: number;
}

/** 持续型音色：从中途切进去时仍要响（拖进度条落在一个长音中间）。 */
const SUSTAINED: ReadonlySet<Instrument> = new Set(['pad', 'lead', 'bass', 'riser']);

interface Chord {
  root: number;
  pad: [number, number, number, number];
}

const DM: Chord = { root: 38, pad: [50, 57, 62, 65] };
const BB: Chord = { root: 34, pad: [46, 53, 58, 62] };
const F: Chord = { root: 41, pad: [48, 53, 57, 60] };
const C: Chord = { root: 36, pad: [48, 55, 60, 64] };
const LOOP: Chord[] = [DM, BB, F, C];

/** 收口四小节不走循环：落回主和弦结束。 */
const FINALE_CHORDS: Chord[] = [DM, BB, C, DM];

const ARP_ORDER = [0, 2, 1, 3, 2, 1, 3, 2, 0, 2, 1, 3, 2, 3, 1, 2];

/** CDS 那一幕的主旋律：每小节 8 个八分音符位，[位置, 音高, 占几个八分] */
const LEAD_MOTIF: Array<Array<[number, number, number]>> = [
  [[0, 69, 2], [2, 72, 1], [3, 74, 3], [6, 72, 1], [7, 74, 1]],
  [[0, 77, 2], [2, 76, 1], [3, 74, 3], [6, 72, 2]],
  [[0, 72, 2], [2, 69, 1], [3, 72, 3], [6, 74, 1], [7, 76, 1]],
  [[0, 74, 4], [4, 72, 2], [6, 76, 2]],
];

/** 画面上「有东西落定」的时刻与乐谱对齐：这些时间点由画面那一侧引用，不许各写各的。 */
export const SCORE_CUES = {
  /** 墨滴触水 */
  splash: 1.15,
  /** 视觉创作：发送键按下（第 6 小节强拍） */
  sendPress: sceneStart('visual') + BAR * 2,
  /** 四张图依次显影 */
  tilesDevelop: [0, 1, 2, 3].map((i) => sceneStart('visual') + BAR * 2 + BEAT * (1 + i)),
  /** 模型池：首选模型被限流 */
  failover: sceneStart('models') + BEAT * 3,
  /** CDS：四个阶段逐拍打勾 */
  cdsStages: [0, 1, 2, 3].map((i) => sceneStart('cds') + BAR + BEAT * 2 * i),
  cdsReady: sceneStart('cds') + BAR * 3,
} as const;

function chordAtBar(bar: number): Chord {
  const finaleBar = Math.round(sceneStart('finale') / BAR);
  if (bar >= finaleBar) return FINALE_CHORDS[Math.min(bar - finaleBar, FINALE_CHORDS.length - 1)];
  return LOOP[bar % 4];
}

/**
 * 生成整份乐谱。纯函数、无随机（人声化的力度抖动也走固定种子），
 * 同一版代码永远产出同一份事件表——测试会断言这一点。
 */
export function buildScore(): ScoreEvent[] {
  const ev: ScoreEvent[] = [];
  const add = (t: number, inst: Instrument, midi = 0, vel = 1, dur = 0) => {
    if (t < 0 || t >= FILM_DURATION) return;
    ev.push({ t: round(t), dur: round(dur), inst, midi, vel: round(vel) });
  };
  const humanize = seeded(20260928);

  const barOf = (id: Parameters<typeof sceneStart>[0]) => Math.round(sceneStart(id) / BAR);
  const VISUAL = barOf('visual');
  const WRITING = barOf('writing');
  const CDS = barOf('cds');
  const MONTAGE = barOf('montage');
  const FINALE = barOf('finale');
  const TOTAL = Math.round(FILM_DURATION / BAR);

  for (let bar = 0; bar < TOTAL; bar += 1) {
    const t0 = bar * BAR;
    const chord = chordAtBar(bar);
    const inFinale = bar >= FINALE;
    const inMontage = bar >= MONTAGE && bar < FINALE;

    // ── 铺底：整片都在，只是开合不同 ──
    if (!inMontage) {
      const padVel = bar < VISUAL ? 0.32 + bar * 0.05 : inFinale ? 0.55 : 0.4;
      const padDur = inFinale && bar === TOTAL - 1 ? BAR * 1.1 : BAR;
      for (const n of chord.pad) add(t0, 'pad', n, padVel, padDur);
    }

    // ── 琶音：引子第 2 小节进来，收口撤掉 ──
    if (bar >= 2 && !inFinale && !inMontage) {
      const vel = bar < VISUAL ? 0.12 + (bar - 2) * 0.06 : 0.24;
      for (let step = 0; step < 16; step += 1) {
        const idx = ARP_ORDER[step];
        const note = chord.pad[idx] + 12 + (step === 12 ? 12 : 0);
        add(t0 + step * (BEAT / 4), 'arp', note, vel * (0.85 + humanize() * 0.3));
      }
    }

    // ── 视觉创作：半拍鼓（1、3 拍踩），低音八分脉冲 ──
    if (bar >= VISUAL && bar < WRITING) {
      add(t0, 'kick', 0, 0.9);
      add(t0 + BEAT * 2, 'kick', 0, 0.8);
      if (bar >= VISUAL + 2) add(t0 + BEAT * 2, 'clap', 0, 0.5);
      for (let i = 0; i < 8; i += 1) {
        if (i % 2 === 1) add(t0 + i * (BEAT / 2), 'hat', 0, 0.22 + humanize() * 0.08);
        add(t0 + i * (BEAT / 2), 'bass', chord.root + (i % 4 === 3 ? 12 : 0), 0.5, BEAT / 2 * 0.9);
      }
    }

    // ── 中段 + CDS：四踩、2/4 拍拍手、十六分踩镲 ──
    const grooveBar = bar >= WRITING && bar < MONTAGE;
    if (grooveBar) {
      const isBreak = bar === CDS - 1; // CDS 落地前一小节：后两拍抽空
      for (let beat = 0; beat < 4; beat += 1) {
        if (isBreak && beat >= 2) continue;
        add(t0 + beat * BEAT, 'kick', 0, beat === 0 ? 1 : 0.88);
        if (beat % 2 === 1) add(t0 + beat * BEAT, 'clap', 0, 0.62);
        add(t0 + beat * BEAT + BEAT / 2, 'openhat', 0, 0.2);
        for (let s = 0; s < 4; s += 1) {
          if (s === 2) continue;
          add(t0 + beat * BEAT + s * (BEAT / 4), 'hat', 0, (s === 0 ? 0.2 : 0.12) + humanize() * 0.06);
        }
      }
      for (let i = 0; i < 8; i += 1) {
        if (isBreak && i >= 4) continue;
        const oct = i % 2 === 1 ? 12 : 0;
        add(t0 + i * (BEAT / 2), 'bass', chord.root + oct, 0.62, BEAT / 2 * 0.85);
      }
      if (isBreak) {
        // 拍手滚奏，越来越密、越来越响，把人推到落地那一拍
        for (let i = 0; i < 8; i += 1) add(t0 + BEAT * 2 + i * (BEAT / 4), 'clap', 0, 0.2 + i * 0.07);
      }
    }

    // ── CDS：主旋律 ──
    if (bar >= CDS && bar < MONTAGE) {
      for (const [pos, midi, len] of LEAD_MOTIF[(bar - CDS) % LEAD_MOTIF.length]) {
        add(t0 + pos * (BEAT / 2), 'lead', midi, 0.3, len * (BEAT / 2) * 0.92);
      }
    }

    // ── 快切：每拍一击，和弦短刺 ──
    if (inMontage) {
      const stabChords = bar === MONTAGE ? [DM, DM, BB, BB] : [F, F, C, C];
      for (let beat = 0; beat < 4; beat += 1) {
        const at = t0 + beat * BEAT;
        const last = bar === FINALE - 1 && beat === 3;
        if (last) continue; // 收口前最后一拍留白
        add(at, 'kick', 0, 1);
        add(at, 'clap', 0, 0.55);
        add(at, 'bass', stabChords[beat].root, 0.7, BEAT * 0.6);
        for (const n of stabChords[beat].pad) add(at, 'pad', n + 12, 0.34, BEAT * 0.45);
        add(at + BEAT / 2, 'hat', 0, 0.26);
      }
    }

    // ── 收口：心跳式的弱踩 ──
    if (inFinale && bar < TOTAL - 1) add(t0, 'kick', 0, 0.45);
  }

  // ── 引子：墨滴入水 ──
  add(SCORE_CUES.splash, 'plop', 0, 0.8);
  add(SCORE_CUES.splash, 'impact', 0, 0.25);

  // ── 视觉创作：按下发送 + 四张图显影 ──
  add(SCORE_CUES.sendPress, 'tick', 0, 0.8);
  SCORE_CUES.tilesDevelop.forEach((at, i) => add(at, 'bell', [74, 77, 81, 86][i], 0.3));

  // ── 模型池：限流时一声下坠的电子音，然后一路上扬到 CDS ──
  add(SCORE_CUES.failover, 'blip', 0, 0.55);
  add(sceneStart('models'), 'riser', 0, 0.5, BAR * 2);

  // ── CDS：落地、逐拍打勾、上线的钟声 ──
  add(sceneStart('cds'), 'impact', 0, 1);
  SCORE_CUES.cdsStages.forEach((at, i) => add(at, 'bell', [81, 84, 86, 89][i], 0.22));
  [86, 89, 93].forEach((n, i) => add(SCORE_CUES.cdsReady + i * 0.09, 'bell', n, 0.3));

  // ── 快切末尾的短上扬，收口一声大落地 ──
  add(sceneStart('finale') - BEAT, 'riser', 0, 0.55, BEAT);
  add(sceneStart('finale'), 'impact', 0, 1);
  const f0 = sceneStart('finale');
  const bells: Array<[number, number, number]> = [
    [0.0, 74, 0.34], [0.09, 81, 0.3], [0.18, 86, 0.28],
    [BEAT * 2, 81, 0.28], [BEAT * 3, 77, 0.26],
    [BAR, 74, 0.3], [BAR + BEAT, 77, 0.26], [BAR + BEAT * 2, 81, 0.3],
    [BAR * 2, 84, 0.26], [BAR * 2 + BEAT, 81, 0.24],
    [BAR * 3, 86, 0.3], [BAR * 3 + 0.12, 81, 0.2], [BAR * 3 + 0.24, 74, 0.18],
  ];
  for (const [dt, midi, vel] of bells) add(f0 + dt, 'bell', midi, vel);

  return ev.sort((a, b) => a.t - b.t || a.inst.localeCompare(b.inst) || a.midi - b.midi);
}

function round(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function hz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// ═══════════════════════════ 合成器 ═══════════════════════════

/** 混音台：干声 / 混响 / 延迟三条总线汇到总线压缩器。 */
export interface FilmMixer {
  ctx: BaseAudioContext;
  master: GainNode;
  dry: GainNode;
  reverb: GainNode;
  delay: GainNode;
  noise: AudioBuffer;
}

export function buildMixer(ctx: BaseAudioContext, destination: AudioNode): FilmMixer {
  const master = ctx.createGain();
  master.gain.value = 0.82;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.knee.value = 10;
  comp.ratio.value = 3.5;
  comp.attack.value = 0.004;
  comp.release.value = 0.22;
  master.connect(comp);
  comp.connect(destination);

  const dry = ctx.createGain();
  dry.connect(master);

  const reverb = ctx.createGain();
  const convolver = ctx.createConvolver();
  convolver.buffer = impulseResponse(ctx, 3.2);
  const reverbReturn = ctx.createGain();
  reverbReturn.gain.value = 0.55;
  reverb.connect(convolver);
  convolver.connect(reverbReturn);
  reverbReturn.connect(master);

  // 附点八分延迟（0.375s），琶音与主旋律的空间感主要来自它
  const delay = ctx.createGain();
  const delayNode = ctx.createDelay(1);
  delayNode.delayTime.value = BEAT * 0.75;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.36;
  const delayTone = ctx.createBiquadFilter();
  delayTone.type = 'lowpass';
  delayTone.frequency.value = 2600;
  const delayReturn = ctx.createGain();
  delayReturn.gain.value = 0.34;
  delay.connect(delayNode);
  delayNode.connect(delayTone);
  delayTone.connect(feedback);
  feedback.connect(delayNode);
  delayTone.connect(delayReturn);
  delayReturn.connect(master);

  return { ctx, master, dry, reverb, delay, noise: noiseBuffer(ctx) };
}

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  const rand = seeded(7);
  for (let i = 0; i < len; i += 1) data[i] = rand() * 2 - 1;
  return buf;
}

/** 合成一段混响脉冲响应：双声道指数衰减噪声，早期反射稍密。 */
function impulseResponse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch += 1) {
    const data = buf.getChannelData(ch);
    const rand = seeded(101 + ch);
    for (let i = 0; i < len; i += 1) {
      const x = i / len;
      data[i] = (rand() * 2 - 1) * Math.pow(1 - x, 3.2) * (i < ctx.sampleRate * 0.01 ? 0.4 : 1);
    }
  }
  return buf;
}

/**
 * 一次播放的输出口。暂停 / 拖动时整段掐掉（停掉它排下的所有声源、把输出口推到 0），
 * 不影响混音台上正在衰减的混响尾巴。
 */
export interface VoiceBus {
  mixer: FilmMixer;
  out: GainNode;
  rev: GainNode;
  dly: GainNode;
  sources: Set<AudioScheduledSourceNode>;
}

export function openBus(mixer: FilmMixer): VoiceBus {
  const { ctx } = mixer;
  const out = ctx.createGain();
  const rev = ctx.createGain();
  const dly = ctx.createGain();
  out.connect(mixer.dry);
  rev.connect(mixer.reverb);
  dly.connect(mixer.delay);
  return { mixer, out, rev, dly, sources: new Set() };
}

export function closeBus(bus: VoiceBus, at: number): void {
  for (const g of [bus.out, bus.rev, bus.dly]) {
    g.gain.cancelScheduledValues(at);
    g.gain.setValueAtTime(g.gain.value, at);
    g.gain.linearRampToValueAtTime(0, at + 0.05);
  }
  for (const src of bus.sources) {
    try {
      src.stop(at + 0.06);
    } catch {
      /* 已经停过 */
    }
  }
  bus.sources.clear();
}

/** 把一个声源登记到输出口，结束时自动注销（否则长片播完 Set 里会堆几千个死节点）。 */
function track(bus: VoiceBus, src: AudioScheduledSourceNode, start: number, stop: number): void {
  bus.sources.add(src);
  src.onended = () => bus.sources.delete(src);
  src.start(start);
  src.stop(stop);
}

function sendTo(bus: VoiceBus, node: AudioNode, dry: number, rev: number, dly: number): void {
  const { ctx } = bus.mixer;
  const pairs: Array<[number, GainNode]> = [[dry, bus.out], [rev, bus.rev], [dly, bus.dly]];
  for (const [amount, target] of pairs) {
    if (amount <= 0) continue;
    const g = ctx.createGain();
    g.gain.value = amount;
    node.connect(g);
    g.connect(target);
  }
}

function noiseSource(bus: VoiceBus): AudioBufferSourceNode {
  const src = bus.mixer.ctx.createBufferSource();
  src.buffer = bus.mixer.noise;
  src.loop = true;
  return src;
}

/**
 * 在 `at` 时刻奏响一个事件。`skip` 是这个音已经过去了多久（拖动进度条落在长音中间时 > 0）：
 * 持续型音色从中途切入，打击乐直接不响。
 */
export function playEvent(bus: VoiceBus, e: ScoreEvent, at: number, skip = 0): void {
  if (skip > 0 && !SUSTAINED.has(e.inst)) return;
  const { ctx } = bus.mixer;
  const v = e.vel;

  switch (e.inst) {
    case 'kick': {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.frequency.setValueAtTime(165, at);
      osc.frequency.exponentialRampToValueAtTime(44, at + 0.13);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(v * 1.1, at + 0.004);
      g.gain.exponentialRampToValueAtTime(0.001, at + 0.42);
      osc.connect(g);
      sendTo(bus, g, 1, 0, 0);
      track(bus, osc, at, at + 0.45);
      const click = noiseSource(bus);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 3000;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(v * 0.25, at);
      cg.gain.exponentialRampToValueAtTime(0.001, at + 0.012);
      click.connect(hp);
      hp.connect(cg);
      sendTo(bus, cg, 1, 0, 0);
      track(bus, click, at, at + 0.02);
      break;
    }
    case 'clap': {
      const src = noiseSource(bus);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1500;
      bp.Q.value = 0.9;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      for (let i = 0; i < 3; i += 1) {
        g.gain.setValueAtTime(v * 0.8, at + i * 0.011);
        g.gain.exponentialRampToValueAtTime(v * 0.15, at + i * 0.011 + 0.009);
      }
      g.gain.setValueAtTime(v * 0.7, at + 0.034);
      g.gain.exponentialRampToValueAtTime(0.001, at + 0.24);
      src.connect(bp);
      bp.connect(g);
      sendTo(bus, g, 0.9, 0.35, 0);
      track(bus, src, at, at + 0.26);
      break;
    }
    case 'hat':
    case 'openhat': {
      const open = e.inst === 'openhat';
      const src = noiseSource(bus);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = open ? 6500 : 8000;
      const g = ctx.createGain();
      const len = open ? 0.26 : 0.045;
      g.gain.setValueAtTime(v * 0.55, at);
      g.gain.exponentialRampToValueAtTime(0.001, at + len);
      src.connect(hp);
      hp.connect(g);
      sendTo(bus, g, 0.8, open ? 0.12 : 0, 0);
      track(bus, src, at, at + len + 0.02);
      break;
    }
    case 'bass': {
      const dur = Math.max(0.05, e.dur - skip);
      const f = hz(e.midi);
      const saw = ctx.createOscillator();
      saw.type = 'sawtooth';
      saw.frequency.value = f;
      const sub = ctx.createOscillator();
      sub.frequency.value = f;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 5;
      lp.frequency.setValueAtTime(skip > 0 ? 300 : 1100, at);
      lp.frequency.exponentialRampToValueAtTime(280, at + 0.16);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(v * 0.42, at + 0.006);
      g.gain.setValueAtTime(v * 0.36, at + dur);
      g.gain.exponentialRampToValueAtTime(0.001, at + dur + 0.07);
      const sg = ctx.createGain();
      sg.gain.value = 0.9;
      saw.connect(lp);
      sub.connect(sg);
      lp.connect(g);
      sg.connect(g);
      sendTo(bus, g, 1, 0, 0);
      track(bus, saw, at, at + dur + 0.1);
      track(bus, sub, at, at + dur + 0.1);
      break;
    }
    case 'pad': {
      const dur = Math.max(0.1, e.dur - skip);
      const attack = skip > 0 ? 0.15 : Math.min(0.55, dur * 0.4);
      const g = ctx.createGain();
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1500;
      lp.Q.value = 0.6;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(v * 0.1, at + attack);
      g.gain.setValueAtTime(v * 0.1, at + dur);
      g.gain.linearRampToValueAtTime(0.0001, at + dur + 1.2);
      lp.connect(g);
      for (const detune of [-10, 0, 10]) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = hz(e.midi);
        osc.detune.value = detune;
        osc.connect(lp);
        track(bus, osc, at, at + dur + 1.25);
      }
      sendTo(bus, g, 0.75, 0.55, 0);
      break;
    }
    case 'arp': {
      const f = hz(e.midi);
      const tri = ctx.createOscillator();
      tri.type = 'triangle';
      tri.frequency.value = f;
      const sq = ctx.createOscillator();
      sq.type = 'square';
      sq.frequency.value = f;
      const sqg = ctx.createGain();
      sqg.gain.value = 0.22;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(4200, at);
      lp.frequency.exponentialRampToValueAtTime(900, at + 0.2);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(v * 0.5, at + 0.004);
      g.gain.exponentialRampToValueAtTime(0.001, at + 0.24);
      tri.connect(lp);
      sq.connect(sqg);
      sqg.connect(lp);
      lp.connect(g);
      sendTo(bus, g, 0.7, 0.22, 0.45);
      track(bus, tri, at, at + 0.26);
      track(bus, sq, at, at + 0.26);
      break;
    }
    case 'lead': {
      const dur = Math.max(0.05, e.dur - skip);
      const f = hz(e.midi);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2600;
      lp.Q.value = 1.2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(v * 0.2, at + 0.02);
      g.gain.setValueAtTime(v * 0.17, at + dur);
      g.gain.exponentialRampToValueAtTime(0.001, at + dur + 0.18);
      const vib = ctx.createOscillator();
      vib.frequency.value = 5.2;
      const vibDepth = ctx.createGain();
      vibDepth.gain.value = 9;
      vib.connect(vibDepth);
      for (const detune of [-7, 7]) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = f;
        osc.detune.value = detune;
        vibDepth.connect(osc.detune);
        osc.connect(lp);
        track(bus, osc, at, at + dur + 0.2);
      }
      track(bus, vib, at, at + dur + 0.2);
      lp.connect(g);
      sendTo(bus, g, 0.75, 0.3, 0.35);
      break;
    }
    case 'bell': {
      const f = hz(e.midi);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(v * 0.45, at + 0.003);
      g.gain.exponentialRampToValueAtTime(0.001, at + 1.8);
      for (const [ratio, amp] of [[1, 1], [2.76, 0.35], [5.4, 0.12]] as const) {
        const osc = ctx.createOscillator();
        osc.frequency.value = f * ratio;
        const og = ctx.createGain();
        og.gain.value = amp;
        osc.connect(og);
        og.connect(g);
        track(bus, osc, at, at + 1.85);
      }
      sendTo(bus, g, 0.6, 0.6, 0.25);
      break;
    }
    case 'riser': {
      const p0 = e.dur > 0 ? Math.min(1, skip / e.dur) : 0;
      const remain = Math.max(0.05, e.dur - skip);
      const end = at + remain;
      const src = noiseSource(bus);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 2.5;
      bp.frequency.setValueAtTime(300 * Math.pow(20, p0), at);
      bp.frequency.exponentialRampToValueAtTime(6000, end);
      const g = ctx.createGain();
      g.gain.setValueAtTime(Math.max(0.0001, v * 0.5 * p0 * p0), at);
      g.gain.linearRampToValueAtTime(v * 0.5, end);
      g.gain.linearRampToValueAtTime(0.0001, end + 0.04);
      src.connect(bp);
      bp.connect(g);
      sendTo(bus, g, 0.7, 0.4, 0);
      track(bus, src, at, end + 0.06);
      break;
    }
    case 'impact': {
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(62, at);
      osc.frequency.exponentialRampToValueAtTime(28, at + 1.4);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(v * 0.95, at + 0.006);
      g.gain.exponentialRampToValueAtTime(0.001, at + 1.9);
      osc.connect(g);
      sendTo(bus, g, 1, 0.3, 0);
      track(bus, osc, at, at + 2);
      const src = noiseSource(bus);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(5000, at);
      lp.frequency.exponentialRampToValueAtTime(300, at + 0.7);
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(v * 0.45, at);
      ng.gain.exponentialRampToValueAtTime(0.001, at + 0.9);
      src.connect(lp);
      lp.connect(ng);
      sendTo(bus, ng, 0.7, 0.9, 0);
      track(bus, src, at, at + 1);
      break;
    }
    case 'plop': {
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(1100, at);
      osc.frequency.exponentialRampToValueAtTime(190, at + 0.09);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(v * 0.5, at + 0.003);
      g.gain.exponentialRampToValueAtTime(0.001, at + 0.2);
      osc.connect(g);
      sendTo(bus, g, 0.7, 0.7, 0.3);
      track(bus, osc, at, at + 0.22);
      break;
    }
    case 'tick': {
      const osc = ctx.createOscillator();
      osc.frequency.value = 2400;
      const g = ctx.createGain();
      g.gain.setValueAtTime(v * 0.3, at);
      g.gain.exponentialRampToValueAtTime(0.001, at + 0.035);
      osc.connect(g);
      sendTo(bus, g, 0.8, 0.2, 0.2);
      track(bus, osc, at, at + 0.04);
      break;
    }
    case 'blip': {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(880, at);
      osc.frequency.exponentialRampToValueAtTime(140, at + 0.22);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1800;
      const g = ctx.createGain();
      g.gain.setValueAtTime(v * 0.28, at);
      g.gain.exponentialRampToValueAtTime(0.001, at + 0.26);
      osc.connect(lp);
      lp.connect(g);
      sendTo(bus, g, 0.8, 0.3, 0.3);
      track(bus, osc, at, at + 0.28);
      break;
    }
  }
}

// ═══════════════════════════ 播放 ═══════════════════════════

const SCORE = buildScore();

/**
 * 实时播放：标准的「前瞻调度」——每 40ms 醒一次，把接下来 300ms 内的音符排进
 * 音频线程。时钟以 AudioContext 为准，画面反过来读它，所以音画永远同步。
 */
export class FilmScorePlayer {
  private readonly mixer: FilmMixer;
  private bus: VoiceBus | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startAt = 0;
  private cursor = 0;

  constructor(readonly ctx: AudioContext) {
    this.mixer = buildMixer(ctx, ctx.destination);
  }

  /** 片内时间（秒）。 */
  get time(): number {
    return this.ctx.currentTime - this.startAt;
  }

  setMuted(muted: boolean): void {
    const g = this.mixer.master.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(muted ? 0 : 0.82, now + 0.08);
  }

  start(from: number): void {
    this.stop();
    this.startAt = this.ctx.currentTime + 0.06 - from;
    const bus = openBus(this.mixer);
    this.bus = bus;
    // 拖动落在长音中间：把还没结束的持续音从中途补上
    const now = this.ctx.currentTime + 0.06;
    for (const e of SCORE) {
      if (e.t >= from) break;
      if (e.t + e.dur > from) playEvent(bus, e, now, from - e.t);
    }
    this.cursor = from;
    this.pump();
    this.timer = setInterval(() => this.pump(), 40);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.bus) closeBus(this.bus, this.ctx.currentTime);
    this.bus = null;
  }

  private pump(): void {
    const bus = this.bus;
    if (!bus) return;
    const horizon = Math.min(FILM_DURATION, this.time + 0.3);
    for (const e of SCORE) {
      if (e.t < this.cursor) continue;
      if (e.t >= horizon) break;
      playEvent(bus, e, this.startAt + e.t);
    }
    this.cursor = horizon;
  }
}

/**
 * 离线渲染整段配乐（导出 MP4 用）。尾部多留 3 秒给混响收尾。
 *
 * 不能一口气把两千多个音符全挂进图里：还没开始的声源也会被音频图逐块遍历，
 * 几万个节点乘以两万个渲染块，52 秒的歌要渲染近三分钟。
 * 所以和实时播放一样「用到才挂」——每秒停一次（suspend），只把下一秒的音符接进来。
 */
export async function renderScoreOffline(sampleRate = 48000): Promise<AudioBuffer> {
  const tail = 3;
  const ctx = new OfflineAudioContext(2, Math.ceil((FILM_DURATION + tail) * sampleRate), sampleRate);
  const mixer = buildMixer(ctx, ctx.destination);
  const bus = openBus(mixer);
  const WINDOW = 1;
  const scheduleWindow = (from: number) => {
    for (const e of SCORE) {
      if (e.t < from) continue;
      if (e.t >= from + WINDOW) break;
      playEvent(bus, e, e.t);
    }
  };
  // 第一秒在开渲前挂好；之后每一段在上一段结束前 0.1 秒挂进来，保证挂载时刻早于音符时刻
  scheduleWindow(0);
  for (let w = WINDOW; w < FILM_DURATION; w += WINDOW) {
    void ctx.suspend(w - 0.1).then(() => {
      scheduleWindow(w);
      void ctx.resume();
    });
  }
  return ctx.startRendering();
}
