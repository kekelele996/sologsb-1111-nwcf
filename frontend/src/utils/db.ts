import Dexie, { type Table } from 'dexie';
import type { DrillHole } from '../types/drill-hole';
import type { DrillRun } from '../types/drill-run';
import type { CoreBox } from '../types/core-box';
import type { LithoLog } from '../types/litho-log';
import type { BoxConflict } from '../types/reconcile';

/** IndexedDB 库名（浏览器本地存储，无后端） */
export const DB_NAME = 'gbdrillcore-db';

/** 当前 schema 版本，与 db.version(n) 对应 */
export const SCHEMA_VERSION = 3;

/** 对账状态表的单行键 */
export const RECONCILE_STATE_KEY = 'reconcile-state';

/** 最近一次成功合并后的岩芯箱快照（三向合并基准）与台账登记 */
export interface ReconcileStateRow {
  key: string;
  /** 上一版已合并岩芯箱快照（失败时保住它） */
  baselineBoxes: CoreBox[];
  /** 已处理过的台账批次/内容指纹（幂等：同一份台账再送不多记录） */
  appliedLedgers: Array<{ token: string; batchId?: string; appliedAt: string; boxCount: number }>;
  /** 最近一次对账元信息 */
  lastRun?: {
    at: string;
    mode: string;
    token: string;
    batchId?: string;
    stats: ReconcileStatsSnapshot;
  };
}

export interface ReconcileStatsSnapshot {
  total: number;
  merged: number;
  conflicts: number;
  autoResolved: number;
  fieldOnly: number;
  storeOnly: number;
}

class DrillCoreDB extends Dexie {
  holes!: Table<DrillHole, string>;
  runs!: Table<DrillRun, string>;
  boxes!: Table<CoreBox, string>;
  lithos!: Table<LithoLog, string>;
  conflicts!: Table<BoxConflict, string>;
  meta!: Table<{ key: string; value: string }, string>;
  /** key/value 形态的对账状态（单行） */
  reconcileState!: Table<ReconcileStateRow, string>;

  constructor() {
    super(DB_NAME);

    // v1：建表声明索引
    this.version(1).stores({
      holes: 'id, holeNo, rigNo, shift, startDate',
      runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
      boxes: 'id, boxNo, holeId, shelfPos, boxedAt',
      lithos: 'id, holeId, fromDepth, toDepth, lithology',
      meta: 'key',
    });

    // v2：岩性表增加 (holeId+fromDepth) 复合索引，按深度区间查询更快；并回填历史 rqd 缺省值。
    this.version(2)
      .stores({
        holes: 'id, holeNo, rigNo, shift, startDate',
        runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
        boxes: 'id, boxNo, holeId, shelfPos, boxedAt',
        lithos: 'id, holeId, fromDepth, toDepth, [holeId+fromDepth], lithology',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        await tx
          .table('lithos')
          .toCollection()
          .modify((row: LithoLog) => {
            if (typeof row.rqd !== 'number') {
              row.rqd = 0;
            }
          });
      });

    // v3：岩芯箱新增借出状态（库架位/借出状态由岩芯库台账对账写入），
    // 并新增 conflicts（两版同留的对账分歧）与 reconcileState（上一版结果 + 台账幂等登记）两张表。
    this.version(3)
      .stores({
        holes: 'id, holeNo, rigNo, shift, startDate',
        runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
        boxes: 'id, boxNo, holeId, shelfPos, loanStatus, boxedAt',
        lithos: 'id, holeId, fromDepth, toDepth, [holeId+fromDepth], lithology',
        conflicts: 'id, boxNo, status',
        meta: 'key',
        reconcileState: 'key',
      })
      .upgrade(async (tx) => {
        await tx
          .table('boxes')
          .toCollection()
          .modify((row: CoreBox) => {
            if (!row.loanStatus) {
              row.loanStatus = '在库';
            }
            if (!Array.isArray(row.damagedSlots)) {
              row.damagedSlots = [];
            }
          });
      });
  }
}

export const db = new DrillCoreDB();

export async function getMeta(key: string): Promise<string | undefined> {
  const row = await db.meta.get(key);
  return row?.value;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value });
}
