import { create } from 'zustand';
import { db, getMeta, setMeta } from '../utils/db';
import type { CoreBox } from '../types/core-box';
import type { WarehouseLedger, MergeReport, MergedBox } from '../types/warehouse';
import {
  buildMergeReport,
  buildBaseline,
  parseLedger,
  buildWarehouseLedger,
  serializeLedger,
} from '../utils/merge';
import { downloadText } from '../utils/export';
import { useBoxStore } from './boxStore';
import { useHoleStore } from './holeStore';

const META_BASELINE = 'merge-baseline';
const META_APPLIED_LEDGERS = 'merge-applied-ledgers';
const META_SNAPSHOT = 'pre-merge-snapshot';

export type ApplySide = 'field' | 'warehouse';

interface MergeState {
  /** 导入的台账原文 */
  ledgerText: string;
  /** 解析后的台账 */
  ledger: WarehouseLedger | null;
  /** 对账报告（解析后生成，未落库） */
  report: MergeReport | null;
  /** 已应用的台账批次号 */
  appliedLedgerIds: string[];
  /** 是否存在可恢复的上一版快照 */
  snapshotExists: boolean;
  applying: boolean;
  /** 最近一次失败的侧（用于按侧重试） */
  failedSide: ApplySide | null;
  lastError: string | null;
  lastApplied: boolean;

  loadMeta: () => Promise<void>;
  /** 导入台账文本并生成对账预览 */
  importLedgerText: (text: string) => void;
  /** 清空当前导入 */
  clearLedger: () => void;
  /** 应用对账结果：先保住上一版快照，再按现场侧 / 库管侧分别落库 */
  applyMerge: () => Promise<void>;
  /** 按侧重试失败的一侧 */
  retrySide: (side: ApplySide) => Promise<void>;
  /** 恢复合并前快照（撤销本次合并） */
  restoreSnapshot: () => Promise<void>;
  /** 冲突箱逐条认：保留现场版 / 保留库管版 */
  resolveConflict: (boxNo: string, keep: 'field' | 'warehouse') => Promise<void>;
  /** 导出现场版岩芯库台账 JSON */
  exportLedger: () => void;
}

/** 读取上一版基线（按箱号索引） */
async function readBaseline(): Promise<Record<string, CoreBox>> {
  const raw = await getMeta(META_BASELINE);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, CoreBox>;
  } catch {
    return {};
  }
}

async function readAppliedLedgers(): Promise<string[]> {
  const raw = await getMeta(META_APPLIED_LEDGERS);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

/** 现场侧落库：自动合并箱 + 冲突箱现场版 */
function fieldSideRecords(report: MergeReport): MergedBox[] {
  const records: MergedBox[] = [];
  report.results.forEach((r) => {
    if (r.kind === 'auto-merged' && r.merged) records.push(r.merged);
    if (r.kind === 'conflict' && r.fieldBox) records.push(r.fieldBox);
  });
  return records;
}

/** 库管侧落库：仅库管箱 + 冲突箱库管版 */
function warehouseSideRecords(report: MergeReport): MergedBox[] {
  const records: MergedBox[] = [];
  report.results.forEach((r) => {
    if (r.kind === 'warehouse-only' && r.merged) records.push(r.merged);
    if (r.kind === 'conflict' && r.warehouseBox) records.push(r.warehouseBox);
  });
  return records;
}

export const useMergeStore = create<MergeState>()((set, get) => ({
  ledgerText: '',
  ledger: null,
  report: null,
  appliedLedgerIds: [],
  snapshotExists: false,
  applying: false,
  failedSide: null,
  lastError: null,
  lastApplied: false,

  loadMeta: async () => {
    const [appliedLedgerIds, snapshot] = await Promise.all([readAppliedLedgers(), getMeta(META_SNAPSHOT)]);
    set({ appliedLedgerIds, snapshotExists: Boolean(snapshot) });
  },

  importLedgerText: (text) => {
    const ledger = parseLedger(text);
    const fieldBoxes = useBoxStore.getState().boxes;
    const holes = useHoleStore.getState().holes;
    const baseline = buildBaseline(fieldBoxes);
    const report = buildMergeReport(fieldBoxes, holes, ledger, baseline);
    set({ ledgerText: text, ledger, report, lastError: null, lastApplied: false, failedSide: null });
  },

  clearLedger: () => set({ ledgerText: '', ledger: null, report: null, lastError: null, failedSide: null }),

  applyMerge: async () => {
    const { report } = get();
    if (!report) return;
    set({ applying: true, lastError: null, failedSide: null, lastApplied: false });

    // 1. 先保住上一版结果：落快照
    const snapshotBoxes = useBoxStore.getState().boxes;
    await setMeta(META_SNAPSHOT, JSON.stringify(snapshotBoxes));
    set({ snapshotExists: true });

    const fieldRecords = fieldSideRecords(report);
    const warehouseRecords = warehouseSideRecords(report);

    // 2. 现场侧落库（独立事务，失败不影响库管侧）
    try {
      await db.transaction('rw', db.boxes, async () => {
        await db.boxes.bulkPut(fieldRecords);
      });
    } catch (error) {
      // 现场侧失败：恢复上一版，保住旧结果
      await restoreSnapshotFromMeta();
      await useBoxStore.getState().hydrate();
      set({
        applying: false,
        failedSide: 'field',
        lastError: `现场侧写入失败，已恢复上一版结果：${(error as Error).message}`,
      });
      return;
    }

    // 3. 库管侧落库（独立事务，失败可按侧重试，现场侧结果保留）
    try {
      await db.transaction('rw', db.boxes, async () => {
        await db.boxes.bulkPut(warehouseRecords);
      });
    } catch (error) {
      set({
        applying: false,
        failedSide: 'warehouse',
        lastError: `库管侧写入失败，现场侧结果已保留，可按「重试库管侧」补写：${(error as Error).message}`,
      });
      return;
    }

    // 4. 两侧都成功：刷新基线 + 登记已应用台账（幂等）
    const allBoxes = await db.boxes.toArray();
    const newBaseline = buildBaseline(allBoxes);
    await setMeta(META_BASELINE, JSON.stringify(newBaseline));
    const appliedLedgerIds = Array.from(new Set([...get().appliedLedgerIds, report.ledgerId]));
    await setMeta(META_APPLIED_LEDGERS, JSON.stringify(appliedLedgerIds));

    await useBoxStore.getState().hydrate();
    set({
      applying: false,
      appliedLedgerIds,
      lastApplied: true,
      lastError: null,
      failedSide: null,
      snapshotExists: true,
    });
  },

  retrySide: async (side) => {
    const { report } = get();
    if (!report) return;
    set({ applying: true, lastError: null });
    const records = side === 'field' ? fieldSideRecords(report) : warehouseSideRecords(report);
    try {
      await db.transaction('rw', db.boxes, async () => {
        await db.boxes.bulkPut(records);
      });
      // 重试成功后刷新基线
      const allBoxes = await db.boxes.toArray();
      const newBaseline = buildBaseline(allBoxes);
      await setMeta(META_BASELINE, JSON.stringify(newBaseline));
      const appliedLedgerIds = Array.from(new Set([...get().appliedLedgerIds, report.ledgerId]));
      await setMeta(META_APPLIED_LEDGERS, JSON.stringify(appliedLedgerIds));
      await useBoxStore.getState().hydrate();
      set({ applying: false, failedSide: null, lastApplied: true, appliedLedgerIds });
    } catch (error) {
      if (side === 'field') {
        await restoreSnapshotFromMeta();
        await useBoxStore.getState().hydrate();
      }
      set({
        applying: false,
        failedSide: side,
        lastError: `${side === 'field' ? '现场侧' : '库管侧'}重试失败${side === 'field' ? '，已恢复上一版' : ''}：${(error as Error).message}`,
      });
    }
  },

  restoreSnapshot: async () => {
    await restoreSnapshotFromMeta();
    await useBoxStore.getState().hydrate();
    set({ lastError: null, failedSide: null, lastApplied: false });
  },

  resolveConflict: async (boxNo, keep) => {
    const boxes = useBoxStore.getState().boxes;
    const pair = boxes.filter((b) => b.boxNo === boxNo && b.mergeGroupId);
    if (pair.length < 2) return;
    const keepBox = pair.find((b) => (keep === 'field' ? b.mergeSide !== 'warehouse' : b.mergeSide === 'warehouse'));
    const dropBox = pair.find((b) => b.id !== keepBox?.id);
    if (!keepBox || !dropBox) return;

    const resolved: CoreBox = {
      ...keepBox,
      mergeSide: keep === 'field' ? 'field' : 'warehouse',
      mergeStatus: keep === 'field' ? 'kept-field' : 'kept-warehouse',
      mergeGroupId: undefined,
      updatedAt: new Date().toISOString(),
    };
    await db.transaction('rw', db.boxes, async () => {
      await db.boxes.put(resolved);
      await db.boxes.delete(dropBox.id);
    });

    // 刷新基线
    const allBoxes = await db.boxes.toArray();
    await setMeta(META_BASELINE, JSON.stringify(buildBaseline(allBoxes)));
    await useBoxStore.getState().hydrate();

    // 同步更新对账报告：该箱已认，从未决冲突中移除
    const { report } = get();
    if (report) {
      const results = report.results.filter((r) => r.boxNo !== boxNo || r.kind !== 'conflict');
      set({
        report: {
          ...report,
          results,
          conflicts: results.filter((r) => r.kind === 'conflict').length,
          fieldOnly: results.filter((r) => r.kind === 'field-only').length,
        },
        lastApplied: true,
      });
    } else {
      set({ lastApplied: true });
    }
  },

  exportLedger: () => {
    const boxes = useBoxStore.getState().boxes;
    const holes = useHoleStore.getState().holes;
    const ledger = buildWarehouseLedger(boxes, holes);
    downloadText(`gbdrillcore-warehouse-ledger-${ledger.ledgerId}.json`, serializeLedger(ledger));
  },
}));

/** 恢复合并前快照：用快照覆盖当前箱表（保住上一版结果） */
async function restoreSnapshotFromMeta(): Promise<void> {
  const raw = await getMeta(META_SNAPSHOT);
  if (!raw) return;
  try {
    const snapshot = JSON.parse(raw) as CoreBox[];
    await db.transaction('rw', db.boxes, async () => {
      await db.boxes.clear();
      if (snapshot.length) await db.boxes.bulkPut(snapshot);
    });
  } catch {
    // 快照损坏时不动当前数据
  }
}
