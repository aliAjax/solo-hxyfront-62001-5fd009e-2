// 小工具：id、时间、Blob 导出

let counter = 0;

export function uid(prefix = "id"): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}_${Math.random().toString(36).slice(2, 7)}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtTimeFull(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function download(filename: string, content: string, mime = "text/plain;charset=utf-8") {
  const blob = new Blob(["﻿" + content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 以设备为主键汇总班次交接摘要 */
export function summarizeByDevice<T extends { device: string }>(items: T[]) {
  const map = new Map<string, T[]>();
  for (const it of items) {
    const arr = map.get(it.device) ?? [];
    arr.push(it);
    map.set(it.device, arr);
  }
  return map;
}
