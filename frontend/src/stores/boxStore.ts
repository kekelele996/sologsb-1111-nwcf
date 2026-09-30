import { create } from 'zustand';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import type { CoreBox, LoanStatus } from '../types/core-box';

export interface BoxInput {
  boxNo: string;
  holeId: string;
  fromDepth: number;
  toDepth: number;
  slots: number;
  slotLength: number;
  boxedAt: string;
  shelfPos: string;
  loanStatus: LoanStatus;
  loanTo?: string;
  loanedAt?: string;
  runNo?: string;
  lithology?: string;
  damagedSlots: number[];
  operator: string;
  remark?: string;
}

interface BoxState {
  boxes: CoreBox[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addBox: (input: BoxInput) => Promise<CoreBox>;
  updateBox: (id: string, patch: Partial<BoxInput>) => Promise<void>;
  removeBox: (id: string) => Promise<void>;
  /** 标记/取消破损格 */
  toggleDamagedSlot: (id: string, slot: number) => Promise<void>;
  /** 仅更新库管字段（库架位/借出状态），由岩芯库对账或库管操作写入 */
  updateStoreFields: (id: string, patch: Pick<BoxInput, 'shelfPos' | 'loanStatus' | 'loanTo' | 'loanedAt'>) => Promise<void>;
}

function toCoreBox(id: string, input: BoxInput): CoreBox {
  return {
    id,
    boxNo: input.boxNo.trim(),
    holeId: input.holeId,
    fromDepth: Number(input.fromDepth) || 0,
    toDepth: Number(input.toDepth) || 0,
    slots: Number(input.slots) || 0,
    slotLength: Number(input.slotLength) || 0,
    boxedAt: input.boxedAt,
    shelfPos: input.shelfPos,
    loanStatus: input.loanStatus ?? '在库',
    loanTo: input.loanTo?.trim() || undefined,
    loanedAt: input.loanedAt || undefined,
    runNo: input.runNo?.trim() || undefined,
    lithology: input.lithology?.trim() || undefined,
    damagedSlots: input.damagedSlots ?? [],
    operator: input.operator.trim(),
    remark: input.remark?.trim() || undefined,
  };
}

/** 岩芯箱与格位分配 */
export const useBoxStore = create<BoxState>()((set, get) => ({
  boxes: [],
  hydrated: false,

  hydrate: async () => {
    const boxes = await db.boxes.orderBy('boxNo').toArray();
    set({ boxes, hydrated: true });
  },

  addBox: async (input) => {
    const box = toCoreBox(uid('box'), input);
    await db.boxes.put(box);
    set({ boxes: [...get().boxes, box] });
    return box;
  },

  updateBox: async (id, patch) => {
    const current = get().boxes.find((b) => b.id === id);
    if (!current) return;
    const next: CoreBox = { ...current, ...patch };
    await db.boxes.put(next);
    set({ boxes: get().boxes.map((b) => (b.id === id ? next : b)) });
  },

  removeBox: async (id) => {
    await db.boxes.delete(id);
    set({ boxes: get().boxes.filter((b) => b.id !== id) });
  },

  toggleDamagedSlot: async (id, slot) => {
    const current = get().boxes.find((b) => b.id === id);
    if (!current) return;
    const damagedSlots = current.damagedSlots.includes(slot)
      ? current.damagedSlots.filter((s) => s !== slot)
      : [...current.damagedSlots, slot].sort((a, b) => a - b);
    const next: CoreBox = { ...current, damagedSlots };
    await db.boxes.put(next);
    set({ boxes: get().boxes.map((b) => (b.id === id ? next : b)) });
  },

  updateStoreFields: async (id, patch) => {
    const current = get().boxes.find((b) => b.id === id);
    if (!current) return;
    const next: CoreBox = {
      ...current,
      shelfPos: patch.shelfPos ?? current.shelfPos,
      loanStatus: patch.loanStatus ?? current.loanStatus,
      loanTo: patch.loanTo !== undefined ? patch.loanTo.trim() || undefined : current.loanTo,
      loanedAt: patch.loanedAt !== undefined ? patch.loanedAt || undefined : current.loanedAt,
    };
    await db.boxes.put(next);
    set({ boxes: get().boxes.map((b) => (b.id === id ? next : b)) });
  },
}));
