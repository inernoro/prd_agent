export interface BranchListItem {
  id: string;
  projectId?: string;
}

export interface BranchListSlice<T extends BranchListItem> {
  branches: T[];
  lastKnownGoodBranches: T[];
  projectWarning?: string;
}

export type BranchListAction<T extends BranchListItem> =
  | {
      type: 'authoritativeLoaded';
      branches: T[];
      source: string;
      projectBranchCount?: number | null;
      confirmedEmpty?: boolean;
      warning?: string;
    }
  | { type: 'refreshFailed'; message: string }
  | { type: 'sseSnapshot'; branches?: T[]; source: string }
  | { type: 'sseBranchUpsert'; branch: T; projectId: string }
  | { type: 'sseBranchPatch'; branchId: string; projectId: string; patch: Partial<T> }
  | { type: 'sseBranchRemove'; branchId: string; projectId: string }
  | { type: 'sseMalformed'; source: string };

export interface BranchListReduceResult<T extends BranchListItem> {
  state: BranchListSlice<T>;
  needsEmptyRecheck: boolean;
}

function usableBranches<T extends BranchListItem>(state: BranchListSlice<T>): T[] {
  return state.branches.length > 0 ? state.branches : state.lastKnownGoodBranches;
}

function withGoodBranches<T extends BranchListItem>(
  state: BranchListSlice<T>,
  branches: T[],
  warning?: string,
): BranchListSlice<T> {
  return {
    ...state,
    branches,
    lastKnownGoodBranches: branches.length > 0 ? branches : state.lastKnownGoodBranches,
    projectWarning: warning,
  };
}

export function reduceBranchListState<T extends BranchListItem>(
  state: BranchListSlice<T>,
  action: BranchListAction<T>,
): BranchListReduceResult<T> {
  if (action.type === 'authoritativeLoaded') {
    if (action.branches.length > 0) {
      return {
        state: withGoodBranches(state, action.branches, action.warning),
        needsEmptyRecheck: false,
      };
    }

    const fallback = usableBranches(state);
    if (fallback.length > 0) {
      if (action.confirmedEmpty && action.projectBranchCount === 0) {
        return {
          state: {
            ...state,
            branches: [],
            lastKnownGoodBranches: [],
            projectWarning: action.warning,
          },
          needsEmptyRecheck: false,
        };
      }

      return {
        state: {
          ...state,
          branches: fallback,
          lastKnownGoodBranches: fallback,
          projectWarning: action.warning
            || `${action.source} 返回了空分支列表，已保留上次可用的 ${fallback.length} 个分支；正在复核。`,
        },
        needsEmptyRecheck: !action.confirmedEmpty,
      };
    }

    return {
      state: {
        ...state,
        branches: [],
        lastKnownGoodBranches: [],
        projectWarning: action.warning
          || (action.projectBranchCount && action.projectBranchCount > 0
            ? `${action.source} 返回空分支列表，但项目元信息显示仍有 ${action.projectBranchCount} 个分支；请稍后刷新确认。`
            : undefined),
      },
      needsEmptyRecheck: Boolean(
        !action.confirmedEmpty
        && action.projectBranchCount
        && action.projectBranchCount > 0,
      ),
    };
  }

  if (action.type === 'refreshFailed') {
    return {
      state: {
        ...state,
        branches: usableBranches(state),
        projectWarning: action.message,
      },
      needsEmptyRecheck: false,
    };
  }

  if (action.type === 'sseSnapshot') {
    if (Array.isArray(action.branches) && action.branches.length === 0 && state.branches.length > 0) {
      return {
        state: {
          ...state,
          projectWarning: `${action.source} 收到空快照；SSE 仅作为增量信号，已保留当前 ${state.branches.length} 个分支。`,
        },
        needsEmptyRecheck: true,
      };
    }
    return { state, needsEmptyRecheck: false };
  }

  if (action.type === 'sseBranchUpsert') {
    if (action.branch.projectId !== action.projectId) {
      return { state, needsEmptyRecheck: false };
    }
    const exists = state.branches.some((branch) => branch.id === action.branch.id);
    const branches = exists
      ? state.branches.map((branch) => (branch.id === action.branch.id ? { ...branch, ...action.branch } : branch))
      : [action.branch, ...state.branches];
    return {
      state: withGoodBranches(state, branches, undefined),
      needsEmptyRecheck: false,
    };
  }

  if (action.type === 'sseBranchPatch') {
    const exists = state.branches.some((branch) => (
      branch.id === action.branchId && branch.projectId === action.projectId
    ));
    if (!exists) return { state, needsEmptyRecheck: false };
    const branches = state.branches.map((branch) => (
      branch.id === action.branchId && branch.projectId === action.projectId
        ? { ...branch, ...action.patch, projectId: branch.projectId }
        : branch
    ));
    return {
      state: withGoodBranches(state, branches, state.projectWarning),
      needsEmptyRecheck: false,
    };
  }

  if (action.type === 'sseBranchRemove') {
    const branches = state.branches.filter((branch) => (
      branch.id !== action.branchId || branch.projectId !== action.projectId
    ));
    const lastKnownGoodBranches = state.lastKnownGoodBranches.filter((branch) => (
      branch.id !== action.branchId || branch.projectId !== action.projectId
    ));
    return {
      state: {
        ...state,
        branches,
        lastKnownGoodBranches,
      },
      needsEmptyRecheck: false,
    };
  }

  return {
    state: {
      ...state,
      branches: usableBranches(state),
      projectWarning: `${action.source} 实时事件解析失败，已保留当前分支列表。`,
    },
    needsEmptyRecheck: false,
  };
}
