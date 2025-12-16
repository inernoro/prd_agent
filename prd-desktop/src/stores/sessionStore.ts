import { create } from 'zustand';
import { Document, InteractionMode, Session, UserRole } from '../types';

interface SessionState {
  sessionId: string | null;
  activeGroupId: string | null;
  documentLoaded: boolean;
  document: Document | null;
  currentRole: UserRole;
  mode: InteractionMode;
  guideStep: number;
  
  setSession: (session: Session, doc: Document) => void;
  setActiveGroupId: (groupId: string | null) => void;
  setRole: (role: UserRole) => void;
  setMode: (mode: InteractionMode) => void;
  setGuideStep: (step: number) => void;
  clearSession: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  sessionId: null,
  activeGroupId: null,
  documentLoaded: false,
  document: null,
  currentRole: 'PM',
  mode: 'QA',
  guideStep: 1,
  
  setSession: (session, doc) => set({
    sessionId: session.sessionId,
    activeGroupId: session.groupId ?? null,
    documentLoaded: true,
    document: doc,
    currentRole: session.currentRole,
    mode: session.mode,
    guideStep: session.guideStep ?? 1,
  }),

  setActiveGroupId: (groupId) => set({ activeGroupId: groupId }),
  
  setRole: (role) => set({ currentRole: role }),
  
  setMode: (mode) => set({ mode }),
  
  setGuideStep: (step) => set({ guideStep: step }),
  
  clearSession: () => set({
    sessionId: null,
    activeGroupId: null,
    documentLoaded: false,
    document: null,
    currentRole: 'PM',
    mode: 'QA',
    guideStep: 1,
  }),
}));
