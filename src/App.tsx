import { useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";
import { BILGE_OPTIONS, DEVICES, INSPECTIONS, INSPECTION_MAP, readingText } from "./constants";
import { buildExportCsv, buildHandoverSummary } from "./export";
import { DEFAULT_FILTERS, filterRecords, type HistoryFilters } from "./selectors";
import {
  activeShift,
  addRecord,
  createShift,
  handover,
  isShiftLocked,
  loadState,
  saveState,
  transitionAnomaly,
} from "./store";
import type {
  Anomaly,
  AnomalyStatus,
  AppState,
  BilgeState,
  InspectionRecord,
  InspectionType,
  Shift,
} from "./types";
import { STATUS_LABEL } from "./types";
import { download, fmtTime, fmtTimeFull, summarizeByDevice } from "./utils";

type Tab = "dashboard" | "entry" | "anomaly" | "handover" | "history";

const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: "dashboard", label: "值班看板", hint: "班次 · 机舱参数 · 异常时间线" },
  { key: "entry", label: "巡检录入", hint: "六类巡检数据" },
  { key: "anomaly", label: "异常处理", hint: "待处理 → 处理中 → 已闭环" },
  { key: "handover", label: "交接班", hint: "按设备汇总 · 结转未闭环" },
  { key: "history", label: "历史记录", hint: "筛选 · 导出 · 清空" },
];

const SHIFT_SUGGEST = ["00-04班", "04-08班", "08-12班", "12-16班", "16-20班", "20-24班"];

// ---------------- 通用组件 ----------------

function Badge({ status }: { status: AnomalyStatus }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABEL[status]}</span>;
}

function Toast({ msg, kind }: { msg: string; kind: "error" | "ok" }) {
  return <div className={`toast toast-${kind}`}>{kind === "error" ? "⛔ " : "✅ "}{msg}</div>;
}

function Modal({
  title,
  children,
  onClose,
  width = 520,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  width?: number;
}) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" style={{ width }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------------- 开设班次弹窗 ----------------

function NewShiftModal({
  state,
  onClose,
  onCommit,
}: {
  state: AppState;
  onClose: () => void;
  onCommit: (next: AppState) => void;
}) {
  const [name, setName] = useState("");
  const [operator, setOperator] = useState("");
  const [err, setErr] = useState("");

  const submit = () => {
    try {
      onCommit(createShift(state, { name, operator }));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <Modal title="开设值班班次" onClose={onClose}>
      <div className="form-stack">
        <label>
          <span>班次名称 *</span>
          <input
            value={name}
            placeholder="如 08-12班"
            onChange={(e) => setName(e.target.value)}
            list="shift-suggest"
          />
          <datalist id="shift-suggest">
            {SHIFT_SUGGEST.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>
        <div className="chips chips-tight">
          {SHIFT_SUGGEST.filter((s) => !state.shifts.some((x) => x.name === s)).map((s) => (
            <button key={s} type="button" onClick={() => setName(s)}>
              {s}
            </button>
          ))}
        </div>
        <label>
          <span>值班轮机员 *</span>
          <input value={operator} placeholder="姓名 / 工号" onChange={(e) => setOperator(e.target.value)} />
        </label>
        {err && <p className="form-error">{err}</p>}
        <div className="modal-actions">
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={submit}>
            开班
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------- 值班看板 ----------------

function Dashboard({
  state,
  shift,
  onNewShift,
  go,
}: {
  state: AppState;
  shift: Shift | null;
  onNewShift: () => void;
  go: (t: Tab) => void;
}) {
  const latestByType = useMemo(() => {
    const map = new Map<InspectionType, InspectionRecord>();
    for (const r of state.records) {
      if (shift && r.shiftId !== shift.id) continue;
      const prev = map.get(r.type);
      if (!prev || r.time > prev.time) map.set(r.type, r);
    }
    return map;
  }, [state.records, shift]);

  const timeline = useMemo(
    () =>
      [...state.anomalies]
        .filter((a) => (shift ? a.currentShiftId === shift.id || a.shiftId === shift.id : true))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 8),
    [state.anomalies, shift],
  );

  return (
    <>
      <section className="panel shift-bar">
        <div>
          <p className="eyebrow">当前班次</p>
          {shift ? (
            <h2>
              {shift.name}
              {isShiftLocked(shift) ? <span className="tag tag-locked">已交接 · 只读</span> : <span className="tag tag-live">值班中</span>}
            </h2>
          ) : (
            <h2>尚未开班</h2>
          )}
          {shift && (
            <p className="muted">
              轮机员 {shift.operator} · 起 {fmtTime(shift.start)}
              {shift.handedOverAt ? ` · 止 ${fmtTime(shift.handedOverAt)}` : ""}
              {shift.prevShiftId && (
                <> · 接 {state.shifts.find((s) => s.id === shift.prevShiftId)?.name}</>
              )}
            </p>
          )}
        </div>
        <div className="shift-actions">
          {!shift || isShiftLocked(shift) ? (
            <button className="primary" onClick={onNewShift}>
              开设班次
            </button>
          ) : (
            <button className="primary" onClick={() => go("handover")}>
              去交接班
            </button>
          )}
        </div>
      </section>

      <section className="metrics">
        {INSPECTIONS.map((def) => {
          const rec = latestByType.get(def.type);
          const alarm = rec?.outOfRange;
          return (
            <article key={def.type} className={alarm ? "metric-alarm" : ""}>
              <small>{def.label}</small>
              <strong>
                {rec ? readingText(def.type, rec.value, rec.text) : def.placeholder}
                {rec && def.numeric && <em>{def.unit}</em>}
              </strong>
              <span className={`metric-state ${alarm ? "text-alarm" : "text-ok"}`}>
                {rec ? (alarm ? "⚠ 越限已生成异常" : "正常") : shift ? "本班未录入" : "—"}
              </span>
            </article>
          );
        })}
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p className="eyebrow">异常记录时间线</p>
            <h2>最近异常动态</h2>
          </div>
          <button onClick={() => go("anomaly")}>前往处理 →</button>
        </div>
        {timeline.length === 0 ? (
          <p className="muted">暂无异常记录，巡检读数越限或人工巡检登记后将自动出现在这里。</p>
        ) : (
          <ol className="timeline">
            {timeline.map((a) => (
              <li key={a.id} className={`tl tl-${a.status}`}>
                <div className="tl-dot" />
                <div className="tl-body">
                  <div className="tl-title">
                    <b>{a.title}</b>
                    <Badge status={a.status} />
                    <span className="muted">{a.device}</span>
                  </div>
                  <p>
                    {a.reading} · 发现于 {state.shifts.find((s) => s.id === a.shiftId)?.name ?? "—"} ·{" "}
                    {fmtTime(a.createdAt)}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

// ---------------- 巡检录入 ----------------

function EntryPanel({
  state,
  shift,
  onCommit,
  onNewShift,
}: {
  state: AppState;
  shift: Shift | null;
  onCommit: (next: AppState, toast: string) => void;
  onNewShift: () => void;
}) {
  const [type, setType] = useState<InspectionType>("hostRpm");
  const [num, setNum] = useState("");
  const [bilge, setBilge] = useState<BilgeState | "">("");
  const [text, setText] = useState("");
  const [device, setDevice] = useState("");
  const [err, setErr] = useState("");
  const def = INSPECTION_MAP[type];
  const locked = !shift || isShiftLocked(shift);

  const pickType = (t: InspectionType) => {
    setType(t);
    setErr("");
    setNum("");
    setBilge("");
    setText("");
    setDevice(INSPECTION_MAP[t].device);
  };

  useEffect(() => {
    setDevice(def.device);
  }, [def.device]);

  const submit = () => {
    setErr("");
    if (def.numeric) {
      if (num.trim() === "") {
        setErr(`${def.label}读数不能为空`);
        return;
      }
      const v = Number(num);
      if (Number.isNaN(v)) {
        setErr(`${def.label}读数必须是数字`);
        return;
      }
      try {
        const next = addRecord(state, { type, value: v });
        onCommit(next, `已录入 ${def.label} ${v}${def.unit}${isOut(next) ? "，越限已自动生成异常单" : ""}`);
        setNum("");
      } catch (e) {
        setErr((e as Error).message);
      }
      return;
    }
    if (type === "bilge") {
      if (!bilge) {
        setErr("请选择舱底水状态，禁止空提交");
        return;
      }
      try {
        const next = addRecord(state, { type, bilge });
        onCommit(next, `已记录舱底水：${BILGE_OPTIONS.find((o) => o.value === bilge)?.label}${isOut(next) ? "，已自动生成异常单" : ""}`);
        setBilge("");
      } catch (e) {
        setErr((e as Error).message);
      }
      return;
    }
    // manual
    if (!text.trim()) {
      setErr("异常巡检项描述不能为空");
      return;
    }
    try {
      const next = addRecord(state, { type, text, device: device || def.device });
      onCommit(next, "人工巡检异常已登记并生成异常单");
      setText("");
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const isOut = (next: AppState) => next.records[next.records.length - 1]?.outOfRange;

  const recent = state.records
    .filter((r) => shift && r.shiftId === shift.id)
    .slice(-6)
    .reverse();

  if (!shift) {
    return (
      <section className="panel empty-box">
        <h2>还没有值班班次</h2>
        <p className="muted">请先开设班次，再录入六类巡检数据。</p>
        <button className="primary" onClick={onNewShift}>
          开设班次
        </button>
      </section>
    );
  }

  return (
    <div className="entry-grid">
      <section className="panel">
        <div className="heading">
          <div>
            <p className="eyebrow">{shift.name} · {shift.operator}</p>
            <h2>巡检数据录入</h2>
          </div>
          {locked && <span className="tag tag-locked">旧班次只读</span>}
        </div>

        <div className="type-tabs">
          {INSPECTIONS.map((d) => (
            <button
              key={d.type}
              type="button"
              className={d.type === type ? "type-tab active" : "type-tab"}
              onClick={() => pickType(d.type)}
            >
              {d.label}
            </button>
          ))}
        </div>

        {!locked && (
          <div className="form-stack">
            {def.numeric && (
              <>
                <label>
                  <span>
                    {def.label}读数 *（正常 {def.normalRange.min}~{def.normalRange.max}
                    {def.unit}，允许量程 {def.hardRange.min}~{def.hardRange.max}
                    {def.unit}）
                  </span>
                  <input
                    inputMode="decimal"
                    value={num}
                    placeholder={`输入${def.label}，单位 ${def.unit}`}
                    onChange={(e) => setNum(e.target.value)}
                  />
                </label>
                <p className="hint">
                  读数超出正常区间但仍在量程内：保存并自动关联「{def.device}」生成异常单；超出量程一律拦截。
                </p>
              </>
            )}

            {type === "bilge" && (
              <label>
                <span>舱底水状态 *</span>
                <div className="radio-row">
                  {BILGE_OPTIONS.map((o) => (
                    <button
                      type="button"
                      key={o.value}
                      className={bilge === o.value ? "radio-pill active" : "radio-pill"}
                      onClick={() => setBilge(o.value)}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </label>
            )}

            {type === "manual" && (
              <>
                <label>
                  <span>关联设备 *</span>
                  <select value={device} onChange={(e) => setDevice(e.target.value)}>
                    {DEVICES.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>异常巡检描述 *</span>
                  <textarea
                    rows={3}
                    value={text}
                    placeholder="如：#2缸排气温度偏高，排烟颜色异常，伴随轻微敲缸声"
                    onChange={(e) => setText(e.target.value)}
                  />
                </label>
              </>
            )}

            {err && <p className="form-error">{err}</p>}
            <div className="modal-actions">
              <button
                className="primary"
                onClick={submit}
                disabled={locked}
              >
                提交巡检记录
              </button>
            </div>
          </div>
        )}
        {locked && <p className="form-error">班次「{shift.name}」已交接，记录只读，不能继续录入。</p>}
      </section>

      <section className="panel">
        <p className="eyebrow">本班最近录入</p>
        {recent.length === 0 ? (
          <p className="muted">本班暂无录入。</p>
        ) : (
          <div className="records">
            {recent.map((r) => (
              <article key={r.id}>
                <b className={r.outOfRange ? "idx-alarm" : ""}>{INSPECTION_MAP[r.type].short.slice(0, 2)}</b>
                <div>
                  <h3>
                    {INSPECTION_MAP[r.type].label} · {r.device}
                    {r.outOfRange && <span className="tag tag-alarm">越限</span>}
                  </h3>
                  <p>
                    {readingText(r.type, r.value, r.text)} · {fmtTime(r.time)} · {r.operator}
                  </p>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------- 异常处理 ----------------

function AnomalyPanel({
  state,
  shift,
  onCommit,
}: {
  state: AppState;
  shift: Shift | null;
  onCommit: (next: AppState, toast: string) => void;
}) {
  const [filter, setFilter] = useState<AnomalyStatus | "all">("all");
  const [acting, setActing] = useState<Anomaly | null>(null);

  const groups: { key: AnomalyStatus; title: string }[] = [
    { key: "open", title: "待处理" },
    { key: "progress", title: "处理中" },
    { key: "closed", title: "已闭环" },
  ];

  const inCurrent = (a: Anomaly) => shift && a.currentShiftId === shift.id;

  return (
    <>
      <section className="panel">
        <div className="heading">
          <div>
            <p className="eyebrow">异常流转</p>
            <h2>异常处理台账</h2>
          </div>
          <div className="seg">
            {(["all", "open", "progress", "closed"] as const).map((s) => (
              <button key={s} className={filter === s ? "seg-btn active" : "seg-btn"} onClick={() => setFilter(s)}>
                {s === "all" ? "全部" : STATUS_LABEL[s]}
                <em>{s === "all" ? state.anomalies.length : state.anomalies.filter((a) => a.status === s).length}</em>
              </button>
            ))}
          </div>
        </div>

        {!shift && <p className="muted">尚未开班。</p>}

        {groups.map((g) => {
          const list = state.anomalies
            .filter((a) => a.status === g.key)
            .filter((a) => (filter === "all" ? true : a.status === filter))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          if (filter !== "all" && g.key !== filter) return null;
          return (
            <div key={g.key} className="anomaly-group">
              <h3 className="group-title">
                {g.title} <em>{list.length}</em>
              </h3>
              {list.length === 0 && <p className="muted">暂无</p>}
              {list.map((a) => {
                const here = inCurrent(a);
                const shiftName = state.shifts.find((s) => s.id === a.currentShiftId)?.name ?? "—";
                return (
                  <article key={a.id} className="anomaly-card">
                    <div className="anomaly-main">
                      <div className="tl-title">
                        <b>{a.title}</b>
                        <Badge status={a.status} />
                        <span className="muted">{a.device}</span>
                        {!here && <span className="tag tag-locked">归属 {shiftName}</span>}
                        {a.shiftId !== a.currentShiftId && here && <span className="tag tag-carry">上一班结转</span>}
                      </div>
                      <p className="anomaly-detail">{a.detail}</p>
                      <p className="muted">
                        触发读数 {a.reading} · 发现于 {state.shifts.find((s) => s.id === a.shiftId)?.name} ·{" "}
                        {fmtTime(a.createdAt)}
                      </p>
                      {a.resolution && <p className="resolution">处置说明：{a.resolution}</p>}
                    </div>
                    <div className="anomaly-actions">
                      {here && !isShiftLocked(shift) && a.status === "open" && (
                        <button className="primary" onClick={() => setActing(a)}>
                          开始处理
                        </button>
                      )}
                      {here && !isShiftLocked(shift) && a.status === "progress" && (
                        <>
                          <button onClick={() => setActing(a)}>退回待处理</button>
                          <button className="primary" onClick={() => setActing(a)}>
                            闭环
                          </button>
                        </>
                      )}
                      <button className="ghost" onClick={() => setActing(a)}>
                        流转记录
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          );
        })}
      </section>

      {acting && (
        <TransitionModal
          state={state}
          anomaly={acting}
          onClose={() => setActing(null)}
          onCommit={(next, msg) => {
            setActing(null);
            onCommit(next, msg);
          }}
        />
      )}
    </>
  );
}

function TransitionModal({
  state,
  anomaly,
  onClose,
  onCommit,
}: {
  state: AppState;
  anomaly: Anomaly;
  onClose: () => void;
  onCommit: (next: AppState, msg: string) => void;
}) {
  const options: { to: AnomalyStatus; label: string; require: string }[] = [];
  if (anomaly.status === "open") options.push({ to: "progress", label: "开始处理", require: "请填写处理措施" });
  if (anomaly.status === "progress") {
    options.push({ to: "open", label: "退回待处理", require: "说明退回原因（可选）" });
    options.push({ to: "closed", label: "确认闭环", require: "闭环处置说明（必填）" });
  }
  const [target, setTarget] = useState<AnomalyStatus | null>(options[0]?.to ?? null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const viewOnly = options.length === 0;

  const submit = () => {
    if (!target) return;
    try {
      const next = transitionAnomaly(state, anomaly.id, target, note);
      onCommit(next, `异常已流转为「${STATUS_LABEL[target]}」`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <Modal title={viewOnly ? "异常流转记录" : `处理异常 · ${anomaly.title}`} onClose={onClose} width={580}>
      <div className="form-stack">
        <p className="muted">
          {anomaly.device} · 当前状态 <Badge status={anomaly.status} />
        </p>
        {!viewOnly && (
          <>
            <div className="radio-row">
              {options.map((o) => (
                <button
                  type="button"
                  key={o.to}
                  className={target === o.to ? "radio-pill active" : "radio-pill"}
                  onClick={() => setTarget(o.to)}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <label>
              <span>{options.find((o) => o.to === target)?.require}</span>
              <textarea
                rows={3}
                value={note}
                placeholder={target === "closed" ? "必须填写处置说明后才能闭环，如：更换#2喷油器，复测参数恢复正常" : "填写处理措施 / 备注"}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            {err && <p className="form-error">{err}</p>}
          </>
        )}
        <div className="log-list">
          {anomaly.logs.map((l, i) => (
            <div key={i} className="log-item">
              <span className="muted">{fmtTimeFull(l.time)}</span>
              <b>
                {l.from === null ? "建单" : STATUS_LABEL[l.from]} → {STATUS_LABEL[l.to]}
              </b>
              <span>{l.note}</span>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button onClick={onClose}>{viewOnly ? "关闭" : "取消"}</button>
          {!viewOnly && (
            <button className="primary" onClick={submit}>
              确认提交
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ---------------- 交接班 ----------------

function HandoverPanel({
  state,
  shift,
  onCommit,
  onNewShift,
}: {
  state: AppState;
  shift: Shift | null;
  onCommit: (next: AppState, msg: string) => void;
  onNewShift: () => void;
}) {
  const [nextName, setNextName] = useState("");
  const [nextOperator, setNextOperator] = useState("");
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState("");

  if (!shift) {
    return (
      <section className="panel empty-box">
        <h2>没有进行中的班次</h2>
        <p className="muted">开设班次并完成巡检后，才能进行交接班。</p>
        <button className="primary" onClick={onNewShift}>
          开设班次
        </button>
      </section>
    );
  }

  if (isShiftLocked(shift)) {
    return (
      <section className="panel empty-box">
        <h2>班次「{shift.name}」已交接（只读）</h2>
        <p className="muted">
          交接时间 {fmtTimeFull(shift.handedOverAt!)}，交接备注：{shift.handoverNote}
        </p>
        <button className="primary" onClick={onNewShift}>
          开设下一班次
        </button>
      </section>
    );
  }

  const records = state.records.filter((r) => r.shiftId === shift.id);
  const open = state.anomalies.filter((a) => a.currentShiftId === shift.id && a.status !== "closed");
  const closed = state.anomalies.filter((a) => a.shiftId === shift.id && a.status === "closed");
  const byDevice = summarizeByDevice(records);
  const anomalyDevice = summarizeByDevice(open);

  const doHandover = () => {
    try {
      const next = handover(state, { note, nextName, nextOperator });
      setConfirm(false);
      onCommit(next, `已交接至 ${nextName.trim()}，${open.length} 项未闭环异常已结转`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="handover-grid">
      <section className="panel">
        <p className="eyebrow">交接摘要 · 按设备汇总</p>
        <h2>
          {shift.name} <span className="muted small">（{shift.operator}）</span>
        </h2>
        <div className="summary-stat">
          <span>巡检 {records.length} 条</span>
          <span className="text-alarm">未闭环 {open.length}</span>
          <span className="text-ok">本班闭环 {closed.length}</span>
        </div>
        {[...byDevice.keys()].length === 0 && <p className="muted">本班暂无巡检记录。</p>}
        {[...byDevice.entries()].map(([device, recs]) => (
          <div key={device} className="device-block">
            <h4>
              {device}
              <em>{recs.length} 条</em>
            </h4>
            <ul>
              {recs.map((r) => (
                <li key={r.id} className={r.outOfRange ? "text-alarm" : ""}>
                  {fmtTime(r.time)} · {INSPECTION_MAP[r.type].label}：{readingText(r.type, r.value, r.text)}
                  {r.outOfRange && " ⚠"}
                </li>
              ))}
            </ul>
            {(anomalyDevice.get(device) ?? []).map((a) => (
              <p key={a.id} className="carry-line">
                ▶ 结转异常：{a.title}（{STATUS_LABEL[a.status]}，{a.reading}）
              </p>
            ))}
          </div>
        ))}
        {open.filter((a) => !byDevice.has(a.device)).length > 0 && (
          <div className="device-block">
            <h4>仅异常（本班无该设备巡检记录）</h4>
            {open
              .filter((a) => !byDevice.has(a.device))
              .map((a) => (
                <p key={a.id} className="carry-line">
                  ▶ {a.device} · {a.title}（{STATUS_LABEL[a.status]}）
                </p>
              ))}
          </div>
        )}
        <button
          onClick={() =>
            download(`交接摘要_${shift.name}.txt`, buildHandoverSummary(state, shift.id), "text/plain;charset=utf-8")
          }
        >
          导出本班摘要 TXT
        </button>
      </section>

      <section className="panel">
        <p className="eyebrow">执行交接</p>
        <h2>移交给下一班</h2>
        <div className="form-stack">
          <label>
            <span>新班次名称 *</span>
            <input value={nextName} placeholder="如 12-16班" list="shift-suggest" onChange={(e) => setNextName(e.target.value)} />
          </label>
          <label>
            <span>接班轮机员 *</span>
            <input value={nextOperator} placeholder="姓名 / 工号" onChange={(e) => setNextOperator(e.target.value)} />
          </label>
          <label>
            <span>交接备注 *</span>
            <textarea
              rows={3}
              value={note}
              placeholder="如：舱底水位持续观察；#2发电机水温偏高，下一班复测"
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          {err && <p className="form-error">{err}</p>}
          <div className="notice-warn">
            交接后「{shift.name}」将变为只读；{open.length} 项未闭环异常会连同原始记录带入新班次继续跟进。
          </div>
          <div className="modal-actions">
            <button
              className="primary"
              onClick={() => {
                setErr("");
                if (!nextName.trim() || !nextOperator.trim() || !note.trim()) {
                  setErr("新班次、接班轮机员、交接备注均不能为空");
                  return;
                }
                if (state.shifts.some((s) => s.name === nextName.trim())) {
                  setErr(`班次「${nextName.trim()}」已存在，重复班次禁止开设`);
                  return;
                }
                setConfirm(true);
              }}
            >
              确认交接班
            </button>
          </div>
        </div>
      </section>

      {confirm && (
        <Modal title="确认交接班" onClose={() => setConfirm(false)}>
          <div className="form-stack">
            <p>
              确认由「{shift.name}（{shift.operator}）」交接给「{nextName.trim()}（{nextOperator.trim()}）」？
            </p>
            <div className="notice-warn">
              交接后旧班次立即转为只读；{open.length} 项未闭环异常将连同原巡检记录带入新班次，无法撤销。
            </div>
            {err && <p className="form-error">{err}</p>}
            <div className="modal-actions">
              <button onClick={() => setConfirm(false)}>再检查一下</button>
              <button className="primary" onClick={doHandover}>
                确认交接
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------- 历史记录 ----------------

function HistoryPanel({ state }: { state: AppState }) {
  const [filters, setFilters] = useState<HistoryFilters>(() => {
    try {
      const raw = localStorage.getItem("marine-watch-history-filters");
      return raw ? { ...DEFAULT_FILTERS, ...JSON.parse(raw) } : DEFAULT_FILTERS;
    } catch {
      return DEFAULT_FILTERS;
    }
  });
  const [clearStep, setClearStep] = useState(0);
  const clearTimer = useRef<number | null>(null);

  useEffect(() => {
    localStorage.setItem("marine-watch-history-filters", JSON.stringify(filters));
  }, [filters]);

  useEffect(() => () => {
    if (clearTimer.current) window.clearTimeout(clearTimer.current);
  }, []);

  const filtered = useMemo(() => filterRecords(state, filters), [state, filters]);

  const doExport = () => {
    const slice: AppState = {
      ...state,
      records: filtered,
      anomalies:
        filters.shiftId === "all" && filters.device === "all" && filters.status === "all" && !filters.kw.trim()
          ? state.anomalies
          : state.anomalies.filter((a) => filtered.some((r) => r.anomalyId === a.id) || (filters.device !== "all" && a.device === filters.device)),
    };
    download(`轮机值班记录_${new Date().toISOString().slice(0, 10)}.csv`, buildExportCsv(slice), "text/csv;charset=utf-8");
  };

  const shiftName = (id: string) => state.shifts.find((s) => s.id === id)?.name ?? id;

  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p className="eyebrow">历史记录</p>
          <h2>巡检台账（共 {filtered.length} 条 / 全部 {state.records.length} 条）</h2>
        </div>
        <div className="shift-actions">
          <button onClick={doExport} disabled={state.records.length === 0}>
            导出 CSV
          </button>
          {clearStep === 0 && (
            <button className="danger" disabled={state.records.length === 0 && state.shifts.length === 0} onClick={() => setClearStep(1)}>
              清空全部
            </button>
          )}
          {clearStep === 1 && (
            <button
              className="danger"
              onClick={() => {
                localStorage.clear();
                window.location.reload();
              }}
              onMouseLeave={() => {
                clearTimer.current = window.setTimeout(() => setClearStep(0), 2500);
              }}
            >
              再次点击确认清空
            </button>
          )}
          {clearStep === 1 && <button onClick={() => setClearStep(0)}>取消</button>}
        </div>
      </div>

      <div className="filter-bar">
        <label>
          <span>班次</span>
          <select value={filters.shiftId} onChange={(e) => setFilters({ ...filters, shiftId: e.target.value })}>
            <option value="all">全部班次</option>
            {state.shifts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}{s.handedOverAt ? "（已交接）" : "（值班中）"}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>设备</span>
          <select value={filters.device} onChange={(e) => setFilters({ ...filters, device: e.target.value })}>
            <option value="all">全部设备</option>
            {DEVICES.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>状态</span>
          <select
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value as HistoryFilters["status"] })}
          >
            <option value="all">全部</option>
            <option value="out">仅越限记录</option>
            <option value="open">异常·待处理</option>
            <option value="progress">异常·处理中</option>
            <option value="closed">异常·已闭环</option>
          </select>
        </label>
        <label className="kw">
          <span>关键字</span>
          <input value={filters.kw} placeholder="设备 / 读数 / 轮机员" onChange={(e) => setFilters({ ...filters, kw: e.target.value })} />
        </label>
        <button onClick={() => setFilters(DEFAULT_FILTERS)}>重置筛选</button>
      </div>

      {filtered.length === 0 ? (
        <p className="muted">没有符合筛选条件的记录。</p>
      ) : (
        <div className="table-wrap">
          <table className="history-table">
            <thead>
              <tr>
                <th>班次</th>
                <th>时间</th>
                <th>类别</th>
                <th>设备</th>
                <th>读数/状态</th>
                <th>状态</th>
                <th>轮机员</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const a = r.anomalyId ? state.anomalies.find((x) => x.id === r.anomalyId) : null;
                return (
                  <tr key={r.id} className={r.outOfRange ? "row-alarm" : ""}>
                    <td>{shiftName(r.shiftId)}</td>
                    <td>{fmtTime(r.time)}</td>
                    <td>{INSPECTION_MAP[r.type].label}</td>
                    <td>{r.device}</td>
                    <td>{readingText(r.type, r.value, r.text)}</td>
                    <td>{a ? <Badge status={a.status} /> : <span className="text-ok">正常</span>}</td>
                    <td>{r.operator}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------- 主框架 ----------------

function App() {
  const [state, setState] = useState<AppState>(() => loadState());
  const [tab, setTab] = useState<Tab>("dashboard");
  const [showNewShift, setShowNewShift] = useState(false);
  const [toast, setToast] = useState<{ msg: string; kind: "error" | "ok" } | null>(null);
  const toastTimer = useRef<number | null>(null);

  useEffect(() => {
    saveState(state);
  }, [state]);

  const shift = activeShift(state);

  const flash = (msg: string, kind: "error" | "ok" = "ok") => {
    setToast({ msg, kind });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  };

  const commit = (next: AppState, msg?: string) => {
    setState(next);
    if (msg) flash(msg, "ok");
  };

  const openCount = state.anomalies.filter((a) => a.status === "open").length;

  return (
    <main className="app">
      <section className="hero">
        <p>船舶轮机值班记录 · 值班闭环</p>
        <h1>轮机值班记录系统</h1>
        <span>
          按班次录入六类巡检数据，读数越限自动关联设备生成异常；异常经「待处理 → 处理中 → 已闭环」推进，闭环必须填写处置说明；交接后旧班次只读、未闭环异常结转新班次；历史可筛选、导出，数据保存在浏览器本地，刷新不丢。
        </span>
      </section>

      <nav className="tabbar">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? "tab active" : "tab"} onClick={() => setTab(t.key)}>
            <b>{t.label}</b>
            {t.key === "anomaly" && openCount > 0 && <span className="tab-dot">{openCount}</span>}
            <small>{t.hint}</small>
          </button>
        ))}
      </nav>

      {tab === "dashboard" && (
        <Dashboard state={state} shift={shift} onNewShift={() => setShowNewShift(true)} go={setTab} />
      )}
      {tab === "entry" && (
        <EntryPanel state={state} shift={shift} onCommit={commit} onNewShift={() => setShowNewShift(true)} />
      )}
      {tab === "anomaly" && <AnomalyPanel state={state} shift={shift} onCommit={commit} />}
      {tab === "handover" && (
        <HandoverPanel state={state} shift={shift} onCommit={commit} onNewShift={() => setShowNewShift(true)} />
      )}
      {tab === "history" && <HistoryPanel state={state} />}

      {showNewShift && (
        <NewShiftModal
          state={state}
          onClose={() => setShowNewShift(false)}
          onCommit={(next) => {
            setShowNewShift(false);
            setState(next);
            flash("班次已开设", "ok");
            setTab("entry");
          }}
        />
      )}
      {toast && <Toast msg={toast.msg} kind={toast.kind} />}
    </main>
  );
}

export default App;
