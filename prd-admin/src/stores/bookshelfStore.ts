/**
 * 藏书阁个人进度（已读标记 + 结业考成绩）。
 *
 * 服务端优先、本地兜底：
 *  - 进入页面先拉 /api/bookshelf/progress，成功就以服务端为准（换设备也在）；
 *  - 拉不到（离线 / 接口挂了）就继续用 localStorage 那份，不清空、不报错，页面照常可用；
 *  - 每次勾选或交卷都乐观更新本地，再异步整包 PUT 回去。
 *
 * 同步失败**必须让用户看见**（syncState='failed'）。
 * 沉默失败比报错更伤：页面显示打了勾、实际只在本地，用户换台设备发现没了，
 * 就再也不信这个功能了。所以失败不回滚（回滚会让刚点的勾弹回去，更难受），
 * 而是亮明状态 + 自动重试。
 *
 * 重试是安全的：每次 PUT 送的都是**当前完整快照**而不是增量，所以重放任意次
 * 结果相同（幂等）。三个重试时机：下一次用户操作、网络恢复（online 事件）、
 * 用户手动点重试。
 *
 * 成绩取「更好的那次」这条判据服务端也有一份：这里挡不住换设备后本地为空、
 * 一交卷就把服务端好成绩冲掉，所以真正的判据在后端。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { registerLogoutReset } from '@/stores/authStore';
import {
  getMyBookshelfProgress,
  saveMyBookshelfProgress,
} from '@/services/real/bookshelf';
import { isBetterExam } from '@/lib/bookshelf/examContext';

export interface ExamResult {
  volumeId: string;
  correct: number;
  total: number;
  passed: boolean;
  /**
   * 交卷时这一卷已读几本 / 共几本。
   * 分数脱离这两个数就没有结论：裸考 5/7 与读完 11 本考 5/7 指向完全不同的下一步。
   * 存的是快照——卷里的书会增删，不能事后用当前书数倒推。
   */
  readAtExam: number;
  totalAtExam: number;
  /** ISO 时间戳 */
  takenAt: string;
}

/**
 * synced  已与服务端一致
 * saving  正在写
 * failed  写失败，改动只在本机 —— 必须让用户看见
 * local   还没成功读到过服务端（接口不可用/未登录），退化成纯本地模式
 */
export type SyncState = 'synced' | 'saving' | 'failed' | 'local';

interface BookshelfState {
  readBookIds: string[];
  /**
   * 书 id → 一句话心得。
   *
   * 这是藏书阁里唯一一个「学习」动作。此前只有「我点了已读」这个自我声明——
   * 一个勾证明不了任何事，看板上的「已读 N 本」也就跟着没有分量。
   * 写下「我打算在哪用它」才是真读过的痕迹，也才是看板上真正值钱的东西。
   * 不设门槛：不写照样能标已读、照样能考，但写了的人看板上看得出来。
   */
  bookNotes: Record<string, string>;
  examResults: Record<string, ExamResult>;
  syncState: SyncState;
  /** 连续失败次数，用于退避与文案分级 */
  failedAttempts: number;
  loadFromServer: () => Promise<void>;
  toggleRead: (bookId: string) => void;
  isRead: (bookId: string) => boolean;
  /** 写下或改写一句心得；传空串即删除这条 */
  setNote: (bookId: string, note: string) => void;
  recordExam: (result: ExamResult) => void;
  /** 用户手动点「重试同步」 */
  retrySync: () => Promise<void>;
  resetAll: () => void;
}

/** 防抖：快速连点十本书不该打十次请求，最后那次带的快照已经包含全部改动。 */
const PUSH_DEBOUNCE_MS = 400;
let pushTimer: ReturnType<typeof setTimeout> | null = null;

/*
 * 在途请求的序号。防抖只挡住「连点」，挡不住「两次 flush 同时在飞」：
 * 断网重连补发的那一次、离开页面前的那一次、正常防抖的那一次都可能撞在一起。
 * 它们发的是各自的快照，数据本身不会错（服务端整包覆盖 + 考试取更好的那次），
 * 但先发后到的那个会把状态灯改回去——最新一次明明失败了，屏幕上却写着「已同步」。
 * 所以只认最后一次发出去的那个请求的结果，早于它的一律丢弃。
 */
let pushSeq = 0;

/*
 * 在途**拉取**的序号。上一版只给保存那一侧加了守卫，读这一侧没加——而这一侧的
 * 后果更重：A 打开藏书阁、GET 还在路上就登出，响应落地时 `set()` 把 A 的已读、
 * 笔记与成绩原样写回那个持久化的 store（登出清空已经跑完了），接着 B 登录，
 * 先看到的是 A 的记录；B 一动手，下一次 PUT 还会把 A 的快照提交进 B 的账号。
 *
 * 登出与切账号都要让在途的那一发作废，两侧用各自的序号，别共用一个——
 * 一次保存不该让同时在飞的那次拉取失效。
 */
let loadSeq = 0;

/** 导出给测试用：让用例能确定性地等一次防抖窗口，而不是靠 sleep 猜。 */
export const __pushDebounceMs = PUSH_DEBOUNCE_MS;

function toPayload(
  readBookIds: string[],
  examResults: Record<string, ExamResult>,
  bookNotes: Record<string, string>,
) {
  return {
    readBookIds,
    bookNotes,
    examResults: Object.fromEntries(
      Object.entries(examResults).map(([k, v]) => [
        k, {
          correct: v.correct, total: v.total, passed: v.passed,
          readAtExam: v.readAtExam ?? 0, totalAtExam: v.totalAtExam ?? 0,
        },
      ]),
    ),
  };
}

export const useBookshelfStore = create<BookshelfState>()(
  persist(
    (set, get) => {
      /** 立即推送当前快照。成功→synced，失败→failed（不回滚，只亮状态）。 */
      async function flush(): Promise<void> {
        const { readBookIds, examResults, bookNotes } = get();
        const seq = ++pushSeq;
        set({ syncState: 'saving' });
        try {
          const res = await saveMyBookshelfProgress(toPayload(readBookIds, examResults, bookNotes));
          if (seq !== pushSeq) return;                 // 已经有更新的一发在飞，这次的结果作废
          if (res.success) {
            set({ syncState: 'synced', failedAttempts: 0 });
          } else {
            console.error('[bookshelfStore] 保存进度失败:', res.error?.message);
            set({ syncState: 'failed', failedAttempts: get().failedAttempts + 1 });
          }
        } catch (err) {
          if (seq !== pushSeq) return;
          console.error('[bookshelfStore] 保存进度异常:', err);
          set({ syncState: 'failed', failedAttempts: get().failedAttempts + 1 });
        }
      }

      /** 防抖入口。用户每次操作都走它。 */
      function schedulePush() {
        if (pushTimer) clearTimeout(pushTimer);
        pushTimer = setTimeout(() => { pushTimer = null; void flush(); }, PUSH_DEBOUNCE_MS);
      }

      // 网络恢复时自动补一次 —— 用户断网时点的那些勾，不该等他再点一下才存上。
      // 只在失败态才发，避免每次 online 都无谓打一发。
      try {
        window.addEventListener('online', () => {
          if (get().syncState === 'failed') void flush();
        });
      } catch {
        /* 非浏览器环境（SSR / 测试）无 window，跳过即可 */
      }

      return {
        readBookIds: [],
        bookNotes: {},
        examResults: {},
        syncState: 'local',
        failedAttempts: 0,

        loadFromServer: async () => {
          const seq = ++loadSeq;
          try {
            const res = await getMyBookshelfProgress();
            // 这一发出去之后登出过 / 换过账号：响应属于上一个人，一个字都不许写回来
            if (seq !== loadSeq) return;
            if (!res.success || !res.data) return;   // 拉不到就保留本地那份，停在 local
            const results: Record<string, ExamResult> = {};
            Object.entries(res.data.examResults ?? {}).forEach(([volumeId, r]) => {
              results[volumeId] = {
                volumeId, correct: r.correct, total: r.total, passed: r.passed,
                // 服务端可能是升级前写的旧记录，没有这两个字段——按零本处理（即裸考），
                // 不许拿当前书数倒推假装读过。
                readAtExam: r.readAtExam ?? 0,
                totalAtExam: r.totalAtExam ?? 0,
                takenAt: r.takenAt,
              };
            });
            set({
              readBookIds: res.data.readBookIds ?? [],
              // 旧记录没有这个字段，按「还没写过」处理
              bookNotes: res.data.bookNotes ?? {},
              examResults: results,
              syncState: 'synced',
              failedAttempts: 0,
            });
          } catch (err) {
            console.error('[bookshelfStore] 拉取服务端进度失败，继续用本地记录:', err);
          }
        },

        toggleRead: (bookId) => {
          const cur = get().readBookIds;
          const next = cur.includes(bookId) ? cur.filter((id) => id !== bookId) : [...cur, bookId];
          set({ readBookIds: next });
          schedulePush();
        },

        isRead: (bookId) => get().readBookIds.includes(bookId),

        setNote: (bookId, note) => {
          const text = note.trim();
          const next = { ...get().bookNotes };
          if (text) next[bookId] = text;
          else delete next[bookId];          // 清空即删除，不留空字符串占位
          set({ bookNotes: next });
          schedulePush();
        },

        recordExam: (result) => {
          // 判据在 examContext.isBetterExam，与服务端 BookshelfExamScoring.IsBetter 对应。
          // 别在这里手写第二份——上一次手写的那份在服务端改成比得分率之后就漂了，
          // 而这道挡下去是直接 return，服务端那个正确的比较连跑的机会都没有。
          if (!isBetterExam(get().examResults[result.volumeId], result)) return;
          set({ examResults: { ...get().examResults, [result.volumeId]: result } });
          schedulePush();
        },

        retrySync: async () => {
          if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
          await flush();
        },

        resetAll: () => {
          set({ readBookIds: [], bookNotes: {}, examResults: {} });
          schedulePush();
        },
      };
    },
    {
      name: 'bookshelf-progress',
      version: 1,
      // 只持久化数据，不持久化同步状态：syncState 是「此刻与服务端的关系」，
      // 存进 localStorage 再读回来就是过期的谎（上次是 synced，这次可能已经断网了）。
      partialize: (s) => ({ readBookIds: s.readBookIds, bookNotes: s.bookNotes, examResults: s.examResults }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        if (!Array.isArray(state.readBookIds)) state.readBookIds = [];
        if (!state.examResults || typeof state.examResults !== 'object') state.examResults = {};
        if (!state.bookNotes || typeof state.bookNotes !== 'object') state.bookNotes = {};
      },
    },
  ),
);

/*
 * 登出时清空。这份进度持久化在 localStorage（`bookshelf-progress`），而
 * `authStore.logout()` 只 `sessionStorage.clear()`——清不掉它。不清的后果是
 * A 登出、B 在同一台机器登录，B 先看到的是 A 的已读、笔记与考试成绩；
 * 若首次 GET 还没回来 B 就动了手，A 的快照还会被 PUT 进 B 的账号。
 *
 * 排着的那次防抖推送也要一起掐掉：它送的是「当前完整快照」，在换号之后触发
 * 就是把上一位用户的数据写进新账号——和上面那条是同一个事故的两个入口。
 *
 * 判据见 `no-localstorage.md`：服务器权威数据不进 localStorage。这份进度确实是
 * 服务器权威的（有 GET/PUT 同步），留在 localStorage 是为了离线兜底那条路径，
 * 所以补的是「登出即清」而不是换存储——换成 sessionStorage 会让「关掉浏览器
 * 再回来还在」这句承诺失效。
 */
registerLogoutReset(() => {
  if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
  // 两侧的在途请求一起作废：上一个人的响应不许再改动已经清空的状态。
  // 读那一侧尤其要紧——它会把上一个人的整份进度写回来。
  pushSeq += 1;
  loadSeq += 1;
  useBookshelfStore.setState({
    readBookIds: [],
    bookNotes: {},
    examResults: {},
    syncState: 'local',
    failedAttempts: 0,
  });
});
