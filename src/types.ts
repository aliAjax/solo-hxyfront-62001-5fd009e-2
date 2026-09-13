// 领域模型：班次、巡检记录、异常单

export type InspectionType =
  | "hostRpm" // 主机转速
  | "lubeOil" // 滑油压力
  | "cooling" // 冷却水温
  | "fuel" // 燃油消耗
  | "bilge" // 舱底水状态
  | "manual"; // 异常巡检项（人工记录）

export type AnomalyStatus = "open" | "progress" | "closed";

export type BilgeState = "normal" | "watch" | "alarm";

/** 六类巡检录入 */
export interface InspectionRecord {
  id: string;
  shiftId: string;
  type: InspectionType;
  device: string;
  /** 数值型读数（前四类），非数值类为空 */
  value: number | null;
  /** 舱底水档位 / 文字巡检内容 */
  text: string;
  /** 是否超出阈值 */
  outOfRange: boolean;
  /** 自动生成的异常单 id（如有） */
  anomalyId: string | null;
  operator: string;
  time: string; // ISO
}

/** 异常单（状态机：open -> progress -> closed） */
export interface Anomaly {
  id: string;
  device: string;
  type: InspectionType;
  /** 触发来源记录 */
  recordId: string;
  shiftId: string; // 首次发现班次
  title: string;
  detail: string;
  reading: string; // 触发读数描述
  status: AnomalyStatus;
  createdAt: string;
  /** 当前所属班次（交接后随未闭环异常结转） */
  currentShiftId: string;
  /** 状态流转日志 */
  logs: { time: string; from: AnomalyStatus | null; to: AnomalyStatus; note: string; shiftId: string }[];
  /** 闭环处置说明（闭环必填） */
  resolution: string;
  closedAt: string | null;
}

export interface Shift {
  id: string;
  name: string; // 如 08-12班
  start: string;
  /** 交接时间；交接前为 null，交接后只读 */
  handedOverAt: string | null;
  handoverNote: string;
  operator: string;
  /** 上一班次 id（班次链） */
  prevShiftId: string | null;
}

export interface AppState {
  shifts: Shift[];
  records: InspectionRecord[];
  anomalies: Anomaly[];
  /** 当前值班班次 id */
  currentShiftId: string | null;
}

export const STATUS_LABEL: Record<AnomalyStatus, string> = {
  open: "待处理",
  progress: "处理中",
  closed: "已闭环",
};

/** 合法状态流转 */
export const STATUS_FLOW: Record<AnomalyStatus, AnomalyStatus[]> = {
  open: ["progress"],
  progress: ["closed", "open"], // 处理中可退回待处理
  closed: [], // 闭环为终态，禁止任何流转
};
