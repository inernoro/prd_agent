/**
 * Standby Controller — 蓝绿 admin daemon 的 active/standby 状态机(B'.2)
 *
 * 单实例(per-daemon-process)的可变 state holder。被 standby-guard middleware
 * + cds-internal 路由 + healthz/self-status 共同读;promote/standby 只允许
 * 通过 _internal 接口或 supervisor 直接调,业务代码不要直接 setActive()。
 *
 * 设计要点:
 *   - 默认 active=true,只有 init() 显式传 standby=true 才进 standby
 *   - promote() / enterStandby() 是幂等的:重复调返回成功,但只第一次跑生命周期 hook
 *   - 生命周期 hook 由 index.ts 注入(scheduler.start / janitor.start),保持
 *     standby-controller 本身不依赖具体 service 类
 */

import { writeActiveColor, type ActiveColor } from './active-color-store.js';

export type StandbyMode = 'active' | 'standby';

export interface StandbyLifecycleHooks {
  /** promote 时调:启动后台调度(scheduler.start / janitor.start)。允许同步或异步。 */
  onPromote?: () => void | Promise<void>;
  /** standby 时调:停掉后台调度。允许同步或异步。 */
  onEnterStandby?: () => void | Promise<void>;
}

export interface StandbyControllerOptions {
  /** 初始 active 状态,缺省 true。 */
  initialActive?: boolean;
  /** 自身颜色(蓝绿模式必填,单进程旧路径 null)。promote 时用来回写 active-color。 */
  selfColor?: ActiveColor | null;
  /** repoRoot 用于回写 .cds/active-color 文件(promote 后)。null 时跳过文件写入。 */
  repoRoot?: string | null;
  /** 生命周期回调,详见接口注释。 */
  hooks?: StandbyLifecycleHooks;
}

export class StandbyController {
  private _active: boolean;
  private readonly _selfColor: ActiveColor | null;
  private readonly _repoRoot: string | null;
  private _hooks: StandbyLifecycleHooks;
  /** 记录 promote / standby 是否真正跑过 hook,实现幂等。 */
  private _promotedOnce = false;

  constructor(opts: StandbyControllerOptions = {}) {
    this._active = opts.initialActive !== false; // 默认 true
    this._selfColor = opts.selfColor ?? null;
    this._repoRoot = opts.repoRoot ?? null;
    this._hooks = opts.hooks ?? {};
  }

  /** 只读访问:standby-guard / healthz / self-status 都通过这里读,不直读字段。 */
  isActive(): boolean {
    return this._active;
  }

  mode(): StandbyMode {
    return this._active ? 'active' : 'standby';
  }

  selfColor(): ActiveColor | null {
    return this._selfColor;
  }

  /**
   * 替换生命周期 hook。index.ts 在 scheduler/janitor 实例化之后调一次,
   * 让 controller 知道"promote 时该启动哪些 service"。允许多次调,后写覆盖前写。
   */
  setHooks(hooks: StandbyLifecycleHooks): void {
    this._hooks = hooks;
  }

  /**
   * 由 standby → active。幂等:重复调 promote 返回成功,但 onPromote 只跑一次。
   * 同时 atomic 写 .cds/active-color = selfColor(当 selfColor 与 repoRoot 都有值时)。
   */
  async promote(): Promise<void> {
    if (this._active) {
      return; // 已经是 active,幂等
    }
    this._active = true;
    if (this._selfColor && this._repoRoot) {
      try {
        writeActiveColor(this._repoRoot, this._selfColor);
      } catch (err) {
        console.warn(`[standby] writeActiveColor failed: ${(err as Error).message}`);
      }
    }
    if (!this._promotedOnce && this._hooks.onPromote) {
      this._promotedOnce = true;
      try {
        await this._hooks.onPromote();
      } catch (err) {
        console.error(`[standby] onPromote hook failed: ${(err as Error).message}`);
        throw err;
      }
    } else {
      // 已经 promote 过(supervisor 重启后状态未持久化也可能进这里),只确保 _promotedOnce 标记
      this._promotedOnce = true;
    }
  }

  /**
   * 由 active → standby(运维手动降级,B'.2 也支持反向)。幂等。
   * 进 standby 后调 onEnterStandby 让 scheduler/janitor 停下。
   */
  async enterStandby(): Promise<void> {
    if (!this._active) {
      return; // 已经是 standby,幂等
    }
    this._active = false;
    if (this._hooks.onEnterStandby) {
      try {
        await this._hooks.onEnterStandby();
      } catch (err) {
        console.error(`[standby] onEnterStandby hook failed: ${(err as Error).message}`);
        throw err;
      }
    }
  }
}
