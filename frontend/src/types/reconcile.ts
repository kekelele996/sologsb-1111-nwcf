import type { CoreBox, LoanStatus } from './core-box';

/** 合并时两侧同改、无法自动消解的处置偏好 */
export type ReconcileMode =
  | /** 严格：两侧同改的箱子不自动入库，两版都挂起等人认 */ 'strict'
  | /** 侧重试：按侧重自动消解（现场/岩芯库），仍保留两版留痕 */ 'prefer-field'
  | 'prefer-store';

/** 字段归属：现场编录 / 岩芯库台账 / 两侧共有 */
export type FieldOwner = 'field' | 'store' | 'shared';

/** 一条待人工认领的字段级分歧 */
export interface FieldConflict {
  field: keyof CoreBox;
  label: string;
  owner: FieldOwner;
  /** 上一版（合并基准）的值，首版对账时为 null */
  base: unknown;
  /** 现场离线版的值 */
  fieldValue: unknown;
  /** 岩芯库台账版的值 */
  storeValue: unknown;
  /** 自动消解取值侧（仅侧重试时有），严格挂起时为 null */
  resolvedBy: Exclude<ReconcileMode, 'strict'> | null;
}

/** 两版同留：一个岩芯箱两侧都动过时生成的对账分歧 */
export interface BoxConflict {
  /** 冲突标识：conflict-<归一化箱号>，同一箱重复对账稳定复用 */
  id: string;
  /** 箱号（对账匹配键） */
  boxNo: string;
  /** 分歧字段 */
  fields: FieldConflict[];
  /** 现场离线版（完整快照） */
  fieldVersion: CoreBox | null;
  /** 岩芯库台账版（完整快照） */
  storeVersion: CoreBox | null;
  /** 上一版（合并基准，首版为 null） */
  baseVersion: CoreBox | null;
  /** pending=等人认；resolved=已消解（自动侧重或人工确认） */
  status: 'pending' | 'resolved';
  /** 是否由人工逐条确认（true 才会在后续对账中沿用；自动侧重消解为 false，不短路新台账） */
  manual?: boolean;
  /** 已确认入库的版本（resolved 后），便于追溯 */
  resolvedVersion?: CoreBox;
  createdAt: string;
  updatedAt: string;
}

/** 岩芯库出入库台账中的一行（库侧只保证库管字段齐全） */
export interface StoreBoxRow {
  boxNo: string;
  holeId?: string;
  shelfPos?: string;
  loanStatus?: LoanStatus;
  loanTo?: string;
  loanedAt?: string;
  fromDepth?: number;
  toDepth?: number;
  /** 允许台账里只记箱号 + 库架位/借出状态，其余缺省 */
  [key: string]: unknown;
}

/** 岩芯库台账文件（可被解析的 JSON 结构） */
export interface StoreLedger {
  app?: string;
  /** 台账批次号，用于幂等；缺失时以内容指纹兜底 */
  batchId?: string;
  exportedAt?: string;
  boxes: StoreBoxRow[];
}

/** 对账结果（纯函数输出，不落库） */
export interface ReconcileResult {
  mode: ReconcileMode;
  /** 对账后应写入的岩芯箱全集 */
  mergedBoxes: CoreBox[];
  /** 两版同留的分歧（严格挂起 + 侧重试自动消解留痕） */
  conflicts: BoxConflict[];
  /** 仅现场有、台账没有的箱号（保留现场版，未删） */
  fieldOnly: string[];
  /** 仅台账有、本地没有的箱号（已按台账补建） */
  storeOnly: string[];
  /** 两侧都有、字段完全一致、未发生改动的箱号 */
  unchanged: string[];
  /** 两侧都有、按归属干净合并的箱号 */
  cleanMerged: string[];
  /** 数据问题提示（箱号缺失、重复等，不中断对账） */
  warnings: string[];
  stats: {
    total: number;
    merged: number;
    conflicts: number;
    autoResolved: number;
    fieldOnly: number;
    storeOnly: number;
  };
}
