import type { CoreBox } from '../types/core-box';
import type { DrillHole } from '../types/drill-hole';
import {
  WAREHOUSE_APP_TAG,
  type WarehouseLedger,
  type WarehouseBoxRecord,
  type MergedBox,
  type BoxMergeResult,
  type MergeReport,
  type LoanStatus,
  type ConflictFieldRow,
} from '../types/warehouse';
import { uid } from './id';

export { WAREHOUSE_APP_TAG };

export const LOAN_STATUSES: LoanStatus[] = ['在库', '借出'];

/** 现场编录负责的字段：回次、岩性、破损格与结构（箱里编录的按现场算） */
const FIELD_OWNED_KEYS = [
  'boxNo',
  'holeId',
  'fromDepth',
  'toDepth',
  'slots',
  'slotLength',
  'boxedAt',
  'damagedSlots',
  'operator',
  'remark',
] as const;

/** 岩芯库负责的字段：库架位、借出状态（库架位和借出状态按岩芯库的算） */
const WAREHOUSE_OWNED_KEYS = ['shelfPos', 'loanStatus'] as const;

const ALL_KEYS = [...FIELD_OWNED_KEYS, ...WAREHOUSE_OWNED_KEYS] as const;

const FIELD_LABELS: Record<string, string> = {
  boxNo: '箱号',
  holeId: '所属钻孔',
  fromDepth: '起始深度',
  toDepth: '终止深度',
  slots: '格数',
  slotLength: '每格长度',
  boxedAt: '装箱日期',
  damagedSlots: '破损格',
  operator: '装箱人',
  remark: '备注',
  shelfPos: '库架位',
  loanStatus: '借出状态',
};

export function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key;
}

function isFieldOwned(key: string): boolean {
  return (FIELD_OWNED_KEYS as readonly string[]).includes(key);
}

/** 取值比较（破损格按集合比较，顺序无关） */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const sa = [...a].map((v) => JSON.stringify(v)).sort();
    const sb = [...b].map((v) => JSON.stringify(v)).sort();
    return sa.every((v, i) => v === sb[i]);
  }
  return a === b;
}

function readField(box: CoreBox, key: string): unknown {
  return (box as unknown as Record<string, unknown>)[key];
}

/** 相对上一版基线，返回某一版发生改动的字段 */
function changedKeys(prev: CoreBox | null | undefined, next: CoreBox, keys: readonly string[]): string[] {
  if (!prev) return [];
  return keys.filter((k) => !valuesEqual(readField(prev, k), readField(next, k)));
}

/** 校验并解析导入的岩芯库台账 JSON */
export function parseLedger(text: string): WarehouseLedger {
  const payload = JSON.parse(text) as Partial<WarehouseLedger>;
  if (!payload || payload.app !== WAREHOUSE_APP_TAG) {
    throw new Error('台账文件格式不匹配（缺少 app=gbdrillcore-warehouse 标记）');
  }
  if (!Array.isArray(payload.boxes)) {
    throw new Error('台账文件缺少 boxes 箱记录数组');
  }
  if (typeof payload.ledgerId !== 'string' || !payload.ledgerId.trim()) {
    throw new Error('台账文件缺少 ledgerId 批次号');
  }
  const boxes: WarehouseBoxRecord[] = payload.boxes
    .filter((b): b is WarehouseBoxRecord => Boolean(b && typeof b.boxNo === 'string' && b.boxNo.trim()))
    .map((b) => ({
      boxNo: b.boxNo.trim(),
      holeNo: b.holeNo?.trim() || undefined,
      shelfPos: typeof b.shelfPos === 'string' ? b.shelfPos : '',
      loanStatus: b.loanStatus === '借出' ? '借出' : '在库',
      fromDepth: typeof b.fromDepth === 'number' ? b.fromDepth : undefined,
      toDepth: typeof b.toDepth === 'number' ? b.toDepth : undefined,
      slots: typeof b.slots === 'number' ? b.slots : undefined,
      slotLength: typeof b.slotLength === 'number' ? b.slotLength : undefined,
      boxedAt: typeof b.boxedAt === 'string' ? b.boxedAt : undefined,
      remark: typeof b.remark === 'string' ? b.remark : undefined,
    }));
  return {
    app: WAREHOUSE_APP_TAG,
    ledgerId: payload.ledgerId.trim(),
    exportedAt: typeof payload.exportedAt === 'string' ? payload.exportedAt : new Date().toISOString(),
    source: typeof payload.source === 'string' ? payload.source : undefined,
    boxes,
  };
}

/** 库管记录 → 落库箱（按孔号匹配现场钻孔） */
function warehouseRecordToBox(rec: WarehouseBoxRecord, holeIdByNo: Map<string, string>): MergedBox {
  const holeId = rec.holeNo ? holeIdByNo.get(rec.holeNo) ?? '' : '';
  return {
    id: uid('boxwh'),
    boxNo: rec.boxNo,
    holeId,
    fromDepth: rec.fromDepth ?? 0,
    toDepth: rec.toDepth ?? 0,
    slots: rec.slots ?? 0,
    slotLength: rec.slotLength ?? 0,
    boxedAt: rec.boxedAt ?? '',
    shelfPos: rec.shelfPos,
    loanStatus: rec.loanStatus,
    damagedSlots: [],
    operator: '',
    remark: rec.remark,
    mergeSide: 'warehouse',
    updatedAt: new Date().toISOString(),
  };
}

/** 判断库管记录与已落库的库管版是否一致（幂等：同一份台账再送不重复；只比库管负责的架位/借出） */
function warehouseRecordMatchesBox(rec: WarehouseBoxRecord, box: CoreBox): boolean {
  return (
    rec.boxNo === box.boxNo &&
    rec.shelfPos === box.shelfPos &&
    rec.loanStatus === (box.loanStatus ?? '在库')
  );
}

/** 现场版 + 库管版按字段归属合并：现场字段取现场，库管字段取库管 */
function attributionMerge(field: CoreBox, warehouse: MergedBox): MergedBox {
  return {
    ...field,
    shelfPos: warehouse.shelfPos,
    loanStatus: warehouse.loanStatus,
    mergeSide: 'merged',
    mergeGroupId: undefined,
    mergeStatus: undefined,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 生成对账报告（纯函数，不落库）。
 * - 现场编录的回次/岩性/破损格按现场算；库架位/借出状态按库管算。
 * - 同一个箱两边都动过同一字段（相对上一版基线）→ 两版都留着让人逐条认。
 * - 同一份台账重复送达 → unchanged，不多出记录。
 */
export function buildMergeReport(
  fieldBoxes: CoreBox[],
  holes: DrillHole[],
  ledger: WarehouseLedger,
  baseline: Record<string, CoreBox> = {},
): MergeReport {
  const holeIdByNo = new Map<string, string>();
  holes.forEach((h) => holeIdByNo.set(h.holeNo, h.id));

  const fieldByBoxNo = new Map<string, CoreBox[]>();
  fieldBoxes.forEach((b) => {
    const arr = fieldByBoxNo.get(b.boxNo) ?? [];
    arr.push(b);
    fieldByBoxNo.set(b.boxNo, arr);
  });

  const whByBoxNo = new Map<string, WarehouseBoxRecord>();
  ledger.boxes.forEach((b) => whByBoxNo.set(b.boxNo, b));

  const boxNos = new Set<string>([...fieldByBoxNo.keys(), ...whByBoxNo.keys()]);
  const results: BoxMergeResult[] = [];

  boxNos.forEach((boxNo) => {
    const fieldVersions = fieldByBoxNo.get(boxNo) ?? [];
    const whRec = whByBoxNo.get(boxNo);
    results.push(mergeOne(boxNo, fieldVersions, whRec, holeIdByNo, baseline[boxNo] ?? null));
  });

  results.sort((a, b) => a.boxNo.localeCompare(b.boxNo, 'zh'));

  return {
    ledgerId: ledger.ledgerId,
    exportedAt: ledger.exportedAt,
    source: ledger.source,
    results,
    autoMerged: results.filter((r) => r.kind === 'auto-merged').length,
    conflicts: results.filter((r) => r.kind === 'conflict').length,
    fieldOnly: results.filter((r) => r.kind === 'field-only').length,
    warehouseOnly: results.filter((r) => r.kind === 'warehouse-only').length,
    unchanged: results.filter((r) => r.kind === 'unchanged').length,
  };
}

function mergeOne(
  boxNo: string,
  fieldVersions: CoreBox[],
  whRec: WarehouseBoxRecord | undefined,
  holeIdByNo: Map<string, string>,
  baseline: CoreBox | null,
): BoxMergeResult {
  // 仅库管有 → 按库管口径新增
  if (fieldVersions.length === 0 && whRec) {
    const whBox = warehouseRecordToBox(whRec, holeIdByNo);
    return {
      kind: 'warehouse-only',
      boxNo,
      warehouseBox: whBox,
      merged: whBox,
      message: '岩芯库台账有此箱、现场未登记，按库管口径新增（架位/借出状态取库管）',
    };
  }

  // 仅现场有
  if (fieldVersions.length > 0 && !whRec) {
    const pendingField = fieldVersions.find((b) => b.mergeStatus === 'pending' && b.mergeSide !== 'warehouse');
    const pendingWh = fieldVersions.find((b) => b.mergeStatus === 'pending' && b.mergeSide === 'warehouse');
    if (pendingField && pendingWh) {
      return {
        kind: 'conflict',
        boxNo,
        fieldBox: { ...(pendingField as MergedBox), loanStatus: pendingField.loanStatus ?? '在库', mergeSide: 'field' },
        warehouseBox: { ...(pendingWh as MergedBox), loanStatus: pendingWh.loanStatus ?? '在库' },
        conflictFields: conflictFieldNames(pendingField, pendingWh),
        message: '两边都动过，两版都留着待逐条认',
      };
    }
    const fieldBox = fieldVersions[0];
    return {
      kind: 'field-only',
      boxNo,
      fieldBox: { ...(fieldBox as MergedBox), loanStatus: fieldBox.loanStatus ?? '在库', mergeSide: 'field' },
      merged: { ...(fieldBox as MergedBox), loanStatus: fieldBox.loanStatus ?? '在库' },
      message: '仅现场编录，库管台账未涉及',
    };
  }

  // 两边都有
  const existingWh = fieldVersions.find((b) => b.mergeSide === 'warehouse');
  const fieldBox = fieldVersions.find((b) => b.mergeSide !== 'warehouse') ?? fieldVersions[0];

  // 库管版 = 现场编录字段（回次/岩性/破损格/结构，现场所有，库管口径以上一版基线为准）+ 库管架位/借出（库管所有）
  const buildWhVersion = (id: string, groupId?: string): MergedBox => ({
    ...(baseline ?? fieldBox),
    id,
    shelfPos: whRec!.shelfPos,
    loanStatus: whRec!.loanStatus,
    mergeSide: 'warehouse',
    mergeStatus: 'pending',
    mergeGroupId: groupId,
    updatedAt: new Date().toISOString(),
  });

  // 已是冲突两版：库管架位/借出与台账一致 → 重复送达，不多出记录
  if (existingWh && whRec && warehouseRecordMatchesBox(whRec, existingWh)) {
    return {
      kind: 'unchanged',
      boxNo,
      fieldBox: { ...(fieldBox as MergedBox), loanStatus: fieldBox.loanStatus ?? '在库' },
      warehouseBox: { ...(existingWh as MergedBox), loanStatus: existingWh.loanStatus ?? '在库' },
      message: '同一份台账重复送达，库管版无变化',
    };
  }

  // 已是冲突两版但台账更新了架位/借出 → 刷新库管版，仍挂起待认
  if (existingWh) {
    const groupId = existingWh.mergeGroupId ?? `mg-${uid('grp')}`;
    const updatedWh = buildWhVersion(existingWh.id, groupId);
    const fieldVer: MergedBox = {
      ...(fieldBox as MergedBox),
      loanStatus: fieldBox.loanStatus ?? '在库',
      mergeSide: 'field',
      mergeGroupId: groupId,
      mergeStatus: 'pending',
    };
    return {
      kind: 'conflict',
      boxNo,
      fieldBox: fieldVer,
      warehouseBox: updatedWh,
      conflictFields: conflictFieldNames(fieldVer, updatedWh),
      message: '库管台账有更新，库管版已刷新，仍需逐条认',
    };
  }

  // 普通两版：库管版以现场编录为底 + 库管架位/借出
  const whBox = buildWhVersion(uid('boxwh'));

  // 相对基线判断是否两边都动过同一字段
  const fieldChanged = changedKeys(baseline, fieldBox, ALL_KEYS);
  const whChanged = changedKeys(baseline, whBox, ALL_KEYS);
  const bothChanged = fieldChanged.filter((k) => whChanged.includes(k));

  // 相对上一版基线两边都没动 → 台账重复送达，无变化（不多出记录）
  if (baseline && fieldChanged.length === 0 && whChanged.length === 0) {
    return {
      kind: 'unchanged',
      boxNo,
      fieldBox: { ...(fieldBox as MergedBox), loanStatus: fieldBox.loanStatus ?? '在库' },
      warehouseBox: whBox,
      message: '同一份台账重复送达，两版均无变化',
    };
  }

  if (baseline && bothChanged.length > 0) {
    const groupId = `mg-${uid('grp')}`;
    const fieldVer: MergedBox = {
      ...(fieldBox as MergedBox),
      loanStatus: fieldBox.loanStatus ?? '在库',
      mergeSide: 'field',
      mergeGroupId: groupId,
      mergeStatus: 'pending',
    };
    whBox.mergeGroupId = groupId;
    return {
      kind: 'conflict',
      boxNo,
      fieldBox: fieldVer,
      warehouseBox: whBox,
      conflictFields: bothChanged,
      message: `同一个箱两边都动过（${bothChanged.map(fieldLabel).join('、')}），两版都留着待逐条认`,
    };
  }

  // 自动合并：现场字段取现场，库管字段取库管
  const merged = attributionMerge(fieldBox, whBox);
  return {
    kind: 'auto-merged',
    boxNo,
    fieldBox: { ...(fieldBox as MergedBox), loanStatus: fieldBox.loanStatus ?? '在库' },
    warehouseBox: whBox,
    merged,
    message: '现场编录 + 库管架位/借出状态，按字段归属自动合并',
  };
}

/** 两版冲突字段（用于界面逐条对比） */
function conflictFieldNames(field: CoreBox, warehouse: CoreBox): string[] {
  return ALL_KEYS.filter((k) => !valuesEqual(readField(field, k), readField(warehouse, k)));
}

/** 组装冲突两版的字段对比行（仅列出取值不同的字段） */
export function conflictRows(field: CoreBox, warehouse: CoreBox): ConflictFieldRow[] {
  return conflictFieldNames(field, warehouse).map((k) => ({
    field: k,
    label: fieldLabel(k),
    fieldValue: formatFieldValue(k, readField(field, k)),
    warehouseValue: formatFieldValue(k, readField(warehouse, k)),
  }));
}

function formatFieldValue(key: string, value: unknown): string {
  if (key === 'damagedSlots') {
    const arr = Array.isArray(value) ? (value as number[]) : [];
    return arr.length ? arr.join('、') : '无';
  }
  if (key === 'boxedAt' || key === 'updatedAt') {
    return value ? new Date(value as string).toLocaleDateString('zh-CN') : '—';
  }
  if (value === undefined || value === null || value === '') return '—';
  return String(value);
}

/** 落库后：从当前箱快照生成下一版基线（按箱号索引） */
export function buildBaseline(boxes: CoreBox[]): Record<string, CoreBox> {
  const baseline: Record<string, CoreBox> = {};
  boxes.forEach((b) => {
    // 冲突两版以现场版入基线（现场版是在编工作副本）
    if (!baseline[b.boxNo] || b.mergeSide !== 'warehouse') {
      baseline[b.boxNo] = { ...b };
    }
  });
  return baseline;
}

/** 从当前箱导出现场版岩芯库台账（供对账/送库管用） */
export function buildWarehouseLedger(boxes: CoreBox[], holes: DrillHole[]): WarehouseLedger {
  const holeNoById = new Map<string, string>();
  holes.forEach((h) => holeNoById.set(h.id, h.holeNo));
  const records: WarehouseBoxRecord[] = boxes
    .filter((b) => b.mergeSide !== 'warehouse' || b.mergeStatus !== 'pending')
    .map((b) => ({
      boxNo: b.boxNo,
      holeNo: b.holeId ? holeNoById.get(b.holeId) ?? '' : '',
      shelfPos: b.shelfPos,
      loanStatus: (b.loanStatus ?? '在库') as LoanStatus,
      fromDepth: b.fromDepth,
      toDepth: b.toDepth,
      slots: b.slots,
      slotLength: b.slotLength,
      boxedAt: b.boxedAt,
      remark: b.remark,
    }));
  return {
    app: WAREHOUSE_APP_TAG,
    ledgerId: `ledger-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`,
    exportedAt: new Date().toISOString(),
    source: '现场编目台',
    boxes: records,
  };
}

/** 台账序列化为 JSON 文本 */
export function serializeLedger(ledger: WarehouseLedger): string {
  return JSON.stringify(ledger, null, 2);
}

/** 字段归属（供界面展示口径说明） */
export const FIELD_OWNED_LABEL = '回次 / 岩性 / 破损格 / 结构（现场算）';
export const WAREHOUSE_OWNED_LABEL = '库架位 / 借出状态（岩芯库算）';
