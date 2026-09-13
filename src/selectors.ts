import { INSPECTION_MAP, readingText } from "./constants";
import type { AnomalyStatus, AppState, InspectionRecord } from "./types";

export interface HistoryFilters {
  shiftId: string;
  device: string;
  status: AnomalyStatus | "all" | "out";
  kw: string;
}

export const DEFAULT_FILTERS: HistoryFilters = { shiftId: "all", device: "all", status: "all", kw: "" };

/** 历史记录筛选：按班次 / 设备 / 异常状态 / 关键字 */
export function filterRecords(state: AppState, filters: HistoryFilters): InspectionRecord[] {
  return [...state.records]
    .sort((a, b) => b.time.localeCompare(a.time))
    .filter((r) => {
      if (filters.shiftId !== "all" && r.shiftId !== filters.shiftId) return false;
      if (filters.device !== "all" && r.device !== filters.device) return false;
      if (filters.status === "out" && !r.outOfRange) return false;
      if (filters.status === "open" || filters.status === "progress" || filters.status === "closed") {
        const a = r.anomalyId && state.anomalies.find((x) => x.id === r.anomalyId);
        if (!a || a.status !== filters.status) return false;
      }
      if (filters.kw.trim()) {
        const hay = `${INSPECTION_MAP[r.type].label} ${r.device} ${readingText(r.type, r.value, r.text)} ${r.operator}`;
        if (!hay.includes(filters.kw.trim())) return false;
      }
      return true;
    });
}
