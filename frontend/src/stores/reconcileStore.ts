import { create } from 'zustand';
import type { BoxConflict } from '../types/reconcile';
import type { CoreBox } from '../types/core-box';
import type { ApplyLedgerOutcome } from '../utils/reconcile-service';
import {
  applyStoreLedger,
  getReconcileState,
  listConflicts,
  reopenConflict,
  resolveBoxConflict,
} from '../utils/reconcile-service';
import { db } from '../utils/db';

interface ReconcileState {
  conflicts: BoxConflict[];
  baselineCount: number;
  appliedCount: number;
  lastRun?: ApplyLedgerOutcome;
  loading: boolean;
  refresh: () => Promise<void>;
  applyLedger: (text: string, retryMode?: 'prefer-field' | 'prefer-store') => Promise<ApplyLedgerOutcome>;
  resolve: (conflictId: string, picks: Partial<Record<keyof CoreBox, 'field' | 'store'>>) => Promise<void>;
  reopen: (conflictId: string) => Promise<void>;
}

export const useReconcileStore = create<ReconcileState>()((set) => ({
  conflicts: [],
  baselineCount: 0,
  appliedCount: 0,
  loading: false,

  refresh: async () => {
    const [conflicts, state, boxes] = await Promise.all([listConflicts(), getReconcileState(), db.boxes.count()]);
    set({
      conflicts: conflicts.sort((a, b) => a.boxNo.localeCompare(b.boxNo)),
      baselineCount: state.baselineBoxes.length || boxes,
      appliedCount: state.appliedLedgers.length,
    });
  },

  applyLedger: async (text, retryMode) => {
    set({ loading: true });
    try {
      const outcome = await applyStoreLedger(text, { retryMode });
      const [conflicts, state] = await Promise.all([listConflicts(), getReconcileState()]);
      set({
        lastRun: outcome,
        conflicts: conflicts.sort((a, b) => a.boxNo.localeCompare(b.boxNo)),
        baselineCount: state.baselineBoxes.length,
        appliedCount: state.appliedLedgers.length,
      });
      return outcome;
    } finally {
      set({ loading: false });
    }
  },

  resolve: async (conflictId, picks) => {
    await resolveBoxConflict(conflictId, picks);
    const [conflicts, state] = await Promise.all([listConflicts(), getReconcileState()]);
    set({ conflicts, baselineCount: state.baselineBoxes.length });
  },

  reopen: async (conflictId) => {
    await reopenConflict(conflictId);
    const conflicts = await listConflicts();
    set({ conflicts });
  },
}));
