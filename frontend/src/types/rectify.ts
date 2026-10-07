import type { Revisioned } from './persistence';

/** 整改状态：待整改 / 已复核 */
export type RectifyState = 'pending' | 'reviewed';

export const RECTIFY_STATE_LABEL: Record<RectifyState, string> = {
  pending: '待整改',
  reviewed: '已复核',
};

/** 年检整改单 */
export interface Rectify extends Revisioned {
  id: string;
  /** 所属电梯 */
  elevatorId: string;
  /** 不合格项 */
  item: string;
  /** 限期 yyyy-MM-dd */
  dueDate: string;
  /** 状态 */
  state: RectifyState;
  /** 复核人 */
  reviewer: string;
  /** 复核时间 */
  reviewedAt: string | null;
  /**
   * 来源保养计划（异常项一键转整改时回写）。
   * 手工登记、历史数据或导入的旧单没有来源，恒为 null。
   * 仅用于追溯，不参与电梯状态判定——电梯状态按该电梯「全部未复核单」统计。
   */
  sourcePlanId: string | null;
  /** 来源保养项（异常项一键转整改时回写），无来源为 null */
  sourceItemId: string | null;
  createdAt: string;
}

/** 整改单草稿 */
export interface RectifyDraft {
  elevatorId: string;
  item: string;
  dueDate: string;
  reviewer: string;
}

/** 整改单视图：带电梯上下文与超期天数 */
export interface RectifyView extends Rectify {
  elevatorName: string;
  owner: string;
  /** 是否超期（未复核且限期早于今天） */
  overdue: boolean;
  /** 超期天数（未超期为 0） */
  overdueDays: number;
  /** 来源标签：保养异常转来 / 手工登记 */
  sourceLabel: string;
}

/** 年检不合格项字典 */
export const RECTIFY_ITEM_LIBRARY: string[] = [
  '限速器动作速度超差',
  '层门门锁啮合深度不足',
  '制动器制动力矩不足',
  '缓冲器复位异常',
  '钢丝绳断丝超标',
  '轿厢应急照明失效',
  '超载保护装置失灵',
  '机房通风不符合要求',
];

/** 超期天数计算 */
export function overdueDaysOf(dueDate: string, state: RectifyState, now: Date = new Date()): number {
  if (state === 'reviewed') return 0;
  const due = new Date(`${dueDate}T23:59:59`);
  if (Number.isNaN(due.getTime())) return 0;
  const diff = now.getTime() - due.getTime();
  if (diff <= 0) return 0;
  return Math.ceil(diff / (24 * 3600 * 1000));
}

/**
 * 是否为剩余未复核（待整改）单。
 * 口径只看状态本身，与来源（sourcePlanId / sourceItemId）无关：
 * 判定电梯状态时必须计入该电梯「全部」未复核单——
 * 若只按本次异常项转来的来源过滤，会漏掉历史旧单，导致电梯错误显示正常。
 */
export function isPendingRectify(rectify: Pick<Rectify, 'state'>): boolean {
  return rectify.state === 'pending';
}

/**
 * 统计某台电梯的剩余未复核项数量。
 * @param rectifies 全部整改单（调用方无需预先按来源过滤；旧单 / 无来源单一并计入）
 * @param elevatorId 目标电梯
 */
export function pendingRectifyCountOf(
  rectifies: ReadonlyArray<Pick<Rectify, 'elevatorId' | 'state'>>,
  elevatorId: string,
): number {
  return rectifies.filter(
    (rectify) => rectify.elevatorId === elevatorId && rectify.state === 'pending',
  ).length;
}

/** 来源标签：异常项转来的单可追溯到保养计划，其余为手工 / 历史登记 */
export function rectifySourceLabel(rectify: Pick<Rectify, 'sourcePlanId'>): string {
  return rectify.sourcePlanId ? '保养异常转来' : '手工登记';
}
