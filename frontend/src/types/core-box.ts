/** 借出状态（岩芯库台账维护） */
export type LoanStatus = '在库' | '借出' | '归还中';

/** 岩芯箱 */
export interface CoreBox {
  id: string;
  /** 箱号 */
  boxNo: string;
  /** 所属钻孔 */
  holeId: string;
  /** 起始深度（m） */
  fromDepth: number;
  /** 终止深度（m） */
  toDepth: number;
  /** 格数 */
  slots: number;
  /** 每格长度（m） */
  slotLength: number;
  /** 装箱日期 ISO */
  boxedAt: string;
  /** 库架位（岩芯库台账为准） */
  shelfPos: string;
  /** 借出状态（岩芯库台账为准） */
  loanStatus: LoanStatus;
  /** 借出人，在库时为空 */
  loanTo?: string;
  /** 借出/归还时间 ISO，在库时为空 */
  loanedAt?: string;
  /** 箱内回次（现场编录为准），多个用逗号分隔，如 2401-17,2401-18 */
  runNo?: string;
  /** 箱内主要岩性（现场编录为准） */
  lithology?: string;
  /** 破损格（格序号，从 1 开始，现场编录为准） */
  damagedSlots: number[];
  /** 装箱人 */
  operator: string;
  /** 备注 */
  remark?: string;
}

/** 岩芯箱与回次的连续性校验结果 */
export interface BoxContinuity {
  box: CoreBox;
  /** 区间是否被回次完整覆盖 */
  covered: boolean;
  /** 断档区间（未被回次覆盖的深度段） */
  gaps: Array<{ from: number; to: number }>;
  /** 提示文案 */
  message: string;
}

export const SHELF_POSITIONS: string[] = ['A 区 1 架', 'A 区 2 架', 'B 区 1 架', 'B 区 2 架', 'C 区 1 架'];

export const LOAN_STATUSES: LoanStatus[] = ['在库', '借出', '归还中'];

export const LOAN_STATUS_COLOR: Record<LoanStatus, string> = {
  在库: 'green',
  借出: 'red',
  归还中: 'orange',
};
