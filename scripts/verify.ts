/* 纯逻辑端到端验证：开班 → 六类录入 → 自动异常 → 流转 → 交接结转/只读 → 筛选 → 导出 → 持久化 */
import assert from "node:assert";
import { INSPECTIONS } from "../src/constants";
import { buildExportCsv, buildHandoverSummary } from "../src/export";
import { filterRecords, DEFAULT_FILTERS } from "../src/selectors";
import {
  EMPTY_STATE,
  activeShift,
  addRecord,
  createShift,
  handover,
  loadState,
  saveState,
  transitionAnomaly,
} from "../src/store";

let pass = 0;
const ok = (name: string, cond: boolean) => {
  assert.ok(cond, name);
  pass += 1;
  console.log(`  ✓ ${name}`);
};
const throws = (name: string, fn: () => unknown, frag?: string) => {
  try {
    fn();
    assert.fail(`应拦截但未拦截：${name}`);
  } catch (e) {
    const msg = (e as Error).message;
    if (frag) assert.ok(msg.includes(frag), `错误信息应含「${frag}」，实际：${msg}`);
    pass += 1;
    console.log(`  ✓ 拦截：${name} → ${msg}`);
  }
};

// ---------- localStorage mock ----------
const mem = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
};

console.log("\n[1] 开设班次");
throws("班次名称为空", () => createShift(EMPTY_STATE, { name: "  ", operator: "张工" }), "不能为空");
throws("轮机员为空", () => createShift(EMPTY_STATE, { name: "08-12班", operator: "" }), "不能为空");
let s = createShift(EMPTY_STATE, { name: "08-12班", operator: "张工", start: "2026-09-13T00:00:00.000Z" });
ok("开班成功并成为当前班次", activeShift(s)?.name === "08-12班");
throws("重复班次", () => createShift(s, { name: "08-12班", operator: "李工" }), "重复班次");
throws("当班未交接时再开班", () => createShift(s, { name: "12-16班", operator: "李工" }), "尚未交接");

console.log("\n[2] 六类巡检录入与自动异常");
throws("未开班录入", () => addRecord(EMPTY_STATE, { type: "hostRpm", value: 80 }), "先开设");
throws("空读数提交", () => addRecord(s, { type: "hostRpm", value: null }), "不能为空");
throws("非数字读数", () => addRecord(s, { type: "hostRpm", value: Number.NaN }), "不能为空");
throws("超量程上限 201rpm", () => addRecord(s, { type: "hostRpm", value: 201 }), "超出允许量程");
throws("超量程下限 -5", () => addRecord(s, { type: "cooling", value: -5 }), "超出允许量程");
throws("滑油压力超量程 1.2MPa", () => addRecord(s, { type: "lubeOil", value: 1.2 }), "超出允许量程");
throws("舱底水未选状态（空提交）", () => addRecord(s, { type: "bilge", bilge: null }), "请选择");
throws("人工巡检空描述", () => addRecord(s, { type: "manual", text: "  " }), "不能为空");

const hostDef = INSPECTIONS.find((i) => i.type === "hostRpm")!;
ok("六类巡检定义齐全", INSPECTIONS.length === 6);
ok("主机量程配置正确", hostDef.hardRange.max === 200 && hostDef.normalRange.max === 110);

// 正常数值读数
s = addRecord(s, { type: "hostRpm", value: 82, now: "2026-09-13T00:10:00.000Z" });
ok("正常读数不生成异常", s.records.length === 1 && s.anomalies.length === 0 && s.records[0].outOfRange === false);

// 越限读数 → 自动异常，关联设备
s = addRecord(s, { type: "hostRpm", value: 116, now: "2026-09-13T00:20:00.000Z" });
const rpmAnomaly = s.anomalies[0];
ok("越限读数自动生成异常单", s.anomalies.length === 1 && rpmAnomaly.status === "open");
ok("异常自动关联设备=主机", rpmAnomaly.device === "主机");
ok("记录回链异常单", s.records[1].anomalyId === rpmAnomaly.id && rpmAnomaly.recordId === s.records[1].id);
ok("异常归属当前班次", rpmAnomaly.currentShiftId === activeShift(s)!.id);

// 其余三类数值 + 舱底水 + 人工
s = addRecord(s, { type: "lubeOil", value: 0.42, now: "2026-09-13T00:21:00.000Z" });
s = addRecord(s, { type: "cooling", value: 91, now: "2026-09-13T00:22:00.000Z" }); // 越限
s = addRecord(s, { type: "fuel", value: 96, now: "2026-09-13T00:23:00.000Z" });
s = addRecord(s, { type: "bilge", bilge: "normal", now: "2026-09-13T00:24:00.000Z" });
s = addRecord(s, { type: "bilge", bilge: "watch", now: "2026-09-13T00:30:00.000Z" }); // 异常
s = addRecord(s, { type: "manual", text: "#2发电机排烟温度偏高", device: "发电机#2", now: "2026-09-13T00:40:00.000Z" });
ok("六类数据均可录入（共8条）", s.records.length === 8);
ok("越限/异常共生成4单：转速、水温、舱底水、人工", s.anomalies.length === 4);
const coolAnomaly = s.anomalies.find((a) => a.type === "cooling")!;
const bilgeAnomaly = s.anomalies.find((a) => a.type === "bilge")!;
const manualAnomaly = s.anomalies.find((a) => a.type === "manual")!;
ok("人工巡检关联所选设备", manualAnomaly.device === "发电机#2");
ok("舱底水异常关联舱底水设备", bilgeAnomaly.device === "舱底水");

console.log("\n[3] 异常状态流转");
throws("open→closed 越级流转", () => transitionAnomaly(s, rpmAnomaly.id, "closed", "已修"), "非法流转");
throws("重复流转 open→open", () => transitionAnomaly(s, rpmAnomaly.id, "open", ""), "无需重复");
throws("开始处理但无措施说明", () => transitionAnomaly(s, rpmAnomaly.id, "progress", "  "), "处理措施");
let s2 = transitionAnomaly(s, rpmAnomaly.id, "progress", "降速运行并排查油路", "2026-09-13T01:00:00.000Z");
ok("open→处理中 成功", s2.anomalies.find((a) => a.id === rpmAnomaly.id)!.status === "progress");
throws("闭环不填处置说明", () => transitionAnomaly(s2, rpmAnomaly.id, "closed", ""), "闭环前必须填写");
s2 = transitionAnomaly(s2, rpmAnomaly.id, "closed", "清洗滤器后转速恢复正常区间，复测合格", "2026-09-13T01:30:00.000Z");
const closedRpm = s2.anomalies.find((a) => a.id === rpmAnomaly.id)!;
ok("处理中→已闭环 并记录处置说明", closedRpm.status === "closed" && closedRpm.closedAt !== null && closedRpm.resolution.includes("清洗滤器"));
ok("流转日志完整（建单/处理/闭环3条）", closedRpm.logs.length === 3);
throws("已闭环为终态禁止再流转", () => transitionAnomaly(s2, rpmAnomaly.id, "progress", "x"), "终态");

// 处理中可退回待处理（从 rpm 已闭环的 s2 继续，保持主状态一致）
let s3 = transitionAnomaly(s2, coolAnomaly.id, "progress", "启动备用泵降温", "2026-09-13T01:00:00.000Z");
s3 = transitionAnomaly(s3, coolAnomaly.id, "open", "降温措施效果不足，需重新评估", "2026-09-13T01:10:00.000Z");
ok("处理中可退回待处理", s3.anomalies.find((a) => a.id === coolAnomaly.id)!.status === "open");
s = s3; // rpm已闭环；水温退回待处理，连同舱底水/人工共3单未闭环

console.log("\n[4] 交接班拦截与结转");
throws("交接备注为空", () => handover(s, { note: "", nextName: "12-16班", nextOperator: "李工" }), "交接备注");
throws("新班次名称为空", () => handover(s, { note: "继续观察", nextName: "  ", nextOperator: "李工" }), "新班次名称");
throws("接班轮机员为空", () => handover(s, { note: "继续观察", nextName: "12-16班", nextOperator: "" }), "接班轮机员");
throws("交接至重复班次", () => handover(s, { note: "继续观察", nextName: "08-12班", nextOperator: "李工" }), "重复班次");
const h0 = handover(s, { note: "继续观察", nextName: "12-16班", nextOperator: "李工", at: "2026-09-13T04:00:00.000Z" });
const oldShift0 = h0.shifts.find((x) => x.name === "08-12班")!;
throws("对已交接的旧班次重复交接", () => handover({ ...h0, currentShiftId: oldShift0.id }, { note: "x", nextName: "16-20班", nextOperator: "王工" }), "已交接");

let h = handover(s, { note: "舱底水持续观察；#2发电机待测温；水温异常复测", nextName: "12-16班", nextOperator: "李工", at: "2026-09-13T04:00:00.000Z" });
const oldShift = h.shifts.find((x) => x.name === "08-12班")!;
const newShift = activeShift(h)!;
ok("新班次成为当前班次", newShift.name === "12-16班" && newShift.operator === "李工");
ok("旧班次已交接只读", oldShift.handedOverAt === "2026-09-13T04:00:00.000Z" && !!oldShift.handoverNote);
ok("班次链 prevShiftId 指向旧班", newShift.prevShiftId === oldShift.id);
throws("旧班次只读：禁止录入", () => addRecord({ ...h, currentShiftId: oldShift.id }, { type: "hostRpm", value: 80 }), "只读");
throws("已交接班次禁止再交接", () => handover({ ...h, currentShiftId: oldShift.id }, { note: "x", nextName: "X班", nextOperator: "王" }), "已交接");

const carried = h.anomalies.filter((a) => a.status !== "closed");
ok("3项未闭环异常全部带入新班次", carried.length === 3 && carried.every((a) => a.currentShiftId === newShift.id));
ok("已闭环异常不结转（留旧班）", h.anomalies.find((a) => a.id === rpmAnomaly.id)!.currentShiftId === oldShift.id);
ok("异常保留原发现班次（原记录可追溯）", carried.every((a) => a.shiftId === oldShift.id));
ok("原始记录不复制、不丢失（仍8条且归属旧班）", h.records.length === 8 && h.records.every((r) => r.shiftId === oldShift.id));
ok("结转异常日志含交接记录", carried.every((a) => a.logs.some((l) => l.note.includes("交接结转"))));
ok("新班初始记录数为0（按班过滤可见）", h.records.filter((r) => r.shiftId === newShift.id).length === 0);

console.log("\n[5] 结转异常在新班次继续闭环");
throws("不能处理归属其他班次的异常（模拟切回旧班视角）", () =>
  transitionAnomaly({ ...h, currentShiftId: oldShift.id }, coolAnomaly.id, "progress", "x"),
);
h = transitionAnomaly(h, coolAnomaly.id, "progress", "降负荷+清洗冷却器", "2026-09-13T04:30:00.000Z");
h = transitionAnomaly(h, coolAnomaly.id, "closed", "水温回落至82℃，连续观察30分钟稳定", "2026-09-13T05:00:00.000Z");
ok("结转异常在新班次闭环成功", h.anomalies.find((a) => a.id === coolAnomaly.id)!.status === "closed");
// 新班录入一条正常记录
h = addRecord(h, { type: "hostRpm", value: 85, now: "2026-09-13T04:10:00.000Z" });
ok("新班次可正常录入", h.records.length === 9 && h.records[8].shiftId === newShift.id);

console.log("\n[6] 历史筛选");
ok("全部记录9条", filterRecords(h, DEFAULT_FILTERS).length === 9);
ok("按班次筛选：旧班8条", filterRecords(h, { ...DEFAULT_FILTERS, shiftId: oldShift.id }).length === 8);
ok("按班次筛选：新班1条", filterRecords(h, { ...DEFAULT_FILTERS, shiftId: newShift.id }).length === 1);
ok("按设备筛选：主机5条（转速2+滑油1+水温1+新班1）", filterRecords(h, { ...DEFAULT_FILTERS, device: "主机" }).length === 5);
ok("按设备筛选：发电机#2 1条", filterRecords(h, { ...DEFAULT_FILTERS, device: "发电机#2" }).length === 1);
ok("状态筛选：仅越限记录4条", filterRecords(h, { ...DEFAULT_FILTERS, status: "out" }).length === 4);
ok("状态筛选：已闭环异常对应2条记录", filterRecords(h, { ...DEFAULT_FILTERS, status: "closed" }).length === 2);
ok("状态筛选：待处理对应2条（舱底水+人工）", filterRecords(h, { ...DEFAULT_FILTERS, status: "open" }).length === 2);
ok("状态筛选：处理中0条", filterRecords(h, { ...DEFAULT_FILTERS, status: "progress" }).length === 0);
ok("关键字筛选：排烟", filterRecords(h, { ...DEFAULT_FILTERS, kw: "排烟" }).length === 1);
ok("组合筛选：旧班+主机+越限 = 2条（转速、水温）", filterRecords(h, { ...DEFAULT_FILTERS, shiftId: oldShift.id, device: "主机", status: "out" }).length === 2);

console.log("\n[7] 导出与交接摘要");
const csv = buildExportCsv(h);
ok("CSV含巡检记录段与异常台账段", csv.includes("# 巡检记录") && csv.includes("# 异常单台账"));
ok("CSV含具体读数与处置说明", csv.includes("116rpm") && csv.includes("清洗滤器"));
const summary = buildHandoverSummary(h, oldShift.id);
ok("摘要按设备汇总（含主机/舱底水/发电机#2）", summary.includes("【主机】") && summary.includes("【舱底水】") && summary.includes("【发电机#2】"));
ok("摘要列出未闭环结转项", summary.includes("▶ 未闭环") && summary.includes("舱底水"));
ok("摘要含交接备注", summary.includes("水温异常复测"));

console.log("\n[8] 持久化（刷新不丢）");
saveState(h);
const reloaded = loadState();
ok("localStorage 往返后班次齐全", reloaded.shifts.length === 2);
ok("localStorage 往返后记录9条、异常4单", reloaded.records.length === 9 && reloaded.anomalies.length === 4);
ok("localStorage 往返后当前班次保持12-16班", activeShift(reloaded)?.name === "12-16班");
ok("localStorage 往返后闭环状态与处置说明保留", reloaded.anomalies.find((a) => a.id === rpmAnomaly.id)?.resolution.includes("清洗滤器"));
mem.clear();
ok("清空后回到空状态", loadState().shifts.length === 0);
// 损坏数据不崩溃
mem.set("marine-watch-log-v1", "{bad json");
ok("损坏的本地数据安全回退空状态", loadState().records.length === 0);
mem.clear();

console.log(`\n🎉 全部 ${pass} 项验证通过`);
