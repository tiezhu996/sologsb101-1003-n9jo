/**
 * 年检整改状态（Pinia）
 * 维护整改单跟踪、复核关闭与超期预警派生值。
 */
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  ROW_REVISION,
  listElevators,
  listRectifies,
  putRectify,
  listCheckItems,
  removeRectify,
  type CheckItemRow,
  type ElevatorRow,
  type RectifyRow,
} from '../utils/db';
import {
  overdueDaysOf,
  pendingRectifyCountOf,
  rectifySourceLabel,
  type RectifyDraft,
  type RectifyView,
} from '../types/rectify';
import { nowDateTime } from '../utils/duration';
import { uuid } from '../utils/export';
import { emitChange, onChange } from '../utils/events';

export const useRectifyStore = defineStore('rectify', () => {
  const rectifies = ref<RectifyRow[]>([]);
  const elevators = ref<ElevatorRow[]>([]);
  const loading = ref(false);
  const error = ref('');
  const initialized = ref(false);
  let subscribed = false;

  async function load(): Promise<void> {
    loading.value = true;
    try {
      const [rectifyRows, elevatorRows] = await Promise.all([listRectifies(), listElevators()]);
      rectifies.value = rectifyRows;
      elevators.value = elevatorRows;
      error.value = '';
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '整改单读取失败';
    } finally {
      loading.value = false;
    }
  }

  async function bootstrap(): Promise<void> {
    if (!initialized.value) initialized.value = true;
    if (!subscribed) {
      subscribed = true;
      onChange(() => {
        void load();
      });
    }
    await load();
  }

  async function createRectify(
    draft: RectifyDraft,
    source: { planId?: string | null; itemId?: string | null } = {},
  ): Promise<RectifyRow> {
    const row: RectifyRow = {
      id: uuid(),
      elevatorId: draft.elevatorId,
      item: draft.item.trim(),
      dueDate: draft.dueDate,
      state: 'pending',
      reviewer: draft.reviewer.trim(),
      reviewedAt: null,
      // 仅异常项一键转整改带来源；手工登记单为 null。来源只用于追溯，不参与状态判定。
      sourcePlanId: source.planId ?? null,
      sourceItemId: source.itemId ?? null,
      createdAt: nowDateTime(),
      revision: ROW_REVISION,
    };
    await putRectify(row);
    emitChange();
    return row;
  }

  async function updateRectify(id: string, draft: RectifyDraft): Promise<void> {
    const existing = rectifies.value.find((item) => item.id === id);
    if (!existing) return;
    await putRectify({
      ...existing,
      elevatorId: draft.elevatorId,
      item: draft.item.trim(),
      dueDate: draft.dueDate,
      reviewer: draft.reviewer.trim(),
    });
    emitChange();
  }

  /** 复核通过：关闭整改单并回写复核人与时间 */
  async function review(id: string, reviewer: string): Promise<void> {
    const existing = rectifies.value.find((item) => item.id === id);
    if (!existing) return;
    await putRectify({
      ...existing,
      state: 'reviewed',
      reviewer: reviewer.trim() || existing.reviewer,
      reviewedAt: nowDateTime(),
    });
    emitChange();
  }

  /** 撤销复核：退回待整改 */
  async function revokeReview(id: string): Promise<void> {
    const existing = rectifies.value.find((item) => item.id === id);
    if (!existing) return;
    await putRectify({ ...existing, state: 'pending', reviewedAt: null });
    emitChange();
  }

  async function deleteRectify(id: string): Promise<void> {
    await removeRectify(id);
    emitChange();
  }

  /**
   * 由保养异常项一键转整改单（调用方传入电梯与计划上下文，避免反向依赖）。
   * 同电梯同项目已存在待整改单时跳过，返回实际新建数量。
   */
  async function promoteAbnormalItems(
    elevatorId: string,
    planId: string,
    dueDate: string,
    reviewer: string,
  ): Promise<number> {
    const items: CheckItemRow[] = await listCheckItems();
    const targets = items.filter(
      (item) => item.planId === planId && (item.result === 'abnormal' || item.result === 'advice'),
    );
    let created = 0;
    for (const item of targets) {
      const exists = rectifies.value.some(
        (row) => row.elevatorId === elevatorId && row.item === item.itemName && row.state === 'pending',
      );
      if (exists) continue;
      await createRectify(
        { elevatorId, item: item.itemName, dueDate, reviewer },
        { planId, itemId: item.id },
      );
      created += 1;
    }
    return created;
  }

  /** 整改单视图：附电梯上下文、超期天数与来源标签 */
  const rectifyViews = computed<RectifyView[]>(() =>
    rectifies.value.map((row) => {
      const elevator = elevators.value.find((item) => item.id === row.elevatorId);
      const days = overdueDaysOf(row.dueDate, row.state);
      return {
        ...row,
        elevatorName: elevator ? `${elevator.regCode}（${elevator.owner}）` : '已删除电梯',
        owner: elevator?.owner ?? '-',
        overdue: days > 0,
        overdueDays: days,
        sourceLabel: rectifySourceLabel(row),
      };
    }),
  );

  /**
   * 每台电梯的剩余未复核项数（电梯 ID → 数量）。
   * 口径：该电梯「全部」state=pending 的整改单，包含无来源的手工 / 历史旧单。
   * 复核、撤销复核、移除、编辑换电梯都会触发重新拉取，此派生值随之重算。
   */
  const pendingCountByElevator = computed<Map<string, number>>(() => {
    const map = new Map<string, number>();
    for (const elevator of elevators.value) {
      map.set(elevator.id, pendingRectifyCountOf(rectifies.value, elevator.id));
    }
    return map;
  });

  /** 查询单台电梯的剩余未复核项数（旧单 / 无来源单一并计入） */
  function pendingCountOfElevator(elevatorId: string): number {
    return pendingCountByElevator.value.get(elevatorId) ?? pendingRectifyCountOf(rectifies.value, elevatorId);
  }

  const pendingViews = computed(() => rectifyViews.value.filter((item) => item.state === 'pending'));
  const overdueViews = computed(() =>
    rectifyViews.value
      .filter((item) => item.overdue)
      .sort((a, b) => b.overdueDays - a.overdueDays),
  );
  const reviewedViews = computed(() => rectifyViews.value.filter((item) => item.state === 'reviewed'));

  const reviewRate = computed(() => {
    if (rectifyViews.value.length === 0) return 0;
    return Number(((reviewedViews.value.length / rectifyViews.value.length) * 100).toFixed(1));
  });

  /** 按使用单位统计待整改量 */
  const byOwner = computed(() => {
    const buckets = new Map<string, { owner: string; pending: number; overdue: number; total: number }>();
    for (const row of rectifyViews.value) {
      const bucket = buckets.get(row.owner) ?? { owner: row.owner, pending: 0, overdue: 0, total: 0 };
      bucket.total += 1;
      if (row.state === 'pending') bucket.pending += 1;
      if (row.overdue) bucket.overdue += 1;
      buckets.set(row.owner, bucket);
    }
    return [...buckets.values()].sort((a, b) => b.pending - a.pending);
  });

  return {
    rectifies,
    elevators,
    loading,
    error,
    initialized,
    load,
    bootstrap,
    createRectify,
    updateRectify,
    review,
    revokeReview,
    deleteRectify,
    promoteAbnormalItems,
    rectifyViews,
    pendingViews,
    overdueViews,
    reviewedViews,
    reviewRate,
    byOwner,
    pendingCountByElevator,
    pendingCountOfElevator,
  };
});
