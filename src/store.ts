import { BILGE_OPTIONS, INSPECTION_MAP, isNumericAbnormal, readingText } from "./constants";
import type {
  Anomaly,
  AnomalyStatus,
  AppState,
  BilgeState,
  InspectionRecord,
  InspectionType,
  Shift,
} from "./types";
import { STATUS_FLOW } from "./types";
import { uid } from "./utils";

// ---------- 纯逻辑（不接触浏览器，便于测试） ----------

export const EMPTY_STATE: AppState = { shifts: [], records: [], anomalies: [], currentShiftId: null };

export function activeShift(state: AppState): Shift | null {
  const s = state.shifts.find((x) => x.id === state.currentShiftId);
  return s ?? null;
}

export function isShiftLocked(shift: Shift | null): boolean {
  return !!shift && shift.handedOverAt !== null;
}

export interface NewShiftInput {
  name: string;
  operator: string;
  start?: string;
}

/** 开设班次：名称非空且不得与已有班次重复 */
export function createShift(state: AppState, input: NewShiftInput, nowIso = new Date().toISOString()): AppState {
  const name = input.name.trim();
  const operator = input.operator.trim();
  if (!name) throw new Error("班次名称不能为空");
  if (!operator) throw new Error("值班轮机员不能为空");
  if (state.shifts.some((s) => s.name === name)) {
    throw new Error(`班次「${name}」已存在，重复班次禁止开设`);
  }
  const current = activeShift(state);
  if (current && current.handedOverAt === null) {
    throw new Error(`当前班次「${current.name}」尚未交接，请先完成交接班`);
  }
  const shift: Shift = {
    id: uid("shift"),
    name,
    operator,
    start: input.start ?? nowIso,
    handedOverAt: null,
    handoverNote: "",
    prevShiftId: current ? current.id : null,
  };
  return { ...state, shifts: [...state.shifts, shift], currentShiftId: shift.id };
}

export interface RecordInput {
  type: InspectionType;
  /** 数值型读数（数值类必填） */
  value?: number | null;
  /** 舱底水档位（bilge 必填） */
  bilge?: BilgeState | null;
  /** 人工巡检描述 / 备注（manual 必填） */
  text?: string;
  /** manual 可改关联设备，其余取定义默认设备 */
  device?: string;
  now?: string;
}

/** 巡检录入：空提交与超硬范围读数在此拦截；越限自动生成异常单 */
export function addRecord(state: AppState, input: RecordInput): AppState {
  const shift = activeShift(state);
  if (!shift) throw new Error("请先开设值班班次后再录入巡检数据");
  if (shift.handedOverAt !== null) throw new Error(`班次「${shift.name}」已交接，旧班次只读`);

  const def = INSPECTION_MAP[input.type];
  if (!def) throw new Error("未知的巡检类型");
  const now = input.now ?? new Date().toISOString();

  let value: number | null = null;
  let text = (input.text ?? "").trim();
  let device = def.device;
  let abnormal = false;
  let title = "";
  let detail = "";

  if (def.numeric) {
    const raw = input.value;
    if (raw === null || raw === undefined || Number.isNaN(raw)) {
      throw new Error(`${def.label}读数不能为空`);
    }
    value = raw;
    if (!Number.isFinite(value)) throw new Error(`${def.label}读数必须为有限数值`);
    if (value < def.hardRange.min || value > def.hardRange.max) {
      throw new Error(
        `${def.label}读数 ${value}${def.unit} 超出允许量程（${def.hardRange.min}~${def.hardRange.max}${def.unit}），已拦截`,
      );
    }
    abnormal = isNumericAbnormal(input.type, value);
    if (abnormal) {
      title = `${def.label}越限`;
      detail = `${device}${def.label} ${value}${def.unit}，超出正常区间 ${def.normalRange.min}~${def.normalRange.max}${def.unit}，由巡检读数自动关联生成。`;
    }
  } else if (input.type === "bilge") {
    const opt = BILGE_OPTIONS.find((o) => o.value === input.bilge);
    if (!opt) throw new Error("请选择舱底水状态后再提交");
    text = opt.label;
    abnormal = opt.abnormal;
    if (abnormal) {
      title = input.bilge === "alarm" ? "舱底水液位达到警戒线" : "舱底水液位接近警戒线";
      detail = `舱底水巡检结果：${opt.label}，已自动关联舱底水设备生成异常单。`;
    }
  } else {
    if (!text) throw new Error("异常巡检项描述不能为空");
    if (input.device) device = input.device;
    abnormal = true; // 人工巡检项一律作为异常登记
    title = text.length > 18 ? text.slice(0, 18) + "…" : text;
    detail = `人工巡检登记（${device}）：${text}`;
  }

  const recordId = uid("rec");
  let anomalyId: string | null = null;
  let anomaly: Anomaly | null = null;
  if (abnormal) {
    anomalyId = uid("anm");
    anomaly = {
      id: anomalyId,
      device,
      type: input.type,
      recordId,
      shiftId: shift.id,
      currentShiftId: shift.id,
      title,
      detail,
      reading: readingText(input.type, value, text),
      status: "open",
      createdAt: now,
      resolution: "",
      closedAt: null,
      logs: [{ time: now, from: null, to: "open", note: "巡检越限/报告，自动生成异常单", shiftId: shift.id }],
    };
  }

  const record: InspectionRecord = {
    id: recordId,
    shiftId: shift.id,
    type: input.type,
    device,
    value,
    text,
    outOfRange: abnormal,
    anomalyId,
    operator: shift.operator,
    time: now,
  };

  return {
    ...state,
    records: [...state.records, record],
    anomalies: anomaly ? [...state.anomalies, anomaly] : state.anomalies,
  };
}

/** 异常状态流转；闭环必须填写处置说明，终态/越序流转一律拦截 */
export function transitionAnomaly(
  state: AppState,
  anomalyId: string,
  to: AnomalyStatus,
  note = "",
  nowIso = new Date().toISOString(),
): AppState {
  const anomaly = state.anomalies.find((a) => a.id === anomalyId);
  if (!anomaly) throw new Error("异常单不存在");
  const shift = activeShift(state);
  if (!shift || anomaly.currentShiftId !== shift.id) {
    throw new Error("该异常不在当前值班班次，仅可在其所属班次处理");
  }
  if (shift.handedOverAt !== null) throw new Error("当前班次已交接，异常为只读状态");

  const from = anomaly.status;
  if (from === to) throw new Error(`异常已是「${statusLabel(to)}」状态，无需重复操作`);
  if (from === "closed") throw new Error("异常已闭环，闭环为终态，禁止再次流转");
  if (!STATUS_FLOW[from].includes(to)) {
    throw new Error(`非法流转：${statusLabel(from)} → ${statusLabel(to)}`);
  }
  const trimmed = note.trim();
  if (to === "closed" && !trimmed) {
    throw new Error("闭环前必须填写处置说明");
  }
  if (to === "progress" && !trimmed) {
    throw new Error("开始处理前请填写处理措施说明");
  }

  const next: Anomaly = {
    ...anomaly,
    status: to,
    resolution: to === "closed" ? trimmed : anomaly.resolution,
    closedAt: to === "closed" ? nowIso : anomaly.closedAt,
    logs: [...anomaly.logs, { time: nowIso, from, to, note: trimmed || "状态更新", shiftId: shift.id }],
  };
  return { ...state, anomalies: state.anomalies.map((a) => (a.id === anomalyId ? next : a)) };
}

export interface HandoverInput {
  note: string;
  nextName: string;
  nextOperator: string;
  at?: string;
}

/**
 * 交接班：旧班次置只读（备注必填），开设新班次；
 * 未闭环异常连同原记录（shiftId 不变）带入新班次。
 */
export function handover(state: AppState, input: HandoverInput): AppState {
  const shift = activeShift(state);
  if (!shift) throw new Error("当前没有进行中的班次，无法交接");
  if (shift.handedOverAt !== null) throw new Error("当前班次已交接，不能重复交接");
  const note = input.note.trim();
  const nextName = input.nextName.trim();
  const nextOperator = input.nextOperator.trim();
  if (!note) throw new Error("交接备注不能为空");
  if (!nextName) throw new Error("新班次名称不能为空");
  if (!nextOperator) throw new Error("接班轮机员不能为空");
  if (state.shifts.some((s) => s.name === nextName)) {
    throw new Error(`班次「${nextName}」已存在，重复班次禁止开设`);
  }
  if (nextName === shift.name) throw new Error("新班次不得与当前班次同名");

  const at = input.at ?? new Date().toISOString();
  const oldShift: Shift = { ...shift, handedOverAt: at, handoverNote: note };
  const nextShift: Shift = {
    id: uid("shift"),
    name: nextName,
    operator: nextOperator,
    start: at,
    handedOverAt: null,
    handoverNote: "",
    prevShiftId: shift.id,
  };

  const carried = state.anomalies.filter(
    (a) => a.currentShiftId === shift.id && a.status !== "closed",
  );
  const carriedIds = new Set(carried.map((a) => a.id));
  const anomalies = state.anomalies.map((a) =>
    carriedIds.has(a.id)
      ? {
          ...a,
          currentShiftId: nextShift.id,
          logs: [
            ...a.logs,
            { time: at, from: a.status, to: a.status, note: `交接结转：${shift.name} → ${nextName}`, shiftId: nextShift.id },
          ],
        }
      : a,
  );

  return {
    shifts: [...state.shifts.map((s) => (s.id === shift.id ? oldShift : s)), nextShift],
    records: state.records,
    anomalies,
    currentShiftId: nextShift.id,
  };
}

export function statusLabel(s: AnomalyStatus): string {
  return s === "open" ? "待处理" : s === "progress" ? "处理中" : "已闭环";
}

// ---------- 持久化 store（浏览器侧） ----------

const STORAGE_KEY = "marine-watch-log-v1";

export function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_STATE;
    const parsed = JSON.parse(raw) as AppState;
    if (!parsed || !Array.isArray(parsed.shifts) || !Array.isArray(parsed.records)) return EMPTY_STATE;
    return {
      shifts: parsed.shifts,
      records: parsed.records,
      anomalies: Array.isArray(parsed.anomalies) ? parsed.anomalies : [],
      currentShiftId: typeof parsed.currentShiftId === "string" ? parsed.currentShiftId : null,
    };
  } catch {
    return EMPTY_STATE;
  }
}

export function saveState(state: AppState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* 存储不可用时静默，内存中仍可用 */
  }
}

export function clearStorageState(): AppState {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  return EMPTY_STATE;
}
