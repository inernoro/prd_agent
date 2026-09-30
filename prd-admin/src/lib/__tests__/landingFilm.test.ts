import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { translations } from '@/pages/home/i18n/landing';
import { SCORE_CUES, buildScore } from '@/pages/home/film/filmScore';
import scoreEdit from '@/pages/home/film/scoreEdit.json';
import { FILM_TRACK_URL } from '@/pages/home/film/filmTrack';
import filmDocs from '@/pages/home/film/filmDocs.json';
import { buildDocGalaxy } from '@/lib/docGalaxy/buildDocGalaxy';
import { BAR, BEAT, BPM, FILM_DURATION, FILM_SCENES, FINALE_CTA_AT, POSTER_TIME, TOTAL_BARS, sceneAt, sceneStart } from '@/pages/home/film/filmTimeline';

/**
 * 首页片花的契约守卫。
 *
 * 片花最容易坏、又最不容易被看出来坏的，是「音画不同步」：某一幕加了一小节，
 * 画面跟着挪了，鼓点没挪；或者乐谱里改了发送键那一下的时刻，画面上的手还按在老地方。
 * 页面照常渲染、照常出声，只是切镜不再踩在拍子上——只有坐下来完整看一遍的人才会发现。
 * 所以这里不测「长得对不对」，只测两张表是不是同一张表。
 */

const EPS = 1e-6;
/** x 离最近的整数有多远——拍速不是整数时，`x % 1` 在 0.9999999 这种位置会误判 */
const offGrid = (x: number) => Math.abs(x - Math.round(x));
const at = (t: number, inst: string) => buildScore().filter((e) => Math.abs(e.t - t) < 1e-3 && e.inst === inst);

describe('片花时间轴', () => {
  it('各幕首尾相接、落在小节线上，总长等于小节数乘小节长', () => {
    expect(FILM_SCENES[0].from).toBe(0);
    for (let i = 1; i < FILM_SCENES.length; i += 1) {
      expect(FILM_SCENES[i].from).toBeCloseTo(FILM_SCENES[i - 1].to, 9);
    }
    for (const s of FILM_SCENES) {
      expect(offGrid(s.from / BAR)).toBeLessThan(EPS);
    }
    expect(FILM_DURATION).toBeCloseTo(TOTAL_BARS * BAR, 9);
    expect(sceneAt(FILM_DURATION - 0.01).id).toBe('finale');
  });

  it('每个产品的第一幕之前都有它的分幕卡，功能幕都标明了属于哪个产品', () => {
    const cards = FILM_SCENES.filter((s) => s.partCard);
    expect(cards.map((s) => s.part)).toEqual([0, 1, 2]);
    for (const card of cards) {
      const idx = FILM_SCENES.indexOf(card);
      const next = FILM_SCENES[idx + 1];
      expect(next.partCard, `${card.id} 后面紧跟的应是功能幕`).toBe(false);
      expect(next.part, `${card.id} 报的产品和紧跟的那一幕不一致`).toBe(card.part);
    }
    for (const id of ['visual', 'writing', 'toolbox', 'workflow', 'models', 'cds'] as const) {
      expect(FILM_SCENES.find((s) => s.id === id)?.part, id).not.toBeUndefined();
    }
  });

  it('海报帧落在收口那一幕里，且在片内按钮出现之前（那个位置留给播放键，不许出现一颗画出来的假按钮）', () => {
    expect(sceneAt(POSTER_TIME).id).toBe('finale');
    expect(POSTER_TIME).toBeLessThan(sceneStart('finale') + FINALE_CTA_AT);
  });
});

describe('片花配乐与画面同一张表', () => {
  const score = buildScore();

  it('乐谱是确定的：两次生成逐字相同（导出的 MP4 与页面上听到的是同一段）', () => {
    expect(JSON.stringify(buildScore())).toBe(JSON.stringify(score));
  });

  it('所有音符都落在片长之内，且按时间排好序', () => {
    for (let i = 0; i < score.length; i += 1) {
      expect(score[i].t).toBeGreaterThanOrEqual(0);
      expect(score[i].t).toBeLessThan(FILM_DURATION);
      if (i > 0) expect(score[i].t).toBeGreaterThanOrEqual(score[i - 1].t);
    }
    expect(score.length).toBeGreaterThan(200);
  });

  it('开场之后的每一次切镜，那一刻都有一记底鼓或冲击声', () => {
    for (const s of FILM_SCENES.slice(1)) {
      const hits = [...at(s.from, 'kick'), ...at(s.from, 'impact')];
      expect(hits.length, `${s.id} 在 ${s.from}s 切镜，却没有鼓点`).toBeGreaterThan(0);
    }
  });

  it('底鼓全部落在拍点上（十六分音符网格之外的鼓会让切镜看着「拖」）', () => {
    for (const e of score.filter((x) => x.inst === 'kick')) {
      expect(offGrid((e.t / BEAT) * 2), `kick @ ${e.t}`).toBeLessThan(1e-3);
    }
  });

  it('画面上「落定」的时刻，乐谱里都有对应的声音', () => {
    expect(at(SCORE_CUES.sendPress, 'tick').length).toBe(1);
    for (const t of SCORE_CUES.tilesDevelop) expect(at(t, 'bell').length).toBeGreaterThan(0);
    for (const t of SCORE_CUES.cdsStages) expect(at(t, 'bell').length).toBeGreaterThan(0);
    expect(at(SCORE_CUES.failover, 'blip').length).toBe(1);
    expect(at(SCORE_CUES.splash, 'plop').length).toBe(1);
  });

  it('按发送键落在强拍上，且在视觉创作那一幕之内', () => {
    expect(offGrid(SCORE_CUES.sendPress / BAR)).toBeLessThan(EPS);
    expect(sceneAt(SCORE_CUES.sendPress).id).toBe('visual');
    expect(sceneAt(SCORE_CUES.failover).id).toBe('models');
    for (const t of SCORE_CUES.cdsStages) expect(sceneAt(t).id).toBe('cds');
  });

  it('CDS 落地前一小节后两拍抽空（留白才有落地感）', () => {
    const cds = sceneStart('cds');
    const kicks = score.filter((e) => e.inst === 'kick' && e.t >= cds - BEAT * 2 && e.t < cds);
    expect(kicks).toHaveLength(0);
  });
});

describe('成品配乐的剪辑表与画面同一张表', () => {
  const segments = scoreEdit.segments;

  it('拍速取自剪辑表（换一首歌只改那份 JSON，画面跟着走）', () => {
    expect(BPM).toBe(scoreEdit.source.bpm);
  });

  it('播放器要取的那段配乐真的在 public/ 里（剪辑脚本的输出路径与播放器地址是同一个）', () => {
    const rel = FILM_TRACK_URL.replace(/^\//, '');
    const file = path.resolve(__dirname, '../../../public', rel);
    expect(fs.existsSync(file), `缺 ${file}：跑 scripts/film/build-score.py 生成`).toBe(true);
    const src = fs.readFileSync(path.resolve(__dirname, '../../../scripts/film/build-score.py'), 'utf8');
    expect(src).toContain(`'${path.basename(rel)}'`);
  });

  it('剪出来的小节数正好等于片长，一小节不多一小节不少', () => {
    expect(segments.reduce((n, s) => n + s.bars, 0)).toBe(TOTAL_BARS);
    for (const s of segments) {
      expect(Number.isInteger(s.songBar) && s.songBar >= 0, `songBar ${s.songBar}`).toBe(true);
      expect(Number.isInteger(s.bars) && s.bars > 0, `bars ${s.bars}`).toBe(true);
    }
  });

  it('若有剪接点，必须压在一次切镜上（接缝藏在画面硬切里；现行剪法是一整段不拼接）', () => {
    const cuts = new Set(FILM_SCENES.map((s) => s.bar));
    let bar = 0;
    for (const s of segments.slice(0, -1)) {
      bar += s.bars;
      expect(cuts.has(bar), `第 ${bar} 小节有一个剪接点，但那里没有切镜`).toBe(true);
    }
  });
});

describe('片花的知识星系是真星系', () => {
  it('快照里每一篇文档都落在星图上（左上角那句「一篇不落」的依据）', () => {
    const galaxy = buildDocGalaxy(filmDocs.names.map((name) => ({ id: name, title: name })));
    expect(filmDocs.names.length).toBeGreaterThan(100);
    expect(galaxy.root.docCount).toBe(filmDocs.names.length);
  });

  it('画法走知识库星系的建树与放射布局，不许退回手画的示意图', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../pages/home/film/FilmGalaxy.tsx'), 'utf8');
    expect(src).toContain('buildDocGalaxy(');
    expect(src).toContain('layoutRadial2D(');
    expect(src).toContain("from '@/lib/docGalaxy/docTypeColors'");
  });
});

describe('片花文案与画面的数量对得上（中英两份）', () => {
  for (const lang of ['zh', 'en'] as const) {
    const film = translations[lang].film;
    it(`${lang}：六幕字幕、八拍快切、四个部署阶段、五个工作流节点`, () => {
      expect(film.chapters).toHaveLength(6);
      // 一帧只讲一件事：每一幕都得有自己的大字标题，缺了那一幕就只剩一个没头没尾的界面
      for (const c of film.chapters) expect(c.headline.trim().length, c.title).toBeGreaterThan(0);
      expect(film.models.statLabel.trim().length).toBeGreaterThan(0);
      // 分幕卡按 FilmPart 下标取文案，三张卡就得有三条
      expect(film.parts).toHaveLength(FILM_SCENES.filter((s) => s.partCard).length);
      const montage = FILM_SCENES.find((s) => s.id === 'montage');
      expect(film.montage).toHaveLength((montage?.bars ?? 0) * 4);
      expect(film.cds.stages).toHaveLength(SCORE_CUES.cdsStages.length);
      expect(film.workflow.nodes).toHaveLength(5);
      expect(film.labels.galaxyStat.trim().length).toBeGreaterThan(0);
      expect(film.models.rows.length).toBeGreaterThanOrEqual(2);
    });
  }
});

describe('片花标题的时长跟着时间轴走', () => {
  // 换成 29 小节的 Suno 原曲后片长 57 秒，标题却还写着「五十二秒 / 0:52」（Codex P2，PR #1650）。
  // 秒数只许由 FilmSection 按 FILM_DURATION 填进 {duration}，文案里不许再出现写死的数字。
  it('中英文标题都用 {duration} 占位，眉标不带时长', () => {
    for (const lang of ['zh', 'en'] as const) {
      const film = translations[lang].film;
      expect(film.title, lang).toContain('{duration}');
      expect(film.title.replace('{duration}', ''), lang).not.toMatch(/\d/);
      expect(film.eyebrow, lang).not.toMatch(/\d/);
    }
  });

  it('FilmSection 用 FILM_DURATION 填标题与眉标', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../pages/home/film/FilmSection.tsx'), 'utf8');
    expect(src).toMatch(/film\.title\.replace\('\{duration\}',\s*String\(Math\.round\(FILM_DURATION\)\)\)/);
    expect(src).toMatch(/formatClock\(FILM_DURATION\)/);
  });
});
