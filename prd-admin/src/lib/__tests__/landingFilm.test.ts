import { describe, expect, it } from 'vitest';

import { translations } from '@/pages/home/i18n/landing';
import { SCORE_CUES, buildScore } from '@/pages/home/film/filmScore';
import { BAR, BEAT, FILM_DURATION, FILM_SCENES, FINALE_CTA_AT, POSTER_TIME, TOTAL_BARS, sceneAt, sceneStart } from '@/pages/home/film/filmTimeline';

/**
 * 首页片花的契约守卫。
 *
 * 片花最容易坏、又最不容易被看出来坏的，是「音画不同步」：某一幕加了一小节，
 * 画面跟着挪了，鼓点没挪；或者乐谱里改了发送键那一下的时刻，画面上的手还按在老地方。
 * 页面照常渲染、照常出声，只是切镜不再踩在拍子上——只有坐下来完整看一遍的人才会发现。
 * 所以这里不测「长得对不对」，只测两张表是不是同一张表。
 */

const EPS = 1e-6;
const at = (t: number, inst: string) => buildScore().filter((e) => Math.abs(e.t - t) < 1e-3 && e.inst === inst);

describe('片花时间轴', () => {
  it('各幕首尾相接、落在小节线上，总长等于小节数乘小节长', () => {
    expect(FILM_SCENES[0].from).toBe(0);
    for (let i = 1; i < FILM_SCENES.length; i += 1) {
      expect(FILM_SCENES[i].from).toBeCloseTo(FILM_SCENES[i - 1].to, 9);
    }
    for (const s of FILM_SCENES) {
      expect((s.from / BAR) % 1).toBeLessThan(EPS);
    }
    expect(FILM_DURATION).toBeCloseTo(TOTAL_BARS * BAR, 9);
    expect(sceneAt(FILM_DURATION - 0.01).id).toBe('finale');
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
      expect(((e.t / BEAT) * 2) % 1, `kick @ ${e.t}`).toBeLessThan(1e-3);
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
    expect((SCORE_CUES.sendPress / BAR) % 1).toBeLessThan(EPS);
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

describe('片花文案与画面的数量对得上（中英两份）', () => {
  for (const lang of ['zh', 'en'] as const) {
    const film = translations[lang].film;
    it(`${lang}：六幕字幕、八拍快切、四个部署阶段、五个工作流节点`, () => {
      expect(film.chapters).toHaveLength(6);
      // 一帧只讲一件事：每一幕都得有自己的大字标题，缺了那一幕就只剩一个没头没尾的界面
      for (const c of film.chapters) expect(c.headline.trim().length, c.title).toBeGreaterThan(0);
      expect(film.models.statLabel.trim().length).toBeGreaterThan(0);
      const montage = FILM_SCENES.find((s) => s.id === 'montage');
      expect(film.montage).toHaveLength((montage?.bars ?? 0) * 4);
      expect(film.cds.stages).toHaveLength(SCORE_CUES.cdsStages.length);
      expect(film.workflow.nodes).toHaveLength(5);
      expect(film.writing.nodes.length).toBeGreaterThanOrEqual(7);
      expect(film.models.rows.length).toBeGreaterThanOrEqual(2);
    });
  }
});
