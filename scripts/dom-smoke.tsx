/* DOM 级冒烟：真实渲染 App，模拟开班→录入→自动异常→流转→交接→筛选→导出→清空 */
declare const require: (id: string) => any;
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost/" });
const w = dom.window;

/**
 * 把 jsdom 的对象注入到 Node 全局。
 * Node 20 没有全局 navigator，直接赋值即可；Node 21+ 的 navigator 是只带 getter
 * 的惰性全局（Node 22 同样如此），直接赋值会抛
 * "Cannot set property navigator of #<Object> which has only a getter"，
 * 因此失败时回退到 defineProperty 覆盖。两版 Node 行为统一。
 */
function setGlobal(key: string, value: unknown) {
  try {
    (globalThis as Record<string, unknown>)[key] = value;
  } catch {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
}

setGlobal("window", w);
setGlobal("document", w.document);
setGlobal("navigator", w.navigator);
setGlobal("localStorage", w.localStorage);
setGlobal("HTMLElement", w.HTMLElement);
setGlobal("Element", w.Element);
setGlobal("Node", w.Node);
setGlobal("SVGElement", w.SVGElement);
setGlobal("MouseEvent", w.MouseEvent);
setGlobal("Event", w.Event);
setGlobal("CustomEvent", w.CustomEvent);
setGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0));
setGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
w.HTMLElement.prototype.scrollIntoView = () => {};
if (!w.URL.createObjectURL) {
  w.URL.createObjectURL = () => "blob:mock";
  w.URL.revokeObjectURL = () => {};
}
setGlobal("IS_REACT_ACT_ENVIRONMENT", true);

// 必须在 jsdom 全局就绪后再加载 React
const React = require("react");
const { createRoot } = require("react-dom/client");
const act = React.act;
const App = require("../src/App").default;

async function main() {
const root = createRoot(w.document.getElementById("root")!);
await act(async () => {
  root.render(React.createElement(App));
});

const $ = (sel: string) => w.document.querySelector(sel) as HTMLElement | null;
const $$ = (sel: string) => [...w.document.querySelectorAll(sel)] as HTMLElement[];
const findBtn = (text: string) => $$("button").find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;
const exactBtn = (text: string, root: ParentNode = w.document) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent!.trim() === text) as HTMLButtonElement | undefined;
const setVal = (el: Element, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new w.Event("input", { bubbles: true }));
};
let pass = 0;
const check = (name: string, cond: boolean) => {
  if (!cond) throw new Error("DOM 断言失败：" + name);
  pass++;
  console.log("  ✓ " + name);
};

console.log("\n[A] 首屏与旧入口");
check("标题渲染", !!$(".hero h1") && $(".hero h1")!.textContent!.includes("轮机值班"));
check("五个标签页（旧入口扩展为标签）", $$(".tab").length === 5);
check("六类参数卡（机舱参数看板旧入口）", $$(".metrics article").length === 6);
check("异常记录时间线入口存在", $(".heading")?.textContent?.includes("异常记录时间线") ?? false);
check("摘要入口（交接班标签）", !!findBtn("交接班"));

console.log("\n[B] 开设班次");
await act(async () => findBtn!("开设班次")!.click());
check("开班弹窗出现", !!$(".modal"));
// 先用快捷 chip（纯 React onClick）验证状态更新
await act(async () => ($$(".chips-tight button")[2] as HTMLButtonElement).click());
await act(async () => {
  setVal($$(".modal input")[0], "08-12班");
});
await act(async () => {
  setVal($$(".modal input")[1], "张工");
});
await act(async () => findBtn!("开班")!.click());
check("开班后自动进入录入页并显示班次", w.document.body.textContent!.includes("08-12班") && !!$(".type-tabs"));
check("localStorage 已持久化班次", w.localStorage.getItem("marine-watch-log-v1")!.includes("08-12班"));

console.log("\n[C] 巡检录入与拦截");
await act(async () => findBtn!("巡检录入")!.click());
check("六类录入类型按钮", $$(".type-tab").length === 6);
// 空提交
await act(async () => findBtn!("提交巡检记录")!.click());
check("空读数被拦截并提示", !!$(".form-error") && $(".form-error")!.textContent!.includes("不能为空"));
// 超量程
await act(async () => setVal($("input[inputmode='decimal']")!, "999"));
await act(async () => findBtn!("提交巡检记录")!.click());
check("超量程读数被拦截", $(".form-error")!.textContent!.includes("超出允许量程"));
// 正常读数
await act(async () => setVal($("input[inputmode='decimal']")!, "82"));
await act(async () => findBtn!("提交巡检记录")!.click());
check("正常读数录入，最近列表出现", $$(".records article").length === 1);
// 越限读数 → 自动异常
await act(async () => setVal($("input[inputmode='decimal']")!, "118"));
await act(async () => findBtn!("提交巡检记录")!.click());
check("越限记录标记", $$(".records .tag-alarm").length >= 1);
check("待处理角标出现", $(".tab-dot")?.textContent === "1");

console.log("\n[D] 异常流转与闭环必填");
await act(async () => findBtn!("异常处理")!.click());
check("异常台账列出1单", $$(".anomaly-card").length === 1);
await act(async () => findBtn!("开始处理")!.click());
check("流转弹窗", !!$(".modal textarea"));
// 处理措施为空提交
await act(async () => findBtn!("确认提交")!.click());
check("无措施被拦截", $(".modal .form-error")!.textContent!.includes("处理措施"));
await act(async () => {
  const ta = $(".modal textarea")!;
  const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(ta, "降速排查油路");
  ta.dispatchEvent(new w.Event("input", { bubbles: true }));
});
await act(async () => findBtn!("确认提交")!.click());
check("进入处理中，出现闭环按钮", !!exactBtn("闭环"));
await act(async () => exactBtn!("闭环")!.click());
// 默认选中"退回待处理"，需显式选择"确认闭环"
await act(async () => exactBtn!("确认闭环", $(".modal")!)!.click());
// 闭环不填处置说明
await act(async () => findBtn!("确认提交")!.click());
check("空处置说明禁止闭环", $(".modal .form-error")!.textContent!.includes("闭环前必须填写"));
await act(async () => {
  const ta = $(".modal textarea")!;
  const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(ta, "清洗燃油滤器，复测转速105rpm恢复正常");
  ta.dispatchEvent(new w.Event("input", { bubbles: true }));
});
await act(async () => findBtn!("确认提交")!.click());
check("已闭环分组出现", $$(".anomaly-card").length === 1 && !!$(".badge-closed"));
check("处置说明展示", $(".anomaly-card")!.textContent!.includes("清洗燃油滤器"));

console.log("\n[E] 交接班二次确认、结转与只读");
await act(async () => findBtn!("交接班")!.click());
check("摘要按设备汇总出现【主机】", $(".handover-grid")!.textContent!.includes("主机"));
// 缺字段直接点
await act(async () => findBtn!("确认交接班")!.click());
check("空交接字段被拦截", !!$(".form-error"));
await act(async () => {
  const inputs = $$(".handover-grid input");
  setVal(inputs[0], "12-16班");
  setVal(inputs[1], "李工");
  const ta = $(".handover-grid textarea")!;
  const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(ta, "舱底水位下一班复测");
  ta.dispatchEvent(new w.Event("input", { bubbles: true }));
});
await act(async () => findBtn!("确认交接班")!.click());
check("二次确认弹窗", !!$(".modal") && $(".modal")!.textContent!.includes("确认交接班"));
await act(async () => exactBtn!("确认交接")!.click());
check("交接后当前班次=12-16班", w.document.body.textContent!.includes("12-16班"));
await act(async () => findBtn!("巡检录入")!.click());
check("旧班记录在历史；新班可录入（无只读报错）", !$(".form-error"));

console.log("\n[F] 历史筛选与持久化刷新");
await act(async () => findBtn!("历史记录")!.click());
const opts = $$(".filter-bar select option").map((o) => o.textContent).join("");
check("设备筛选保留主机/发电机/泵组/舱底水等旧入口", ["主机", "发电机#1", "泵组", "舱底水"].every((d) => opts.includes(d)));
const rowCount = () => $$(".history-table tbody tr").length;
check("台账2条记录", rowCount() === 2);
const selects = $$(".filter-bar select");
const setSelect = (el: Element, idx: number) => {
  const setter = Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(el, [...el.querySelectorAll("option")][idx].getAttribute("value"));
  el.dispatchEvent(new w.Event("change", { bubbles: true }));
};
// 状态=已闭环（选项：全部0/仅越限1/待处理2/处理中3/已闭环4）
await act(async () => setSelect(selects[2], 4));
check("筛选已闭环→1条", rowCount() === 1);
await act(async () => setSelect(selects[2], 0));
// 设备=主机
await act(async () => setSelect(selects[1], 1));
check("筛选设备主机→2条", rowCount() === 2);
// 保留 设备=主机 筛选，验证刷新后不丢
// 刷新持久化
await act(async () => {
  root.render(React.createElement(App));
});
await act(async () => findBtn!("历史记录")!.click());
check("刷新后记录仍在（持久化）", $$(".history-table tbody tr").length === 2);
check("筛选条件刷新不丢（设备仍为主机）", ($$(".filter-bar select")[1] as HTMLSelectElement).selectedOptions[0].textContent === "主机");
await act(async () => setSelect($$(".filter-bar select")[1], 0));
// 导出按钮存在且可点
let exported = false;
w.HTMLAnchorElement.prototype.click = function () { exported = true; };
await act(async () => findBtn!("导出 CSV")!.click());
check("导出触发下载", exported);

console.log("\n[G] 二次确认清空");
check("清空按钮初始态", !!findBtn!("清空全部"));
await act(async () => findBtn!("清空全部")!.click());
check("变为再次确认", !!findBtn!("再次点击确认清空"));
// 点取消后恢复
await act(async () => findBtn!("取消")!.click());
check("取消后恢复原按钮", !!findBtn!("清空全部"));

console.log(`\n🎉 DOM 冒烟 ${pass} 项全部通过`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
