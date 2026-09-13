import { INSPECTION_MAP, readingText } from "./constants";
import type { Anomaly, AppState, InspectionRecord, Shift } from "./types";
import { STATUS_LABEL } from "./types";
import { fmtTimeFull } from "./utils";

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function recordRows(state: AppState): string[][] {
  const head = ["班次", "时间", "巡检类别", "设备", "读数/状态", "越限", "录入轮机员", "异常单"];
  const shiftName = (id: string) => state.shifts.find((s) => s.id === id)?.name ?? id;
  const rows = state.records.map((r: InspectionRecord) => [
    shiftName(r.shiftId),
    fmtTimeFull(r.time),
    INSPECTION_MAP[r.type].label,
    r.device,
    readingText(r.type, r.value, r.text),
    r.outOfRange ? "是" : "否",
    r.operator,
    r.anomalyId ? STATUS_LABEL[state.anomalies.find((a) => a.id === r.anomalyId)?.status ?? "open"] : "",
  ]);
  return [head, ...rows];
}

function anomalyRows(state: AppState): string[][] {
  const head = ["异常单", "设备", "描述", "触发读数", "发现班次", "当前班次", "状态", "创建时间", "闭环时间", "处置说明"];
  const shiftName = (id: string) => state.shifts.find((s) => s.id === id)?.name ?? id;
  const rows = state.anomalies.map((a: Anomaly) => [
    a.title,
    a.device,
    a.detail,
    a.reading,
    shiftName(a.shiftId),
    shiftName(a.currentShiftId),
    STATUS_LABEL[a.status],
    fmtTimeFull(a.createdAt),
    a.closedAt ? fmtTimeFull(a.closedAt) : "",
    a.resolution,
  ]);
  return [head, ...rows];
}

/** 导出全部历史（巡检记录 + 异常单）为 CSV */
export function buildExportCsv(state: AppState): string {
  const sections: string[] = [];
  sections.push(["# 巡检记录", ...recordRows(state).map((r) => r.map(csvCell).join(","))].join("\n"));
  sections.push(["# 异常单台账", ...anomalyRows(state).map((r) => r.map(csvCell).join(","))].join("\n"));
  return sections.join("\n\n");
}

/** 交接摘要纯文本（按设备汇总） */
export function buildHandoverSummary(state: AppState, shiftId: string): string {
  const shift = state.shifts.find((s) => s.id === shiftId);
  if (!shift) return "";
  const records = state.records.filter((r) => r.shiftId === shiftId);
  // 本班发现且未闭环的异常（交接后已结转至新班，仍列入交接存档）
  const open = state.anomalies.filter((a) => a.shiftId === shiftId && a.status !== "closed");
  const closed = state.anomalies.filter((a) => a.shiftId === shiftId && a.status === "closed");

  const lines: string[] = [];
  lines.push(`交接班摘要 · ${shift.name}（值班轮机员：${shift.operator}）`);
  lines.push(`本班录入巡检 ${records.length} 条，未闭环异常 ${open.length} 项，本班闭环 ${closed.length} 项`);
  lines.push("");

  const devices = Array.from(new Set(records.map((r) => r.device))).sort();
  for (const device of devices) {
    lines.push(`【${device}】`);
    records
      .filter((r) => r.device === device)
      .forEach((r) => {
        const tag = r.outOfRange ? " ⚠越限" : "";
        lines.push(`  ${fmtTimeFull(r.time)} ${INSPECTION_MAP[r.type].label}：${readingText(r.type, r.value, r.text)}${tag}`);
      });
    open
      .filter((a) => a.device === device)
      .forEach((a) => lines.push(`  ▶ 未闭环：${a.title}（${STATUS_LABEL[a.status]}，读数 ${a.reading}）`));
    lines.push("");
  }
  if (shift.handoverNote) {
    lines.push(`交接备注：${shift.handoverNote}`);
  }
  return lines.join("\n");
}
