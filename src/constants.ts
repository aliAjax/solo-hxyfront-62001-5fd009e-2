import type { BilgeState, InspectionType } from "./types";

export interface InspectionDef {
  type: InspectionType;
  label: string;
  short: string;
  device: string; // 默认关联设备
  unit: string;
  /** 硬范围：超出一律拦截，不得提交 */
  hardRange: { min: number; max: number };
  /** 正常阈值区间：超出（但仍在硬范围内）自动生成异常 */
  normalRange: { min: number; max: number };
  /** 看板基准（最近读数为空时展示） */
  placeholder: string;
  numeric: boolean;
}

/** 六类巡检数据定义（前四类数值阈值，舱底水与人工巡检为枚举/文本） */
export const INSPECTIONS: InspectionDef[] = [
  {
    type: "hostRpm",
    label: "主机转速",
    short: "转速",
    device: "主机",
    unit: "rpm",
    hardRange: { min: 0, max: 200 },
    normalRange: { min: 60, max: 110 },
    placeholder: "—",
    numeric: true,
  },
  {
    type: "lubeOil",
    label: "滑油压力",
    short: "滑油压力",
    device: "主机",
    unit: "MPa",
    hardRange: { min: 0, max: 1 },
    normalRange: { min: 0.35, max: 0.55 },
    placeholder: "—",
    numeric: true,
  },
  {
    type: "cooling",
    label: "冷却水温",
    short: "冷却水温",
    device: "主机",
    unit: "℃",
    hardRange: { min: 0, max: 120 },
    normalRange: { min: 60, max: 85 },
    placeholder: "—",
    numeric: true,
  },
  {
    type: "fuel",
    label: "燃油消耗",
    short: "燃油消耗",
    device: "燃油系统",
    unit: "L/h",
    hardRange: { min: 0, max: 500 },
    normalRange: { min: 0, max: 120 },
    placeholder: "—",
    numeric: true,
  },
  {
    type: "bilge",
    label: "舱底水状态",
    short: "舱底水",
    device: "舱底水",
    unit: "",
    hardRange: { min: 0, max: 0 },
    normalRange: { min: 0, max: 0 },
    placeholder: "未巡检",
    numeric: false,
  },
  {
    type: "manual",
    label: "异常巡检项",
    short: "人工巡检",
    device: "泵组",
    unit: "",
    hardRange: { min: 0, max: 0 },
    normalRange: { min: 0, max: 0 },
    placeholder: "—",
    numeric: false,
  },
];

export const INSPECTION_MAP: Record<InspectionType, InspectionDef> = Object.fromEntries(
  INSPECTIONS.map((d) => [d.type, d]),
) as Record<InspectionType, InspectionDef>;

export const BILGE_OPTIONS: { value: BilgeState; label: string; abnormal: boolean }[] = [
  { value: "normal", label: "液位正常", abnormal: false },
  { value: "watch", label: "接近警戒（持续观察）", abnormal: true },
  { value: "alarm", label: "达到警戒（需要处置）", abnormal: true },
];

/** 可筛选设备（保留旧入口四类，并含人工巡检可选设备） */
export const DEVICES = ["主机", "发电机#1", "发电机#2", "泵组", "燃油系统", "舱底水"];

export function isNumericAbnormal(type: InspectionType, value: number): boolean {
  const def = INSPECTION_MAP[type];
  if (!def.numeric) return false;
  return value < def.normalRange.min || value > def.normalRange.max;
}

export function readingText(type: InspectionType, value: number | null, text: string): string {
  const def = INSPECTION_MAP[type];
  if (def.numeric && value !== null) return `${value}${def.unit}`;
  return text || "—";
}
