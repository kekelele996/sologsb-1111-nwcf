import { db, RECONCILE_STATE_KEY, type ReconcileStateRow, type ReconcileStatsSnapshot } from './db';
import type { CoreBox } from '../types/core-box';
import type { BoxConflict, ReconcileMode, ReconcileResult, StoreLedger } from '../types/reconcile';
import { fingerprint, parseStoreLedger, reconcileBoxes, resolveConflict } from './reconcile-engine';

export interface ApplyLedgerOutcome {
  /** 是否因同一份台账已送过而跳过（不多出记录） */
  duplicated: boolean;
  /** 最终生效的合并模式：strict 无冲突时为 strict；strict 有挂起并自动侧重试后为重试模式 */
  effectiveMode: ReconcileMode;
  /** strict 首轮是否产生了挂起、随后触发了按侧重试 */
  retried: boolean;
  result: ReconcileResult;
  token: string;
  batchId?: string;
}

const EMPTY_STATE = (): ReconcileStateRow => ({ key: RECONCILE_STATE_KEY, baselineBoxes: [], appliedLedgers: [] });

export async function getReconcileState(): Promise<ReconcileStateRow> {
  return (await db.reconcileState.get(RECONCILE_STATE_KEY)) ?? EMPTY_STATE();
}

/** 台账去重令牌：优先批次号，否则用内容指纹 */
export function ledgerToken(text: string, ledger: StoreLedger): { token: string; batchId?: string } {
  const batchId = ledger.batchId?.trim();
  return { token: batchId ? `batch:${batchId}` : fingerprint(text), batchId: batchId || undefined };
}

/**
 * 送一份岩芯库台账进行合并对账。
 *
 * 保证：
 * 1. 先在内存里跑纯函数，落库放在单个 Dexie 事务里；任何一步抛错，事务回滚，
 *    boxes/conflicts/state 全部保住上一版结果。
 * 2. 默认 strict：两侧都改同个共有字段时两版挂起。strict 一旦产生挂起，自动用
 *    “按侧重试”（默认现场侧）再跑一遍，尽量出一版可入库结果；两版仍保留留痕。
 * 3. 幂等：同一份台账（批次号或内容指纹相同）再送一次，直接跳过重放，不多出任何记录。
 */
export async function applyStoreLedger(
  text: string,
  options: { retryMode?: Exclude<ReconcileMode, 'strict'> } = {},
): Promise<ApplyLedgerOutcome> {
  const ledger = parseStoreLedger(text);
  const { token, batchId } = ledgerToken(text, ledger);

  const state = await getReconcileState();

  // 幂等：同一份台账已经成功送过，直接返回，不重放、不多记录
  if (state.appliedLedgers.some((item) => item.token === token)) {
    const [boxes, conflicts] = await Promise.all([db.boxes.toArray(), db.conflicts.toArray()]);
    const preview = reconcileBoxes({
      localBoxes: boxes,
      ledger,
      baselineBoxes: state.baselineBoxes,
      mode: (state.lastRun?.mode as ReconcileMode) ?? 'strict',
      prevConflicts: conflicts,
    });
    return { duplicated: true, effectiveMode: preview.mode, retried: false, result: preview, token, batchId };
  }

  const retryMode = options.retryMode ?? 'prefer-field';

  // 上一版结果（失败时要保住的对象）
  const localBoxes = await db.boxes.toArray();
  const prevConflicts = await db.conflicts.toArray();

  // 第一轮：严格对账（内存试算，不动库）
  const strict = reconcileBoxes({
    localBoxes,
    ledger,
    baselineBoxes: state.baselineBoxes,
    mode: 'strict',
    prevConflicts,
  });

  let effective: ReconcileResult = strict;
  let retried = false;
  let effectiveMode: ReconcileMode = 'strict';

  // strict 有挂起 → 保住严格结果的同时，按侧重试一遍争取可入库版本
  if (strict.stats.conflicts > 0) {
    effective = reconcileBoxes({
      localBoxes,
      ledger,
      baselineBoxes: state.baselineBoxes,
      mode: retryMode,
      prevConflicts,
    });
    retried = true;
    effectiveMode = retryMode;
  }

  const stats: ReconcileStatsSnapshot = { ...effective.stats };

  // 落库：单事务，任何失败整体回滚 → 自动保住上一版
  await db.transaction(
    'rw',
    db.boxes,
    db.conflicts,
    db.reconcileState,
    async () => {
      await db.boxes.clear();
      await db.boxes.bulkPut(effective.mergedBoxes as never[]);

      // 仅保留“人工确认过”且本次未再产生分歧的旧记录；自动消解记录以本次为准
      const keptResolved = prevConflicts.filter(
        (c) => c.status === 'resolved' && c.manual && !effective.conflicts.some((nc) => nc.id === c.id),
      );
      await db.conflicts.clear();
      await db.conflicts.bulkPut([...keptResolved, ...effective.conflicts] as never[]);

      const nextState: ReconcileStateRow = {
        ...state,
        // 本次成功合并结果成为新的三向合并基准（下一版的“上一版”）
        baselineBoxes: effective.mergedBoxes,
        appliedLedgers: [
          ...state.appliedLedgers,
          { token, batchId, appliedAt: new Date().toISOString(), boxCount: ledger.boxes.length },
        ],
        lastRun: { at: new Date().toISOString(), mode: effectiveMode, token, batchId, stats },
      };
      await db.reconcileState.put(nextState);
    },
  );

  return { duplicated: false, effectiveMode, retried, result: effective, token, batchId };
}

/**
 * 人工认领一条分歧：把逐字段取舍合成最终版本并写回。
 * 整箱更新 + 分歧置 resolved 在同一事务；失败不影响上一版。
 */
export async function resolveBoxConflict(
  conflictId: string,
  picks: Partial<Record<keyof CoreBox, 'field' | 'store'>>,
): Promise<CoreBox | null> {
  let resolvedBox: CoreBox | null = null;
  await db.transaction('rw', db.boxes, db.conflicts, db.reconcileState, async () => {
    const conflict = await db.conflicts.get(conflictId);
    if (!conflict) return;
    resolvedBox = resolveConflict(conflict, picks);
    await db.boxes.put(resolvedBox as never);
    const updated: BoxConflict = {
      ...conflict,
      status: 'resolved',
      manual: true,
      resolvedVersion: resolvedBox,
      updatedAt: new Date().toISOString(),
    };
    await db.conflicts.put(updated as never);

    // 认领结果同步进基准，避免下次对账又把它当分歧
    const state = await getReconcileState();
    if (state.baselineBoxes.length > 0) {
      state.baselineBoxes = state.baselineBoxes.map((b) => (b.boxNo === resolvedBox!.boxNo ? resolvedBox! : b));
      await db.reconcileState.put(state);
    }
  });
  return resolvedBox;
}

/** 放弃某次自动/人工判定，把一条分歧退回 pending 等人逐条认 */
export async function reopenConflict(conflictId: string): Promise<void> {
  await db.conflicts.update(conflictId, { status: 'pending', manual: false, updatedAt: new Date().toISOString() });
}

export async function listConflicts(): Promise<BoxConflict[]> {
  return db.conflicts.toArray();
}
