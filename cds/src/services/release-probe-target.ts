/**
 * release-probe-target — 「这个发布目标此刻能不能被探测」的**唯一判定源**。
 *
 * 为什么要单独一个文件：这条规则原本只长在发布中心预检里（release-service 的
 * `canProbeTarget`），存活监控要复用同一条规则。两边各写一遍的结局是迟早漂移——
 * 一边认了「已归档也探」另一边没认，生产状态页就要么假红要么**假绿**；而假绿
 * 意味着生产真的宕机时状态页仍是绿的，比压根没有状态页更糟。判定只留这一份，
 * 消费方一律调它。回归见 tests/services/uptime-release-targets.test.ts 的
 * 「防再修一边」用例：两个消费方对同一个目标必须得出同一个结论。
 *
 * 边界：请求级的「分支与目标跨项目」（projectMismatch）**不属于**目标自身状态，
 * 留给调用方自己叠加，别把请求上下文塞进目标判定里。
 */

import type { ReleaseTarget } from '../types.js';

/**
 * 探测记录的命名空间前缀。两类目标共用一张 records 表，撞键就意味着一个分支
 * 服务的采样把生产目标的采样覆盖掉（或反过来），状态页会显示另一个东西的可用率。
 *
 * 为什么是 `release@` 而不是更顺眼的 `release::`：分支侧的键恒为
 * `${branchId}::${profileId}`，而 `release::` 前缀在「legacy 项目里有一条叫
 * release 的分支」时会正好撞上（`release` + `::` + profileId）。`release@` 里
 * 没有 `::`，而分支键必然含 `::`，两者字符串永不可能相等——这是结构性保证，
 * 不依赖「不会有人这么命名分支」的默契。分支 id 只由 StateService.slugify 产出
 * （`[a-z0-9-]`），也不可能含 `@`。
 */
export const RELEASE_PROBE_ID_PREFIX = 'release@';

export function releaseProbeTargetId(target: Pick<ReleaseTarget, 'id'>): string {
  return `${RELEASE_PROBE_ID_PREFIX}${target.id}`;
}

/**
 * 目标自身是否处于可探测状态。与发布中心预检的 `canProbeTarget` 同一把尺子
 * （少掉那条请求级的 projectMismatch）。
 */
export function isReleaseTargetProbeable(target: ReleaseTarget | null | undefined): boolean {
  return Boolean(
    target?.ssh
    && target.isEnabled
    && target.lifecycle !== 'archived'
    && target.type === 'ssh',
  );
}

/** 探测地址（已 trim）。没配就是空串，调用方据此判断能不能真的发请求。 */
export function releaseProbeUrl(target: ReleaseTarget | null | undefined): string {
  return (target?.ssh?.healthcheckUrl || '').trim();
}

/**
 * 不可探测的人话原因；可探测时返回 null。
 *
 * 与 isReleaseTargetProbeable + releaseProbeUrl 的等价关系由守卫测试锁死：
 * 返回 null 当且仅当「目标可探测且配了地址」，避免两个函数各自漂移之后，
 * 状态页出现「标了暂停却说不出为什么」或「说了原因却仍在探测」。
 */
export function releaseProbeSkipReason(target: ReleaseTarget | null | undefined): string | null {
  if (!target) return '发布目标不存在';
  if (target.type !== 'ssh' || !target.ssh) {
    return '不是站点（SSH）发布目标，当前只支持站点目标的存活探测';
  }
  if (target.lifecycle === 'archived') {
    return '发布目标已归档，只保留审计记录，不再探测';
  }
  if (!target.isEnabled) {
    return '发布目标已停用，在发布中心重新启用后自动恢复探测';
  }
  if (!releaseProbeUrl(target)) {
    return '发布目标未配置上线地址（healthcheckUrl），补齐后自动恢复探测';
  }
  return null;
}
