import { create } from 'zustand';
import {
  sendToolboxMessage,
  listToolboxRuns,
  listToolboxAgents,
  subscribeToolboxRunEvents,
} from '@/services';
import type {
  ToolboxRun,
  ToolboxRunStep,
  ToolboxArtifact,
  AgentInfo,
  IntentResult,
  ToolboxRunEvent,
} from '@/services';

export type ToolboxStatus = 'idle' | 'analyzing' | 'running' | 'completed' | 'failed';

interface ToolboxState {
  // Current run state
  currentRunId: string | null;
  currentRun: ToolboxRun | null;
  status: ToolboxStatus;
  intent: IntentResult | null;
  steps: ToolboxRunStep[];
  artifacts: ToolboxArtifact[];
  finalResponse: string | null;
  errorMessage: string | null;
  streamingContent: Record<string, string>; // stepId -> accumulated content

  // History
  runHistory: ToolboxRun[];
  historyLoading: boolean;

  // Agent registry
  agents: AgentInfo[];
  agentsLoaded: boolean;

  // SSE subscription
  unsubscribe: (() => void) | null;

  // Actions
  sendMessage: (message: string) => Promise<void>;
  loadHistory: (page?: number, pageSize?: number) => Promise<void>;
  loadAgents: () => Promise<void>;
  selectHistoryRun: (run: ToolboxRun) => void;
  reset: () => void;

  // Internal actions
  _handleEvent: (event: ToolboxRunEvent & { eventType: string }) => void;
  _startSubscription: (runId: string) => void;
  _stopSubscription: () => void;
}

export const useToolboxStore = create<ToolboxState>((set, get) => ({
  // Initial state
  currentRunId: null,
  currentRun: null,
  status: 'idle',
  intent: null,
  steps: [],
  artifacts: [],
  finalResponse: null,
  errorMessage: null,
  streamingContent: {},

  runHistory: [],
  historyLoading: false,

  agents: [],
  agentsLoaded: false,

  unsubscribe: null,

  // Send message and start execution
  sendMessage: async (message: string) => {
    // Stop any existing subscription
    get()._stopSubscription();

    // Reset state
    set({
      status: 'analyzing',
      intent: null,
      steps: [],
      artifacts: [],
      finalResponse: null,
      errorMessage: null,
      streamingContent: {},
      currentRunId: null,
      currentRun: null,
    });

    try {
      const res = await sendToolboxMessage(message, { autoExecute: true });

      if (!res.success || !res.data) {
        set({
          status: 'failed',
          errorMessage: res.error?.message || '发送失败',
        });
        return;
      }

      const { runId, intent, plannedAgents, steps } = res.data;

      // Map steps with agent display names
      const stepsWithNames: ToolboxRunStep[] = steps.map((s) => ({
        stepId: s.stepId,
        index: s.index,
        agentKey: s.agentKey,
        agentDisplayName: s.agentDisplayName,
        action: s.action,
        status: s.status,
        artifactIds: [],
      }));

      set({
        currentRunId: runId,
        intent,
        steps: stepsWithNames,
        status: 'running',
      });

      // Start SSE subscription
      get()._startSubscription(runId);
    } catch (e) {
      set({
        status: 'failed',
        errorMessage: String(e),
      });
    }
  },

  // Load history
  loadHistory: async (page = 1, pageSize = 20) => {
    set({ historyLoading: true });
    try {
      const res = await listToolboxRuns(page, pageSize);
      if (res.success && res.data) {
        set({ runHistory: res.data.items });
      }
    } finally {
      set({ historyLoading: false });
    }
  },

  // Load available agents
  loadAgents: async () => {
    if (get().agentsLoaded) return;
    try {
      const res = await listToolboxAgents();
      if (res.success && res.data) {
        set({ agents: res.data.agents, agentsLoaded: true });
      }
    } catch {
      // Silent fail
    }
  },

  // Select a history run to view
  selectHistoryRun: (run: ToolboxRun) => {
    get()._stopSubscription();
    set({
      currentRunId: run.id,
      currentRun: run,
      intent: run.intent || null,
      steps: run.steps,
      artifacts: run.artifacts,
      finalResponse: run.finalResponse || null,
      errorMessage: run.errorMessage || null,
      status: run.status === 'Completed' ? 'completed' : run.status === 'Failed' ? 'failed' : 'idle',
      streamingContent: {},
    });
  },

  // Reset to initial state
  reset: () => {
    get()._stopSubscription();
    set({
      currentRunId: null,
      currentRun: null,
      status: 'idle',
      intent: null,
      steps: [],
      artifacts: [],
      finalResponse: null,
      errorMessage: null,
      streamingContent: {},
    });
  },

  // Handle SSE event
  _handleEvent: (event: ToolboxRunEvent & { eventType: string }) => {
    const { eventType } = event;

    switch (eventType) {
      case 'run_started':
        set({ status: 'running' });
        break;

      case 'step_started':
        if (event.stepId) {
          set((state) => ({
            steps: state.steps.map((s) =>
              s.stepId === event.stepId ? { ...s, status: 'Running' } : s
            ),
          }));
        }
        break;

      case 'step_progress':
        if (event.stepId && event.content) {
          set((state) => ({
            streamingContent: {
              ...state.streamingContent,
              [event.stepId!]: (state.streamingContent[event.stepId!] || '') + event.content,
            },
          }));
        }
        break;

      case 'step_artifact':
        if (event.artifact) {
          set((state) => ({
            artifacts: [...state.artifacts, event.artifact!],
            steps: state.steps.map((s) =>
              s.stepId === event.stepId
                ? { ...s, artifactIds: [...s.artifactIds, event.artifact!.id] }
                : s
            ),
          }));
        }
        break;

      case 'step_completed':
        if (event.stepId) {
          set((state) => ({
            steps: state.steps.map((s) =>
              s.stepId === event.stepId
                ? { ...s, status: 'Completed', output: event.content || state.streamingContent[event.stepId!] }
                : s
            ),
          }));
        }
        break;

      case 'step_failed':
        if (event.stepId) {
          set((state) => ({
            steps: state.steps.map((s) =>
              s.stepId === event.stepId
                ? { ...s, status: 'Failed', errorMessage: event.errorMessage }
                : s
            ),
          }));
        }
        break;

      case 'run_completed':
        set({
          status: 'completed',
          finalResponse: event.content || null,
        });
        get()._stopSubscription();
        break;

      case 'run_failed':
        set({
          status: 'failed',
          errorMessage: event.errorMessage || '执行失败',
        });
        get()._stopSubscription();
        break;

      case 'done':
        get()._stopSubscription();
        break;
    }
  },

  // Start SSE subscription
  _startSubscription: (runId: string) => {
    const { _handleEvent } = get();

    const unsubscribe = subscribeToolboxRunEvents(runId, {
      onEvent: _handleEvent,
      onError: (error) => {
        console.error('SSE error:', error);
        set({
          status: 'failed',
          errorMessage: '连接中断',
        });
      },
      onDone: () => {
        // Connection closed normally
      },
    });

    set({ unsubscribe });
  },

  // Stop SSE subscription
  _stopSubscription: () => {
    const { unsubscribe } = get();
    if (unsubscribe) {
      unsubscribe();
      set({ unsubscribe: null });
    }
  },
}));
