import type { CoreBox, LoanStatus, MergeSide, MergeStatus } from './core-box';

/** 岩芯库出入库台账的应用标记（导入时校验） */
export const WAREHOUSE_APP_TAG = 'gbdrillcore-warehouse';

/** 岩芯库台账中的一条箱记录（库管口径：架位 + 借出状态） */
export interface WarehouseBoxRecord {
  /** 箱号（与现场编录对账的主键） */
  boxNo: string;
  /** 孔号（库管只记孔号，导入时按孔号匹配现场钻孔） */
  holeNo?: string;
  /** 库架位（库管口径，合并时以库管为准） */
  shelfPos: string;
  /** 借出状态（库管口径，合并时以库管为准） */
  loanStatus: LoanStatus;
  /** 以下为结构字段，库管可能也有一份，合并时以现场为准 */
  fromDepth?: number;
  toDepth?: number;
  slots?: number;
  slotLength?: number;
  boxedAt?: string;
  remark?: string;
}

/** 岩芯库出入库台账（现场离线箱与库管台账对账的依据） */
export interface WarehouseLedger {
  app: typeof WAREHOUSE_APP_TAG;
  /** 台账批次号（幂等：同一份台账再送不重复落库） */
  ledgerId: string;
  /** 导出时间 ISO */
  exportedAt: string;
  /** 台账来源（如：岩芯库） */
  source?: string;
  boxes: WarehouseBoxRecord[];
}

/** 合并后落库的箱：在现场箱基础上带出库管口径字段与对账标记 */
export interface MergedBox extends CoreBox {
  loanStatus: LoanStatus;
  mergeSide: MergeSide;
}

/** 单箱对账结果分类 */
export type MergeKind =
  | 'auto-merged' // 两边各管各的字段，自动合并
  | 'conflict' // 同一个箱两边都动过，两版都留着让人逐条认
  | 'field-only' // 仅现场有（库管台账未涉及）
  | 'warehouse-only' // 仅库管有（现场未登记，按库管口径新增）
  | 'unchanged'; // 台账重复送达，无变化

/** 单个箱的对账结果 */
export interface BoxMergeResult {
  kind: MergeKind;
  boxNo: string;
  /** 现场版（field-only / conflict 的现场版） */
  fieldBox?: MergedBox;
  /** 库管版（warehouse-only / conflict 的库管版） */
  warehouseBox?: MergedBox;
  /** 自动合并 / 仅现场 / 仅库管 时落库的唯一一版 */
  merged?: MergedBox;
  /** 两边都动过的字段（冲突字段） */
  conflictFields?: string[];
  /** 提示文案 */
  message: string;
}

/** 整份台账的对账报告 */
export interface MergeReport {
  ledgerId: string;
  exportedAt: string;
  source?: string;
  results: BoxMergeResult[];
  autoMerged: number;
  conflicts: number;
  fieldOnly: number;
  warehouseOnly: number;
  unchanged: number;
}

/** 冲突箱两版对比用的字段行 */
export interface ConflictFieldRow {
  field: string;
  label: string;
  fieldValue: string;
  warehouseValue: string;
}

export type { LoanStatus, MergeSide, MergeStatus };
