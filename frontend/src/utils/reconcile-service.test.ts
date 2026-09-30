// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { db, RECONCILE_STATE_KEY } from './db';
import type { CoreBox } from '../types/core-box';
import { applyStoreLedger, getReconcileState, listConflicts, resolveBoxConflict } from './reconcile-service';

function box(over: Partial<CoreBox> = {}): CoreBox {
  return {
    id: 'box-1',
    boxNo: 'X-001',
    holeId: 'hole-001',
    fromDepth: 0,
    toDepth: 25,
    slots: 10,
    slotLength: 2.5,
    boxedAt: '2026-09-01T00:00:00.000Z',
    shelfPos: 'A 区 1 架',
    loanStatus: '在库',
    damagedSlots: [],
    operator: '高振华',
    ...over,
  };
}

const ledgerJson = (rows: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ app: 'store-ledger', boxes: rows, ...extra });

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('applyStoreLedger 服务层', () => {
  it('按归属落库：破损格/回次按现场，库架位/借出按台账', async () => {
    await db.boxes.put(box({ runNo: '2401-01', damagedSlots: [4] }));
    const out = await applyStoreLedger(
      ledgerJson([{ boxNo: 'X-001', shelfPos: 'B 区 2 架', loanStatus: '借出', loanTo: '实验室', damagedSlots: [9] }]),
    );
    expect(out.duplicated).toBe(false);
    const saved = await db.boxes.toArray();
    expect(saved[0].shelfPos).toBe('B 区 2 架');
    expect(saved[0].loanStatus).toBe('借出');
    expect(saved[0].loanTo).toBe('实验室');
    expect(saved[0].damagedSlots).toEqual([4]);
    expect(saved[0].runNo).toBe('2401-01');
  });

  it('同一份台账再送一次：幂等，不多出记录', async () => {
    await db.boxes.put(box());
    const text = ledgerJson([{ boxNo: 'X-001', loanStatus: '借出' }], { batchId: 'B20260930-01' });

    const first = await applyStoreLedger(text);
    expect(first.duplicated).toBe(false);
    const afterFirst = await db.boxes.toArray();
    expect(afterFirst[0].loanStatus).toBe('借出');

    const second = await applyStoreLedger(text);
    expect(second.duplicated).toBe(true);
    const afterSecond = await db.boxes.toArray();
    expect(afterSecond).toHaveLength(1);
    const state = await getReconcileState();
    // 登记只记一次
    expect(state.appliedLedgers.filter((l) => l.token === 'batch:B20260930-01')).toHaveLength(1);
  });

  it('内容不同但无 batchId：指纹不同，视为新台账；内容相同则幂等', async () => {
    await db.boxes.put(box());
    const t1 = ledgerJson([{ boxNo: 'X-001', loanStatus: '借出' }]);
    const t2 = ledgerJson([{ boxNo: 'X-001', loanStatus: '借出' }]);
    const t3 = ledgerJson([{ boxNo: 'X-001', loanStatus: '归还中' }]);
    expect((await applyStoreLedger(t1)).duplicated).toBe(false);
    expect((await applyStoreLedger(t2)).duplicated).toBe(true);
    expect((await applyStoreLedger(t3)).duplicated).toBe(false);
  });

  it('两侧同改共有字段：strict 挂起后自动按现场侧重试，出可入库结果且两版留痕', async () => {
    // 先建立“上一版”基准：做一次干净对账
    await db.boxes.put(box());
    await applyStoreLedger(ledgerJson([{ boxNo: 'X-001', shelfPos: 'A 区 1 架' }]));

    // 现场把钻孔改成 hole-F；台账把钻孔改成 hole-S
    await db.boxes.toCollection().modify((b: CoreBox) => {
      b.holeId = 'hole-F';
    });
    const out = await applyStoreLedger(
      ledgerJson([{ boxNo: 'X-001', holeId: 'hole-S', shelfPos: 'C 区 1 架' }]),
      { retryMode: 'prefer-field' },
    );
    expect(out.retried).toBe(true);
    expect(out.effectiveMode).toBe('prefer-field');
    // 按现场侧：钻孔取现场；库架位仍按台账
    const saved = await db.boxes.toArray();
    expect(saved[0].holeId).toBe('hole-F');
    expect(saved[0].shelfPos).toBe('C 区 1 架');
    // 两版留痕
    const conflicts = await listConflicts();
    const c = conflicts.find((cc) => cc.fields.some((f) => f.field === 'holeId'))!;
    expect(c).toBeTruthy();
    expect(c.fieldVersion!.holeId).toBe('hole-F');
    expect(c.storeVersion!.holeId).toBe('hole-S');
  });

  it('人工认领：逐字段确认并写回，且同步进基准', async () => {
    await db.boxes.put(box());
    await applyStoreLedger(ledgerJson([{ boxNo: 'X-001' }]));
    await db.boxes.toCollection().modify((b: CoreBox) => {
      b.holeId = 'hole-F';
    });
    const out = await applyStoreLedger(
      ledgerJson([{ boxNo: 'X-001', holeId: 'hole-S' }], { batchId: 'resolve-case' }),
      { retryMode: 'prefer-field' },
    );
    const conflict = out.result.conflicts.find((c) => c.fields.some((f) => f.field === 'holeId'))!;
    const resolved = await resolveBoxConflict(conflict.id, { holeId: 'store' });
    expect(resolved?.holeId).toBe('hole-S');
    const saved = await db.boxes.toArray();
    expect(saved[0].holeId).toBe('hole-S');
    const state = await getReconcileState();
    expect(state.baselineBoxes[0].holeId).toBe('hole-S');
  });

  it('落库失败时事务回滚，保住上一版结果（box 数量与内容不变）', async () => {
    await db.boxes.put(box());
    await applyStoreLedger(ledgerJson([{ boxNo: 'X-001', loanStatus: '借出' }], { batchId: 'good-1' }));
    const before = await db.boxes.toArray();
    const stateBefore = await getReconcileState();

    // 让 bulkPut 抛错：构造一个违反 schema 的脏记录（通过 hook 拦截 put 抛异常）
    const failHook = () => {
      throw new Error('模拟磁盘写入失败');
    };
    db.boxes.hook('creating', failHook);
    db.boxes.hook('updating', failHook);

    await expect(
      applyStoreLedger(ledgerJson([{ boxNo: 'X-001', loanStatus: '归还中' }], { batchId: 'bad-2' })),
    ).rejects.toThrow(/模拟磁盘写入失败/);

    db.boxes.hook('creating').unsubscribe(failHook);
    db.boxes.hook('updating').unsubscribe(failHook);

    // 上一版结果完好
    const after = await db.boxes.toArray();
    expect(after).toEqual(before);
    expect(after[0].loanStatus).toBe('借出');
    // 失败台账没有登记进幂等表（可重送）
    const stateAfter = await getReconcileState();
    expect(stateAfter.appliedLedgers.map((l) => l.batchId)).toEqual(stateBefore.appliedLedgers.map((l) => l.batchId));
    expect(stateAfter.appliedLedgers.some((l) => l.batchId === 'bad-2')).toBe(false);
    expect(stateAfter.key).toBe(RECONCILE_STATE_KEY);
  });

  it('自动消解不短路：下一份台账仍可继续合并该箱（只有人工确认才沿用）', async () => {
    await db.boxes.put(box());
    await applyStoreLedger(ledgerJson([{ boxNo: 'X-001' }], { batchId: 'base' }));
    await db.boxes.toCollection().modify((b: CoreBox) => {
      b.holeId = 'hole-F';
    });
    // 两侧同改钻孔 → 自动按现场消解为 hole-F
    await applyStoreLedger(ledgerJson([{ boxNo: 'X-001', holeId: 'hole-S1' }], { batchId: 'ledger-1' }), {
      retryMode: 'prefer-field',
    });
    expect((await db.boxes.toArray())[0].holeId).toBe('hole-F');

    // 新一份台账只改库侧钻孔为 hole-S2，现场未动 → 应取台账（自动消解记录不应短路）
    await applyStoreLedger(ledgerJson([{ boxNo: 'X-001', holeId: 'hole-S2' }], { batchId: 'ledger-2' }));
    expect((await db.boxes.toArray())[0].holeId).toBe('hole-S2');
  });

  it('人工认领后该箱沿用户确认结果，不再被同字段台账改动覆盖', async () => {
    await db.boxes.put(box());
    await applyStoreLedger(ledgerJson([{ boxNo: 'X-001' }], { batchId: 'base2' }));
    await db.boxes.toCollection().modify((b: CoreBox) => {
      b.holeId = 'hole-F';
    });
    const out = await applyStoreLedger(ledgerJson([{ boxNo: 'X-001', holeId: 'hole-S1' }], { batchId: 'r1' }), {
      retryMode: 'prefer-field',
    });
    const conflict = out.result.conflicts.find((c) => c.fields.some((f) => f.field === 'holeId'))!;
    await resolveBoxConflict(conflict.id, { holeId: 'field' }); // 人工确认现场版 hole-F

    // 新台账仍给 hole-S3：人工确认优先，保持 hole-F
    await applyStoreLedger(ledgerJson([{ boxNo: 'X-001', holeId: 'hole-S3' }], { batchId: 'r2' }));
    expect((await db.boxes.toArray())[0].holeId).toBe('hole-F');
  });

  it('台账缺失箱子不会删除现场已有箱', async () => {
    await db.boxes.bulkPut([box(), box({ id: 'box-2', boxNo: 'X-002' })]);
    await applyStoreLedger(ledgerJson([{ boxNo: 'X-001', loanStatus: '借出' }]));
    const all = await db.boxes.toArray();
    expect(all.map((b) => b.boxNo).sort()).toEqual(['X-001', 'X-002']);
  });
});
