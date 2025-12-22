import { useSyncExternalStore } from 'react';
import { BACKDROP_BUSY_END_EVENT, BACKDROP_BUSY_START_EVENT, emitBackdropBusyStopped } from '@/lib/backdropBusy';

type Snapshot = {
  count: number;
  pendingStopId: string | null;
};

type Listener = () => void;

function genId() {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

class BackdropMotionController {
  private snapshot: Snapshot = { count: 0, pendingStopId: null };
  private listeners = new Set<Listener>();
  private inited = false;
  private postLoginTimer: number | null = null;
  private stopQueue: string[] = [];

  initOnce() {
    if (this.inited) return;
    this.inited = true;

    // 统一监听全局命令事件（外部只发命令，状态由 controller 托管）
    window.addEventListener(BACKDROP_BUSY_START_EVENT, this.onStart);
    window.addEventListener(BACKDROP_BUSY_END_EVENT, this.onStop);

    this.consumePostLoginFlagIfAny();
  }

  consumePostLoginFlagIfAny() {
    // 登录承接：如果存在 flag，自动“运行 2 秒 + 刹停”
    try {
      const flag = sessionStorage.getItem('prd-postlogin-fx');
      if (!flag) return;
      sessionStorage.removeItem('prd-postlogin-fx');
      this.start();
      if (this.postLoginTimer) window.clearTimeout(this.postLoginTimer);
      this.postLoginTimer = window.setTimeout(() => {
        this.stop();
        this.postLoginTimer = null;
      }, 2000);
    } catch {
      // ignore
    }
  }

  dispose() {
    if (!this.inited) return;
    this.inited = false;
    window.removeEventListener(BACKDROP_BUSY_START_EVENT, this.onStart);
    window.removeEventListener(BACKDROP_BUSY_END_EVENT, this.onStop);
    if (this.postLoginTimer) window.clearTimeout(this.postLoginTimer);
    this.postLoginTimer = null;
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  private setSnapshot(next: Snapshot) {
    this.snapshot = next;
    this.emit();
  }

  getSnapshot = () => this.snapshot;

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start() {
    // 若 start 打断了刹车，为避免等待挂死：将已排队的 stop 视为“已结束”（尽管未真正停住）
    // 这比“后续任务永远不执行”更可控；真正需要严格顺序的任务会在调用侧避免并发。
    if (this.stopQueue.length) {
      for (const id of this.stopQueue) emitBackdropBusyStopped(id);
      this.stopQueue = [];
    }
    this.setSnapshot({ count: this.snapshot.count + 1, pendingStopId: null });
  }

  stop(id?: string) {
    const stopId = id || genId();
    const prev = this.snapshot.count;
    const nextCount = Math.max(0, prev - 1);
    // 记录本次 stop，待真正“完全停止”后统一回调（避免多次 stop 只有第一个生效）
    this.stopQueue.push(stopId);

    // 如果已经处于 idle 且没有刹车在进行：立即回调，保证调用方不会挂死
    if (prev === 0 && !this.snapshot.pendingStopId) {
      emitBackdropBusyStopped(stopId);
      // 移除刚加入的队列项
      this.stopQueue = this.stopQueue.filter((x) => x !== stopId);
      return stopId;
    }

    const pendingStopId = prev > 0 && nextCount === 0 ? stopId : this.snapshot.pendingStopId;
    this.setSnapshot({ count: nextCount, pendingStopId });
    return stopId;
  }

  markStopped(id: string) {
    if (!id) return;
    if (this.snapshot.pendingStopId !== id) return;
    // 刹车完成：把本轮所有 stopId 都回调（保证“后发 stop 也能等到”）
    const toFire = [...this.stopQueue];
    this.stopQueue = [];
    this.setSnapshot({ count: this.snapshot.count, pendingStopId: null });
    for (const sid of toFire) emitBackdropBusyStopped(sid);
  }

  private onStart = () => this.start();

  private onStop = (e: Event) => {
    const ce = e as CustomEvent;
    const id = (ce.detail?.id as string | undefined) ?? '';
    this.stop(id || undefined);
  };
}

export const backdropMotionController = new BackdropMotionController();

export function useBackdropMotionSnapshot() {
  // 首次订阅时 init（保证不会出现“事件先发后监听”）
  if (typeof window !== 'undefined') {
    backdropMotionController.initOnce();
    // 关键：postlogin flag 可能在 controller 初始化后才写入（登录成功），这里每次订阅都尝试消费一次
    backdropMotionController.consumePostLoginFlagIfAny();
  }
  return useSyncExternalStore(backdropMotionController.subscribe, backdropMotionController.getSnapshot, backdropMotionController.getSnapshot);
}


