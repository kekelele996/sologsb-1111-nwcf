import { describe, it, expect } from 'vitest';
import type { CoreBox } from '../types/core-box';
import type { StoreLedger, BoxConflict } from '../types/reconcile';
import {
  reconcileBoxes,
  resolveConflict,
  parseStoreLedger,
  fingerprint,
  normalizeBoxNo,
} from './reconcile-engine';

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

function ledger(boxes: Array<Record<string, unknown>>, extra: Partial<StoreLedger> = {}): StoreLedger {
  return { app: 'store-ledger', boxes: boxes as never, ...extra };
}

describe('parseStoreLedger / fingerprint', () => {
  it('兼容 {boxes} 与裸数组', () => {
    expect(parseStoreLedger(JSON.stringify({ boxes: [{ boxNo: 'X1' }] })).boxes).toHaveLength(1);
    expect(parseStoreLedger(JSON.stringify([{ boxNo: 'X1' }])).boxes).toHaveLength(1);
  });
  it('非法 JSON / 结构报错', () => {
    expect(() => parseStoreLedger('{')).toThrow(/合法 JSON/);
    expect(() => parseStoreLedger(JSON.stringify({ nope: 1 }))).toThrow(/结构不匹配/);
  });
  it('指纹稳定且随内容变化', () => {
    expect(fingerprint('{"a":1}')).toBe(fingerprint('{"a":1}'));
    expect(fingerprint('{"a":1}')).not.toBe(fingerprint('{"a":2}'));
  });
  it('箱号归一化去空格大小写', () => {
    expect(normalizeBoxNo(' x-001 ')).toBe('X-001');
  });
});

describe('首次对账（无基准）按归属干净合并，不挂起', () => {
  it('回次/岩性/破损格按现场；库架位/借出状态按台账', () => {
    const local = box({ runNo: '2401-01', lithology: '花岗闪长岩', damagedSlots: [4], shelfPos: '旧架', loanStatus: '在库' });
    const led = ledger([
      {
        boxNo: 'X-001',
        shelfPos: 'B 区 2 架',
        loanStatus: '借出',
        loanTo: '测试中心',
        // 台账即便混进现场字段，也不能覆盖现场
        damagedSlots: [9],
        runNo: '9999',
        lithology: '大理岩',
      },
    ]);
    const r = reconcileBoxes({ localBoxes: [local], ledger: led });
    expect(r.conflicts).toHaveLength(0);
    const m = r.mergedBoxes[0];
    expect(m.shelfPos).toBe('B 区 2 架');
    expect(m.loanStatus).toBe('借出');
    expect(m.loanTo).toBe('测试中心');
    expect(m.damagedSlots).toEqual([4]);
    expect(m.runNo).toBe('2401-01');
    expect(m.lithology).toBe('花岗闪长岩');
  });

  it('台账多出的箱补建；现场多出的箱保留不删', () => {
    const local = box();
    const led = ledger([{ boxNo: 'X-001' }, { boxNo: 'X-002', shelfPos: 'C 区 1 架', loanStatus: '借出' }]);
    const r = reconcileBoxes({ localBoxes: [local], ledger: led });
    expect(r.mergedBoxes.map((b) => b.boxNo).sort()).toEqual(['X-001', 'X-002']);
    expect(r.storeOnly).toEqual(['X-002']);
    expect(r.fieldOnly).toEqual([]);

    const r2 = reconcileBoxes({ localBoxes: [box(), box({ id: 'box-2', boxNo: 'X-009' })], ledger: led });
    expect(r2.fieldOnly).toEqual(['X-009']);
    expect(r2.mergedBoxes.some((b) => b.boxNo === 'X-009')).toBe(true);
  });
});

describe('三向合并：两侧都动过 → 两版都留', () => {
  const baseline = () => [box({ shelfPos: 'A 区 1 架', loanStatus: '在库', damagedSlots: [] })];

  it('同一共有字段两侧改成不同值：strict 挂起，整箱保住上一版', () => {
    // 现场改了钻孔 + 破损格[3]；台账改了钻孔 + 库架位
    // 钻孔（共有）两侧改成不同值 → 挂起；破损格(现场)、库架位(库) 各自归属干净收敛
    const local = box({ holeId: 'hole-NEW', damagedSlots: [3] });
    const led = ledger([{ boxNo: 'X-001', holeId: 'hole-STORE', shelfPos: 'B 区 1 架' }]);
    const r = reconcileBoxes({ localBoxes: [local], ledger: led, baselineBoxes: baseline(), mode: 'strict' });
    expect(r.stats.conflicts).toBe(1);
    const c = r.conflicts[0];
    expect(c.status).toBe('pending');
    // 两版快照都在
    expect(c.fieldVersion!.holeId).toBe('hole-NEW');
    expect(c.storeVersion!.holeId).toBe('hole-STORE');
    expect(c.baseVersion!.holeId).toBe('hole-001');
    // 挂起字段只有 holeId；破损格(现场)、库架位(库) 不算挂起字段
    expect(c.fields.map((f) => f.field)).toEqual(['holeId']);
    // 整箱保住上一版：holeId 回到基准
    const m = r.mergedBoxes.find((b) => b.boxNo === 'X-001')!;
    expect(m.holeId).toBe('hole-001');
  });

  it('库管/现场字段两侧同改：按归属确定性收敛，不阻塞（库架位仍归台账）', () => {
    const local = box({ shelfPos: '现场改的架', damagedSlots: [8] });
    const led = ledger([{ boxNo: 'X-001', shelfPos: '台账改的架', damagedSlots: [1] }]);
    const r = reconcileBoxes({ localBoxes: [local], ledger: led, baselineBoxes: baseline(), mode: 'strict' });
    expect(r.conflicts).toHaveLength(0);
    expect(r.mergedBoxes[0].shelfPos).toBe('台账改的架');
    expect(r.mergedBoxes[0].damagedSlots).toEqual([8]);
  });

  it('只有一侧改动：直接取改动侧，不产生分歧', () => {
    const local = box({ damagedSlots: [5] }); // 现场改破损格
    const led = ledger([{ boxNo: 'X-001', loanStatus: '借出' }]); // 台账改借出
    const r = reconcileBoxes({ localBoxes: [local], ledger: led, baselineBoxes: baseline() });
    expect(r.conflicts).toHaveLength(0);
    const m = r.mergedBoxes[0];
    expect(m.damagedSlots).toEqual([5]);
    expect(m.loanStatus).toBe('借出');
    expect(r.cleanMerged).toContain('X-001');
  });

  it('两侧改成同一个值：干净收敛不挂起', () => {
    const local = box({ shelfPos: 'C 区 1 架' });
    const led = ledger([{ boxNo: 'X-001', shelfPos: 'C 区 1 架' }]);
    const r = reconcileBoxes({ localBoxes: [local], ledger: led, baselineBoxes: baseline() });
    expect(r.conflicts).toHaveLength(0);
  });

  it('谁都没改：unchanged', () => {
    const led = ledger([{ boxNo: 'X-001', shelfPos: 'A 区 1 架', loanStatus: '在库' }]);
    const r = reconcileBoxes({ localBoxes: [box()], ledger: led, baselineBoxes: baseline() });
    expect(r.unchanged).toContain('X-001');
    expect(r.cleanMerged).not.toContain('X-001');
  });
});

describe('合并失败保住上一版 + 按侧重试', () => {
  const baseline = () => [box({ shelfPos: 'A 区 1 架', loanStatus: '在库' })];

  it('prefer-field：共有字段的分歧按现场自动消解，但两版仍留痕；库管字段始终归台账', () => {
    const local = box({ holeId: 'hole-NEW', shelfPos: '现场架' });
    const led = ledger([{ boxNo: 'X-001', holeId: 'hole-STORE', shelfPos: '台账架' }]);
    const r = reconcileBoxes({ localBoxes: [local], ledger: led, baselineBoxes: baseline(), mode: 'prefer-field' });
    // 自动消解，不再有 pending
    expect(r.stats.conflicts).toBe(0);
    expect(r.stats.autoResolved).toBe(1);
    // 留痕仍在（一个箱一条分歧记录）
    expect(r.conflicts).toHaveLength(1);
    const holeConflict = r.conflicts.find((c) => c.fields.some((f) => f.field === 'holeId'))!;
    expect(holeConflict).toBeTruthy();
    expect(holeConflict.fields.find((f) => f.field === 'holeId')?.resolvedBy).toBe('prefer-field');
    // 库架位不产生分歧记录（库管字段确定性归台账）
    expect(holeConflict.fields.some((f) => f.field === 'shelfPos')).toBe(false);
    // 共有字段按现场
    const m = r.mergedBoxes[0];
    expect(m.holeId).toBe('hole-NEW');
    // 库管字段即便 prefer-field 也仍归台账
    expect(m.shelfPos).toBe('台账架');
  });

  it('prefer-store：共有字段按台账', () => {
    const local = box({ holeId: 'hole-NEW' });
    const led = ledger([{ boxNo: 'X-001', holeId: 'hole-STORE' }]);
    const r = reconcileBoxes({ localBoxes: [local], ledger: led, baselineBoxes: baseline(), mode: 'prefer-store' });
    expect(r.mergedBoxes[0].holeId).toBe('hole-STORE');
    expect(r.stats.conflicts).toBe(0);
  });

  it('strict 结果可作为“保住的上一版”，重跑不丢数据且幂等', () => {
    const local = box({ holeId: 'hole-NEW' });
    const led = ledger([{ boxNo: 'X-001', holeId: 'hole-STORE' }]);
    const first = reconcileBoxes({ localBoxes: [local], ledger: led, baselineBoxes: baseline(), mode: 'strict' });
    // 第一版整箱保住基准
    expect(first.mergedBoxes[0].holeId).toBe('hole-001');
    // 用第一版结果当新基准、同一份台账再送一次：现场已回退到基准，相当于只剩库侧改动 → 不再冲突
    const second = reconcileBoxes({
      localBoxes: first.mergedBoxes,
      ledger: led,
      baselineBoxes: first.mergedBoxes,
      mode: 'strict',
      prevConflicts: first.conflicts,
    });
    expect(second.mergedBoxes.map((b) => b.boxNo)).toHaveLength(1);
  });
});

describe('人工认领 resolveConflict', () => {
  it('逐字段选取并合成为最终版本，缺省按归属', () => {
    const local = box({ holeId: 'hole-NEW', toDepth: 30 });
    const led = ledger([{ boxNo: 'X-001', holeId: 'hole-STORE', toDepth: 28 }]);
    const r = reconcileBoxes({ localBoxes: [local], ledger: led, baselineBoxes: [box()], mode: 'strict' });
    const c: BoxConflict = r.conflicts.find((cc) => cc.fields.some((f) => f.field === 'holeId'))!;
    const resolved = resolveConflict(c, { holeId: 'store', toDepth: 'field' });
    expect(resolved.holeId).toBe('hole-STORE');
    expect(resolved.toDepth).toBe(30);
  });
});

describe('数据质量告警不中断', () => {
  it('箱号重复 / 空箱号告警', () => {
    const led = ledger([{ boxNo: 'X-001', shelfPos: 'A' }, { boxNo: 'X-001', shelfPos: 'B' }, { boxNo: '' }]);
    const r = reconcileBoxes({ localBoxes: [box()], ledger: led });
    expect(r.warnings.some((w) => w.includes('重复'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('为空'))).toBe(true);
    expect(r.mergedBoxes.filter((b) => b.boxNo === 'X-001')).toHaveLength(1);
  });
});
