/**
 * 同仓多项目在界面上的两条接线，都属于「删掉不会红、只会静默退化」那一类
 * （predicate-and-wiring-discipline 形状 2），所以各钉一条源码守卫。
 *
 * 两条都是 2026-09-02 Codex 抓出来的真实缺口：
 *
 *   1. 建项目有两条路径——顶栏粘 Git URL（**主**路径）与完整表单。只在完整表单里
 *      处理 `repoAlreadyLinked`，主路径就会静默建出一个没绑仓库的项目，而用户看到的
 *      是「已创建」，之后推送永远到不了它。
 *   2. 范围对话框把建议预勾在界面上，但库里那条仍是空的。保存时若拿 `suggested`
 *      当基线，用户接受默认值点保存 → 前后相等 → 一条 PUT 都不发 → 弹窗说
 *      「没有改动」，而范围依然没划。
 *
 * 这两条都测不到「行为」——它们的失败形态是「什么都没发生」。所以退一步守源码：
 * 判据写成「这段代码必须存在」很脆，但这里守的是**两条路径必须一致**与**基线取哪个
 * 字段**，比字面量断言稳，且删掉任一条就变红。
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(process.cwd(), '../cds/web/src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

describe('建项目的每条路径都要处理「仓库已被别的项目绑走」', () => {
  const source = read('pages/ProjectListPage.tsx');

  /**
   * 判据按「这条路径会不会撞上这件事」定，不按调用次数定。
   *
   * 只有**传了 gitRepoUrl** 的建项目路径才可能撞上一个已被绑走的仓库；沙盒项目走
   * compose、不带仓库地址，天然不适用。数调用次数会把它一起算进来（第一版就是这么
   * 错的），而且以后加一条无关的建项目路径就会误红。
   */
  it('每条会传仓库地址的建项目路径，都消费了 repoAlreadyLinked', () => {
    const marker = "'/api/projects'";
    const offenders: string[] = [];
    let checked = 0;
    let from = 0;
    for (;;) {
      const at = source.indexOf(marker, from);
      if (at < 0) break;
      from = at + marker.length;
      // 取这次调用往后的一段：足够覆盖 body 与紧随其后的结果处理
      const chunk = source.slice(at, at + 2000);
      if (!/method:\s*'POST'/.test(chunk)) continue;      // 列表那次 GET 不算
      if (!/\bgitRepoUrl\b/.test(chunk)) continue;        // 沙盒那条不传仓库地址
      checked += 1;
      if (!/repoAlreadyLinked/.test(chunk)) {
        offenders.push(source.slice(Math.max(0, at - 300), at).split('\n').slice(-8).join('\n'));
      }
    }
    expect(checked, '一条带仓库地址的建项目路径都没找到，守卫要跟着更新').toBeGreaterThanOrEqual(2);
    expect(
      offenders,
      '这条路径撞上已被绑走的仓库时会静默建出一个没绑仓库的项目，而用户看到的是「已创建」：\n'
      + offenders.join('\n---\n'),
    ).toEqual([]);
  });
});

describe('范围对话框的保存基线只能是已落库的值', () => {
  const source = read('components/project/BuildScopeDialog.tsx');

  it('比较基线取 declared，不把预勾的 suggested 算作已保存', () => {
    const before = /const before = \[\.\.\.([a-zA-Z.]+)\]/.exec(source);
    expect(before, '找不到保存时的比较基线，守卫要跟着更新').not.toBeNull();
    expect(
      before![1],
      '基线必须是 profile.declared：suggested 只是预勾在界面上，库里那条仍是空的，'
      + '拿它当基线会让「接受默认值 + 保存」一条请求都不发',
    ).toBe('profile.declared');
  });
});
