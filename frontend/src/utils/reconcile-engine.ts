import type { CoreBox, LoanStatus } from '../types/core-box';
import { uid } from './id';
import type {
  BoxConflict,
  FieldConflict,
  FieldOwner,
  ReconcileMode,
  ReconcileResult,
  StoreBoxRow,
  StoreLedger,
} from '../types/reconcile';

/**
 * 字段归属：
 * - field  现场编录为准（回次、岩性、破损格，以及装箱深度/格数/装箱人等现场录入项）
 * - store  岩芯库台账为准（库架位、借出状态）
 * - shared 两侧共有（箱号、钻孔、深度等身份/区间字段），两侧同改且不一致时挂起
 */
export const FIELD_OWNER: Record<keyof CoreBox, FieldOwner> = {
  id: 'shared',
  boxNo: 'shared',
  holeId: 'shared',
  fromDepth: 'shared',
  toDepth: 'shared',
  slots: 'field',
  slotLength: 'field',
  boxedAt: 'field',
  shelfPos: 'store',
  loanStatus: 'store',
  loanTo: 'store',
  loanedAt: 'store',
  runNo: 'field',
  lithology: 'field',
  damagedSlots: 'field',
  operator: 'field',
  remark: 'field',
};

/** 字段中文标签（分歧面板用） */
export const FIELD_LABELS: Record<keyof CoreBox, string> = {
  id: '记录 ID',
  boxNo: '箱号',
  holeId: '所属钻孔',
  fromDepth: '起始深度',
  toDepth: '终止深度',
  slots: '格数',
  slotLength: '每格长度',
  boxedAt: '装箱日期',
  shelfPos: '库架位',
  loanStatus: '借出状态',
  loanTo: '借出人',
  loanedAt: '借出时间',
  runNo: '回次',
  lithology: '岩性',
  damagedSlots: '破损格',
  operator: '装箱人',
  remark: '备注',
};

/** 现场为准的字段 */
export const FIELD_KEYS = (Object.keys(FIELD_OWNER) as Array<keyof CoreBox>).filter((k) => FIELD_OWNER[k] === 'field');
/** 岩芯库为准的字段 */
export const STORE_KEYS = (Object.keys(FIELD_OWNER) as Array<keyof CoreBox>).filter((k) => FIELD_OWNER[k] === 'store');
/** 两侧共有、需对比的身份/区间字段（id 不参与，由匹配键决定） */
export const SHARED_KEYS = (Object.keys(FIELD_OWNER) as Array<keyof CoreBox>).filter(
  (k) => FIELD_OWNER[k] === 'shared' && k !== 'id',
);

/** 数值/数组归一化，避免 "5" 与 5、[4] 与 "4" 这类伪差异 */
function normalize(field: keyof CoreBox, raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  switch (field) {
    case 'fromDepth':
    case 'toDepth':
    case 'slots':
    case 'slotLength': {
      const n = Number(raw);
      return Number.isFinite(n) ? Number(n.toFixed(2)) : undefined;
    }
    case 'damagedSlots': {
      if (Array.isArray(raw)) {
        return [...new Set(raw.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0))].sort((a, b) => a - b);
      }
      if (typeof raw === 'string') {
        return [...new Set(raw.split(/[,，\s]+/).map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0))].sort(
          (a, b) => a - b,
        );
      }
      return undefined;
    }
    case 'runNo':
    case 'lithology':
    case 'shelfPos':
    case 'loanTo':
    case 'loanedAt':
    case 'boxedAt':
    case 'operator':
    case 'remark':
    case 'boxNo':
    case 'holeId': {
      const s = String(raw).trim();
      return s === '' ? undefined : s;
    }
    case 'loanStatus': {
      const s = String(raw).trim();
      return (['在库', '借出', '归还中'] as LoanStatus[]).includes(s as LoanStatus) ? (s as LoanStatus) : undefined;
    }
    default:
      return raw;
  }
}

/** 统一“空”的表示，便于比较 */
function emptyOf(v: unknown): unknown {
  if (v === undefined || v === null || v === '') return undefined;
  if (Array.isArray(v) && v.length === 0) return undefined;
  return v;
}

/** 值是否一致（按归一化后比较） */
function sameValue(a: unknown, b: unknown): boolean {
  const x = emptyOf(a);
  const y = emptyOf(b);
  if (Array.isArray(x) && Array.isArray(y)) return x.length === y.length && x.every((v, i) => v === y[i]);
  return x === y;
}

export function normalizeBoxNo(boxNo: unknown): string {
  return String(boxNo ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

/** 按字段名读取岩芯箱/台账行的值（统一走这里，规避无索引签名的强转） */
function fieldOf(record: Partial<CoreBox> | Record<string, unknown>, field: keyof CoreBox): unknown {
  return (record as Record<string, unknown>)[field as string];
}

/** 按字段名写入归一化后的值 */
function setField(record: CoreBox, field: keyof CoreBox, value: unknown): void {
  (record as unknown as Record<string, unknown>)[field as string] = value;
}

/** 台账行 → 归一化的库侧记录（库行允许只带库管字段） */
export function normalizeStoreRow(row: StoreBoxRow): Partial<CoreBox> & { boxNo: string } {
  const out: Record<string, unknown> = { boxNo: String(row.boxNo ?? '').trim() };
  (Object.keys(FIELD_OWNER) as Array<keyof CoreBox>).forEach((field) => {
    if (field === 'id' || field === 'boxNo') return;
    if (row[field] !== undefined) {
      const v = normalize(field, row[field]);
      if (v !== undefined) out[field] = v;
    }
  });
  return out as Partial<CoreBox> & { boxNo: string };
}

/**
 * 解析岩芯库台账 JSON。
 * 兼容两种形态：{ boxes: [...] } 与直接的数组 [...]。
 */
export function parseStoreLedger(text: string): StoreLedger {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('台账不是合法 JSON');
  }
  const listRaw: unknown = Array.isArray(data) ? data : (data as { boxes?: unknown[] })?.boxes;
  if (!Array.isArray(listRaw)) {
    throw new Error('台账结构不匹配：需要 { "boxes": [...] } 或数组');
  }
  const header = (Array.isArray(data) ? {} : (data as Omit<StoreLedger, 'boxes'>)) ?? {};
  return { ...header, boxes: listRaw as StoreBoxRow[] };
}

/** 内容指纹（FNV-1a 32 位），台账无批次号时用于幂等去重 */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fp-${(hash >>> 0).toString(16).padStart(8, '0')}-${text.length}`;
}

/** 仅台账有箱号时，按库侧记录补建一条（现场字段留空）的岩芯箱 */
function buildStoreOnlyBox(row: Partial<CoreBox> & { boxNo: string }, keepId?: string): CoreBox {
  return {
    id: keepId ?? uid('box'),
    boxNo: row.boxNo,
    holeId: (row.holeId as string) ?? '',
    fromDepth: (row.fromDepth as number) ?? 0,
    toDepth: (row.toDepth as number) ?? 0,
    slots: (row.slots as number) ?? 0,
    slotLength: (row.slotLength as number) ?? 0,
    boxedAt: (row.boxedAt as string) ?? new Date(0).toISOString(),
    shelfPos: (row.shelfPos as string) ?? '',
    loanStatus: (row.loanStatus as LoanStatus) ?? '在库',
    loanTo: row.loanTo as string | undefined,
    loanedAt: row.loanedAt as string | undefined,
    runNo: row.runNo as string | undefined,
    lithology: row.lithology as string | undefined,
    damagedSlots: (row.damagedSlots as number[]) ?? [],
    operator: (row.operator as string) ?? '',
    remark: row.remark as string | undefined,
  };
}

export interface ReconcileInput {
  /** 本地岩芯箱（现场笔记本，即现场版） */
  localBoxes: CoreBox[];
  /** 岩芯库出入库台账 */
  ledger: StoreLedger;
  /**
   * 上一版已合并结果（三向合并基准）。首次对账为空：
   * 此时两侧不存在“都动过”，直接按归属合并，不产生挂起。
   */
  baselineBoxes?: CoreBox[];
  mode?: ReconcileMode;
  /** 上一版遗留分歧（已人工 resolved 的认领结果沿用，pending 记录保留以更新两版） */
  prevConflicts?: BoxConflict[];
}

/**
 * 纯函数三向对账。
 * - 回次/岩性/破损格等现场字段以现场为准；
 * - 库架位/借出状态等库管字段以台账为准；
 * - 同一箱两侧都改了同一字段且不一致 → 两版都留：strict 挂起等人认，prefer-* 按侧重试自动消解并留痕。
 */
export function reconcileBoxes(input: ReconcileInput): ReconcileResult {
  const { localBoxes, ledger, baselineBoxes = [], mode = 'strict', prevConflicts = [] } = input;
  const warnings: string[] = [];
  const nowIso = new Date().toISOString();

  const indexByBoxNo = (boxes: CoreBox[]) => {
    const map = new Map<string, CoreBox>();
    boxes.forEach((box) => {
      const key = normalizeBoxNo(box.boxNo);
      if (!key) {
        warnings.push(`存在箱号为空的记录（id=${box.id}），已跳过对账`);
        return;
      }
      if (!map.has(key)) map.set(key, box);
      else warnings.push(`箱号 ${box.boxNo} 重复，以先出现的一条为准`);
    });
    return map;
  };

  const fieldMap = indexByBoxNo(localBoxes);
  const baseMap = indexByBoxNo(baselineBoxes);

  // 台账行归一化 + 去重
  const storeMap = new Map<string, Partial<CoreBox> & { boxNo: string }>();
  ledger.boxes.forEach((row, idx) => {
    const key = normalizeBoxNo(row?.boxNo);
    if (!key) {
      warnings.push(`台账第 ${idx + 1} 行箱号为空，已跳过`);
      return;
    }
    if (!storeMap.has(key)) storeMap.set(key, normalizeStoreRow({ ...row, boxNo: key }));
    else warnings.push(`台账箱号 ${row.boxNo} 重复，以先出现的一条为准`);
  });

  // 仅“人工确认”的分歧沿用到后续对账；自动侧重消解不短路（新台账仍可继续合并）
  const resolvedMap = new Map<string, CoreBox>();
  prevConflicts
    .filter((c) => c.status === 'resolved' && c.manual && c.resolvedVersion)
    .forEach((c) => resolvedMap.set(normalizeBoxNo(c.boxNo), c.resolvedVersion as CoreBox));

  const mergedBoxes: CoreBox[] = [];
  const conflicts: BoxConflict[] = [];
  const fieldOnly: string[] = [];
  const storeOnly: string[] = [];
  const unchanged: string[] = [];
  const cleanMerged: string[] = [];
  let autoResolved = 0;

  const allKeys = new Set<string>([...fieldMap.keys(), ...storeMap.keys()]);

  allKeys.forEach((key) => {
    const fieldBox = fieldMap.get(key);
    const storeRow = storeMap.get(key);
    const baseBox = baseMap.get(key);

    // 仅现场有：原样保留，绝不因台账缺失而删除
    if (fieldBox && !storeRow) {
      mergedBoxes.push(fieldBox);
      fieldOnly.push(fieldBox.boxNo);
      return;
    }

    // 仅台账有：按台账补建
    if (!fieldBox && storeRow) {
      mergedBoxes.push(buildStoreOnlyBox(storeRow));
      storeOnly.push(storeRow.boxNo);
      return;
    }
    if (!fieldBox || !storeRow) return; // 理论不可达

    // 上一版已人工确认：沿用确认后的版本
    const priorResolved = resolvedMap.get(key);
    if (priorResolved) {
      mergedBoxes.push(priorResolved);
      cleanMerged.push(fieldBox.boxNo);
      return;
    }

    const fieldVersion: CoreBox = { ...fieldBox };
    const storeVersion: CoreBox = buildStoreOnlyBox({ ...storeRow, boxNo: fieldBox.boxNo }, fieldBox.id);
    const merged: CoreBox = { ...fieldBox };
    const fieldConflicts: FieldConflict[] = [];

    let anySideChanged = false;

    /**
     * 确定性归属字段：属主方永远赢，不产生阻塞。
     * - field 字段：现场有值取现场，现场为空才用台账兜底；
     * - store 字段：台账带了就取台账，台账没带维持现状。
     * 属主字段即便两侧都改，也按规则自动收敛，不需要人认。
     */
    const applyOwned = (f: keyof CoreBox, owner: 'field' | 'store') => {
      const bv = baseBox ? normalize(f, fieldOf(baseBox, f)) : undefined;
      const fv = normalize(f, fieldOf(fieldBox, f));
      const storeHas = fieldOf(storeRow, f) !== undefined;
      const sv = storeHas ? normalize(f, fieldOf(storeRow, f)) : undefined;
      const fieldChanged = baseBox ? !sameValue(fv, bv) : fv !== undefined;
      const storeChanged = baseBox ? storeHas && !sameValue(sv, bv) : storeHas;
      if (fieldChanged || storeChanged) anySideChanged = true;

      if (owner === 'field') {
        setField(merged, f, fv !== undefined ? fv : sv !== undefined ? sv : bv);
      } else {
        setField(merged, f, storeHas && sv !== undefined ? sv : fv !== undefined ? fv : bv);
      }
    };

    FIELD_KEYS.forEach((f) => applyOwned(f, 'field'));
    STORE_KEYS.forEach((f) => applyOwned(f, 'store'));

    // 共有/身份字段：三向合并，两侧改成不同值才是真正要“两版都留”的分歧
    SHARED_KEYS.forEach((f) => {
      const bv = baseBox ? normalize(f, fieldOf(baseBox, f)) : undefined;
      const fv = normalize(f, fieldOf(fieldBox, f));
      const storeHas = fieldOf(storeRow, f) !== undefined;
      const sv = storeHas ? normalize(f, fieldOf(storeRow, f)) : undefined;

      const fieldChanged = baseBox ? !sameValue(fv, bv) : false;
      const storeChanged = baseBox ? storeHas && !sameValue(sv, bv) : storeHas;

      if (fieldChanged || storeChanged) anySideChanged = true;

      if (!baseBox) {
        // 首次对账无基准：不视为“两边都动过”，保留现场（笔记本为合并目标），不挂起
        setField(merged, f, fv !== undefined ? fv : sv);
        return;
      }

      // 只一侧改动 → 取改动侧；都没改 → 维持基准
      if (fieldChanged && !storeChanged) {
        setField(merged, f, fv);
        return;
      }
      if (storeChanged && !fieldChanged) {
        setField(merged, f, sv);
        return;
      }
      if (!fieldChanged && !storeChanged) {
        setField(merged, f, bv);
        return;
      }

      // 两侧都改、改成同一个值 → 干净收敛
      if (sameValue(fv, sv)) {
        setField(merged, f, fv);
        return;
      }

      // 两侧改成不同值 → 两版都留
      const fc: FieldConflict = {
        field: f,
        label: FIELD_LABELS[f],
        owner: 'shared',
        base: emptyOf(bv) ?? null,
        fieldValue: emptyOf(fv) ?? null,
        storeValue: emptyOf(sv) ?? null,
        resolvedBy: null,
      };

      if (mode === 'strict') {
        // 挂起：整箱保住上一版基准，该字段维持基准值，等人一条条认
        setField(merged, f, bv);
      } else {
        // 侧重试：共有字段按侧重自动取值，两版与取舍仍留痕
        fc.resolvedBy = mode;
        setField(merged, f, mode === 'prefer-field' ? fv : sv);
      }
      fieldConflicts.push(fc);
    });

    const conflictId = `conflict-${key}`;
    const prior = prevConflicts.find((c) => c.id === conflictId);

    if (fieldConflicts.length === 0) {
      mergedBoxes.push(merged);
      if (anySideChanged) cleanMerged.push(fieldBox.boxNo);
      else unchanged.push(fieldBox.boxNo);
      return;
    }

    if (mode === 'strict') {
      // 整箱保住上一版结果（baseBox 一定存在，因为冲突只可能在有基准时出现）
      mergedBoxes.push(baseBox as CoreBox);
      conflicts.push({
        id: conflictId,
        boxNo: fieldBox.boxNo,
        fields: fieldConflicts,
        fieldVersion,
        storeVersion,
        baseVersion: baseBox as CoreBox,
        status: 'pending',
        manual: false,
        createdAt: prior?.createdAt ?? nowIso,
        updatedAt: nowIso,
      });
    } else {
      mergedBoxes.push(merged);
      autoResolved += 1;
      conflicts.push({
        id: conflictId,
        boxNo: fieldBox.boxNo,
        fields: fieldConflicts,
        fieldVersion,
        storeVersion,
        baseVersion: baseBox as CoreBox,
        // 侧重试已自动消解入库：resolved 但 manual=false（仍可让人复核改判；下轮对账不短路）
        status: 'resolved',
        manual: false,
        resolvedVersion: merged,
        createdAt: prior?.createdAt ?? nowIso,
        updatedAt: nowIso,
      });
      cleanMerged.push(fieldBox.boxNo);
    }
  });

  const pendingCount = conflicts.filter((c) => c.status === 'pending').length;

  return {
    mode,
    mergedBoxes: mergedBoxes.sort((a, b) => a.boxNo.localeCompare(b.boxNo)),
    conflicts,
    fieldOnly,
    storeOnly,
    unchanged,
    cleanMerged,
    warnings,
    stats: {
      total: allKeys.size,
      merged: cleanMerged.length + fieldOnly.length + storeOnly.length,
      conflicts: pendingCount,
      autoResolved,
      fieldOnly: fieldOnly.length,
      storeOnly: storeOnly.length,
    },
  };
}

/**
 * 人工认领：把一个待认分歧的逐字段取舍合成为最终版本。
 * picks 指定每个分歧字段取 'field' | 'store'；未给的字段按归属兜底（现场字段归现场、库管字段归库）。
 */
export function resolveConflict(conflict: BoxConflict, picks: Partial<Record<keyof CoreBox, 'field' | 'store'>>): CoreBox {
  const resolved: CoreBox = { ...(conflict.baseVersion ?? conflict.fieldVersion ?? conflict.storeVersion!) };
  conflict.fields.forEach((fc) => {
    const side = picks[fc.field] ?? (fc.owner === 'store' ? 'store' : 'field');
    const chosen = side === 'field' ? fc.fieldValue : fc.storeValue;
    const v = normalize(fc.field, chosen);
    if (v !== undefined) setField(resolved, fc.field, v);
  });
  return resolved;
}
