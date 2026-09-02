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

describe('范围对话框要让每个生效值都看得见、点得掉', () => {
  const source = read('components/project/BuildScopeDialog.tsx');

  it('可勾目录 = 仓库一级目录 ∪ 已选中的，否则嵌套范围看不见却照样被保存', () => {
    // 推断出来的常常是嵌套的（本仓库就有 llmgw/serving、llmgw/web），它们不在
    // 一级目录清单里。只渲染 repoDirs 的话这些值看不见、点不掉，保存时还写回去。
    expect(source).toMatch(/Object\.values\(picked\)\.flat\(\)/);
  });

  it('不可改的那些一律不发 PUT，别让提示说谎', () => {
    expect(source).toMatch(/if \(!profile\.editable\) return false;/);
  });
});

describe('共用仓库的确认要绑在它描述的那个仓库上', () => {
  const source = read('pages/ProjectSettingsPage.tsx');

  it('确认按钮提交的是被确认的那个目标，不是当前选择', () => {
    // 看到警告之后再去点另一个仓库，按钮上说的还是前一个，绑上的却是新选的，
    // 而且绕过了它自己那道 409。
    expect(source).toMatch(/linkRepo\(sharedConfirm\)/);
    expect(source, '不该再回头读 selectedRepo 来发确认请求').not.toMatch(/linkRepo\(true\)/);
  });

  it('选择一变就清确认态，并且只收在一处', () => {
    const clears = source.match(/setSharedConfirm\(null\)/g) || [];
    // 一处 effect（选择变了）+ 关弹窗 + 取消按钮 + 成功后
    expect(clears.length).toBeGreaterThanOrEqual(2);
    expect(source).toMatch(/useEffect\(\(\) => \{\s*setSharedConfirm\(null\);/);
  });
});

describe('「是不是机器凭据」这个判断只许有一处', () => {
  /**
   * 这条判断决定要不要把别的项目的信息端给调用方，至少三个消费方在用。抄两份、
   * 只改一处，正是这个 PR 反复栽的跟头：建项目那处修了、绑仓库那处漏了，
   * 第四轮 review 才抓出来。所以钉死「只有 machine-caller.ts 里有定义」。
   */
  it('全仓只有一个定义，其余都是 import', () => {
    const SRV = path.resolve(process.cwd(), '../cds/src');
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory()
        ? walk(path.join(dir, e.name))
        : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));

    const definers: string[] = [];
    for (const file of walk(SRV)) {
      const src = fs.readFileSync(file, 'utf8');
      if (/(?:export\s+)?function\s+isMachineCaller\s*\(/.test(src)) {
        definers.push(path.relative(SRV, file));
      }
    }
    expect(definers, '把它 import 过去，不要再写一份').toEqual(['services/machine-caller.ts']);
  });
});

describe('保存路径上的 repoSharing 保全接在唯一一处', () => {
  /**
   * `preserveRepoSharing` 算得对由 project-sharing-state.test.ts 断言；这里只管
   * **有没有人用它**——纯函数写好了没人调，页面照常渲染、测试照常绿，横幅照样消失
   * （predicate-and-wiring-discipline 形状 2）。
   *
   * 另一半是「只此一处」：保存回调有十来条，让每条各自记得补，就是下一次「改一处
   * 忘九处」的温床。所以钉住它收在 useProject 的 setter 里，并且那里还要静默重取
   * 权威值（绑/解绑之后事实变了，光留旧值是不够的）。
   */
  it('setProject 既留住旧值也去取权威值，且只收在这一处', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), '../cds/web/src/pages/ProjectSettingsPage.tsx'),
      'utf8',
    );
    const uses = source.match(/preserveRepoSharing\(/g) || [];
    // 一次定义 + 一次调用
    expect(uses.length).toBe(2);
    expect(source).toMatch(/setProject: \(project\) => \{[\s\S]{0,400}preserveRepoSharing\([\s\S]{0,200}void reloadSharing\(\);/);
  });
});

describe('划范围对话框换项目时不许留着上一个项目的状态', () => {
  /**
   * 换个项目重新打开时，上一个项目的 `options` 还在；这次要是取失败，`finally`
   * 把 loading 放开，保存按钮就对着**上一个项目的 profileId** 可用了——点下去把
   * 范围写到另一个项目上，而界面显示的是当前这个（2026-09-02 Codex P1）。
   *
   * 这条只能在源码这一层钉：状态藏在 useState 里，取失败那条路径也没有可断言的
   * 产物。判据是「取之前先清空」与「没有 options 时保存不可用」两件事同时成立。
   */
  it('载入前先清空，且没有 options 时保存按钮不可用', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), '../cds/web/src/components/project/BuildScopeDialog.tsx'),
      'utf8',
    );
    const effect = source.slice(source.indexOf('useEffect(() => {'), source.indexOf('function toggle('));
    const clearAt = effect.indexOf('setOptions(null)');
    const fetchAt = effect.indexOf('apiRequest<ScopeOptionsResponse>');
    expect(clearAt, '载入前要先把上一个项目的状态清掉').toBeGreaterThan(-1);
    expect(clearAt, '清空要排在请求之前').toBeLessThan(fetchAt);
    for (const setter of ['setPicked({})', 'setExtra({})']) {
      expect(effect, `${setter} 也要一起清，否则勾选还是上一个项目的`).toContain(setter);
    }
    expect(source).toMatch(/disabled=\{saving \|\| loading \|\| !options/);
  });
});
