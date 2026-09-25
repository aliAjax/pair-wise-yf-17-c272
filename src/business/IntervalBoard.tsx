// 页面交互：音程复核板。筛选、录入 / 重测、关联对象查看、超限过滤与报告签发。

import { useEffect, useMemo, useState } from "react";
import {
  INTERVAL_LABEL,
  INTERVAL_THRESHOLDS,
  NOTE_NAMES,
  PipeRef,
  pipeKey,
  pipeLabel,
} from "./intervalJudge";
import {
  IntervalConclusion,
  PipeMeasurement,
  ReviewState,
  conclusionsFor,
  issueReport,
  loadState,
  persistState,
  pipesFor,
  relatedConclusions,
  reportGate,
  resetState,
  saveMeasurement,
} from "./reviewStore";

function fmtCents(v: number): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

interface FormState {
  venue: string;
  stop: string;
  octave: string;
  note: string;
  frequency: string;
}

export function IntervalBoard() {
  const [state, setState] = useState<ReviewState>(() => loadState());
  useEffect(() => {
    persistState(state);
  }, [state]);

  const [venue, setVenue] = useState("");
  const [stop, setStop] = useState("");
  const [octaveFilter, setOctaveFilter] = useState("all");
  const [onlyFail, setOnlyFail] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState<FormState>({
    venue: "",
    stop: "",
    octave: "4",
    note: "0",
    frequency: "",
  });

  const venues = useMemo(
    () => [...new Set(Object.values(state.measurements).map((m) => m.venue))],
    [state]
  );
  const activeVenue = venue || venues[0] || "";
  const stops = useMemo(
    () => [
      ...new Set(
        Object.values(state.measurements)
          .filter((m) => m.venue === activeVenue)
          .map((m) => m.stop)
      ),
    ],
    [state, activeVenue]
  );
  const activeStop = stops.includes(stop) ? stop : stops[0] || "";

  const pipes = useMemo(
    () => pipesFor(state, activeVenue, activeStop),
    [state, activeVenue, activeStop]
  );
  const conclusions = useMemo(
    () => conclusionsFor(state, activeVenue, activeStop),
    [state, activeVenue, activeStop]
  );
  const gate = useMemo(
    () => reportGate(state, activeVenue, activeStop),
    [state, activeVenue, activeStop]
  );

  const octaves = useMemo(
    () => [...new Set(pipes.map((p) => p.octave))].sort((a, b) => a - b),
    [pipes]
  );
  const failKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const c of conclusions) {
      if (!c.verdict.pass) {
        keys.add(pipeKey(c.lower));
        keys.add(pipeKey(c.upper));
      }
    }
    return keys;
  }, [conclusions]);

  const visibleConclusions = conclusions.filter((c) => {
    if (onlyFail && c.verdict.pass) return false;
    if (octaveFilter !== "all" && c.lower.octave !== Number(octaveFilter)) return false;
    return true;
  });

  const selected = selectedKey ? state.measurements[selectedKey] : undefined;
  const related = useMemo(
    () =>
      selected
        ? relatedConclusions(state, selected)
        : ([] as IntervalConclusion[]),
    [state, selected]
  );

  const reports = state.reports.filter(
    (r) => r.venue === activeVenue && r.stop === activeStop
  );

  const fillForm = (ref: PipeRef, frequency?: number) => {
    setForm({
      venue: ref.venue,
      stop: ref.stop,
      octave: String(ref.octave),
      note: String(ref.note),
      frequency: frequency !== undefined ? String(frequency) : "",
    });
  };

  const selectPipe = (m: PipeMeasurement) => {
    setSelectedKey(pipeKey(m));
    fillForm(m, m.frequency);
  };

  const handleSave = () => {
    const frequency = Number(form.frequency);
    const ref: PipeRef = {
      venue: form.venue.trim(),
      stop: form.stop.trim(),
      octave: Number(form.octave),
      note: Number(form.note),
    };
    if (!ref.venue || !ref.stop) {
      setNotice("请填写场馆和音栓名称。");
      return;
    }
    if (!Number.isFinite(frequency) || frequency < 15 || frequency > 20000) {
      setNotice("实测频率需在 15–20000 Hz 之间。");
      return;
    }
    const existed = Boolean(state.measurements[pipeKey(ref)]);
    const result = saveMeasurement(state, { ...ref, frequency });
    setState(result.state);
    setVenue(ref.venue);
    setStop(ref.stop);
    setSelectedKey(pipeKey(ref));
    setNotice(
      existed
        ? `${pipeLabel(ref)} 已重测为 ${frequency} Hz：涉及它的 ${result.cleared.length} 条旧结论已清除，其中 ${result.recomputed.length} 条按新频率重算，其余音程结论继续有效。`
        : `${pipeLabel(ref)} 已录入 ${frequency} Hz：新产生 ${result.recomputed.length} 条音程结论。`
    );
  };

  const handleIssue = () => {
    const result = issueReport(state, activeVenue, activeStop);
    if (!result) return;
    setState(result.state);
    setNotice(
      `${activeVenue} / ${activeStop} 的维护报告已签发（${result.report.passCount} 条音程全部通过）。`
    );
  };

  const handleReset = () => {
    if (window.confirm("将清空本机保存的全部复核数据并恢复示例，确定？")) {
      setState(resetState());
      setSelectedKey(null);
      setNotice("已恢复示例数据。");
    }
  };

  const byOctave = new Map<number, Map<number, PipeMeasurement>>();
  for (const p of pipes) {
    if (!byOctave.has(p.octave)) byOctave.set(p.octave, new Map());
    byOctave.get(p.octave)!.set(p.note, p);
  }

  return (
    <section className="panel board">
      <div className="heading">
        <div>
          <p>音程复核板</p>
          <h2>纯五度 / 八度复核</h2>
          <span className="muted">
            按场馆、音栓、八度组织音管，录入实测频率后自动比对纯律偏差与拍频；数据仅保存在本机。
          </span>
        </div>
        <button onClick={handleReset}>恢复示例数据</button>
      </div>

      {notice && <p className="notice">{notice}</p>}

      <div className="toolbar">
        <label>
          <span>场馆</span>
          <select
            value={activeVenue}
            onChange={(e) => {
              setVenue(e.target.value);
              setStop("");
            }}
          >
            {venues.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>音栓</span>
          <select value={activeStop} onChange={(e) => setStop(e.target.value)}>
            {stops.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>八度</span>
          <select value={octaveFilter} onChange={(e) => setOctaveFilter(e.target.value)}>
            <option value="all">全部八度</option>
            {octaves.map((o) => (
              <option key={o} value={o}>
                第 {o} 组
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={onlyFail}
            onChange={(e) => setOnlyFail(e.target.checked)}
          />
          <span>只看超限音程</span>
        </label>
      </div>

      <div className="metrics">
        <article>
          <small>已测音管</small>
          <strong>{gate.pipeCount}</strong>
        </article>
        <article>
          <small>结论通过</small>
          <strong>{gate.passCount}</strong>
        </article>
        <article>
          <small>结论超限</small>
          <strong>{gate.fails.length}</strong>
        </article>
        <article>
          <small>邻管待测</small>
          <strong>{gate.pending.length}</strong>
        </article>
      </div>

      <div className="entry-form">
        <h3>录入 / 重测实测频率</h3>
        <div className="form-row">
          <label>
            <span>场馆</span>
            <input
              list="venue-list"
              value={form.venue}
              placeholder="如 St.Mary 教堂"
              onChange={(e) => setForm({ ...form, venue: e.target.value })}
            />
            <datalist id="venue-list">
              {venues.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </label>
          <label>
            <span>音栓</span>
            <input
              list="stop-list"
              value={form.stop}
              placeholder="如 Principal 8'"
              onChange={(e) => setForm({ ...form, stop: e.target.value })}
            />
            <datalist id="stop-list">
              {stops.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </label>
          <label>
            <span>八度</span>
            <select
              value={form.octave}
              onChange={(e) => setForm({ ...form, octave: e.target.value })}
            >
              {[1, 2, 3, 4, 5, 6, 7].map((o) => (
                <option key={o} value={o}>
                  第 {o} 组
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>音名</span>
            <select
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
            >
              {NOTE_NAMES.map((n, i) => (
                <option key={n} value={i}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>实测频率 (Hz)</span>
            <input
              type="number"
              step="0.01"
              min="15"
              max="20000"
              value={form.frequency}
              placeholder="如 261.63"
              onChange={(e) => setForm({ ...form, frequency: e.target.value })}
            />
          </label>
          <button className="primary" onClick={handleSave}>
            保存 / 重测
          </button>
        </div>
      </div>

      <div className="board-grid">
        <div>
          <h3>音管一览（点击格子查看关联对象或重测）</h3>
          <table className="pipe-table">
            <thead>
              <tr>
                <th>八度</th>
                {NOTE_NAMES.map((n) => (
                  <th key={n}>{n}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...byOctave.keys()].sort((a, b) => a - b).map((o) => (
                <tr key={o}>
                  <th>第 {o} 组</th>
                  {NOTE_NAMES.map((_, n) => {
                    const m = byOctave.get(o)?.get(n);
                    if (!m) {
                      return (
                        <td
                          key={n}
                          className="pipe-cell empty"
                          title="点击快速录入这根管"
                          onClick={() =>
                            fillForm({ venue: activeVenue, stop: activeStop, octave: o, note: n })
                          }
                        >
                          —
                        </td>
                      );
                    }
                    const key = pipeKey(m);
                    const cls = [
                      "pipe-cell",
                      failKeys.has(key) ? "fail" : "ok",
                      key === selectedKey ? "selected" : "",
                    ]
                      .filter(Boolean)
                      .join(" ");
                    return (
                      <td key={n} className={cls} onClick={() => selectPipe(m)}>
                        <b>{pipeLabel(m)}</b>
                        <span>{m.frequency.toFixed(1)}Hz</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <aside>
          <h3>关联对象</h3>
          {!selected && <p className="muted">点击左侧音管，查看它参与的音程与上次结论。</p>}
          {selected && (
            <div className="rel-list">
              <p className="muted">
                {pipeLabel(selected)} · {selected.frequency.toFixed(2)} Hz · 测于{" "}
                {fmtTime(selected.measuredAt)}
              </p>
              {related.length === 0 && (
                <p className="muted">邻管未测，暂无关联音程结论。</p>
              )}
              {related.map((c) => {
                const partner =
                  pipeKey(c.lower) === selectedKey ? c.upper : c.lower;
                const partnerM = state.measurements[pipeKey(partner)];
                return (
                  <div className="rel-item" key={c.id}>
                    <div className="rel-head">
                      <b>
                        {INTERVAL_LABEL[c.kind]} · {pipeLabel(c.lower)} → {pipeLabel(c.upper)}
                      </b>
                      <span className={`badge ${c.verdict.pass ? "pass" : "fail"}`}>
                        {c.verdict.pass ? "通过" : "超限"}
                      </span>
                    </div>
                    <p className="muted">
                      关联管 {pipeLabel(partner)}（
                      {partnerM ? `${partnerM.frequency.toFixed(2)} Hz` : "未测"}） · 偏差{" "}
                      {fmtCents(c.verdict.deviationCents)}¢ · 拍频 {c.verdict.beatHz.toFixed(2)}{" "}
                      Hz · 更新于 {fmtTime(c.updatedAt)}
                    </p>
                    {!c.verdict.pass && (
                      <p className="fail-text">{c.verdict.reasons.join("；")}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </aside>
      </div>

      <div className="heading interval-heading">
        <div>
          <h3>音程结论</h3>
          <span className="muted">
            判定阈值：纯五度 ±{INTERVAL_THRESHOLDS.fifth.maxCents}¢、拍频 ≤
            {INTERVAL_THRESHOLDS.fifth.maxBeatHz}Hz 或共有泛音的{" "}
            {INTERVAL_THRESHOLDS.fifth.beatRatio * 100}%（取大者）；八度 ±
            {INTERVAL_THRESHOLDS.octave.maxCents}¢、拍频 ≤{INTERVAL_THRESHOLDS.octave.maxBeatHz}Hz
            或共有泛音的 {INTERVAL_THRESHOLDS.octave.beatRatio * 100}%
          </span>
        </div>
      </div>
      <table className="data-table">
        <thead>
          <tr>
            <th>类型</th>
            <th>组合</th>
            <th>音分偏差</th>
            <th>拍频 (Hz)</th>
            <th>结论</th>
            <th>更新时间</th>
          </tr>
        </thead>
        <tbody>
          {visibleConclusions.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                当前筛选下没有音程结论。
              </td>
            </tr>
          )}
          {visibleConclusions.map((c) => (
            <tr key={c.id} className={c.verdict.pass ? "" : "row-fail"}>
              <td>{INTERVAL_LABEL[c.kind]}</td>
              <td>
                {pipeLabel(c.lower)} → {pipeLabel(c.upper)}
              </td>
              <td>{fmtCents(c.verdict.deviationCents)}¢</td>
              <td>{c.verdict.beatHz.toFixed(2)}</td>
              <td>
                <span className={`badge ${c.verdict.pass ? "pass" : "fail"}`}>
                  {c.verdict.pass ? "通过" : "超限"}
                </span>
              </td>
              <td>{fmtTime(c.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="report-box">
        <div>
          <h3>
            单次维护报告 · {activeVenue} / {activeStop}
          </h3>
          {gate.pipeCount === 0 && <p className="muted">尚未录入音管，无法签发。</p>}
          {gate.pipeCount > 0 && gate.fails.length > 0 && (
            <p className="fail-text">
              仍有 {gate.fails.length} 条音程未通过，报告不能签发：
              {gate.fails
                .map((f) => `${pipeLabel(f.lower)}–${pipeLabel(f.upper)}`)
                .join("、")}
            </p>
          )}
          {gate.pipeCount > 0 && gate.fails.length === 0 && (
            <p className="ok-text">全部 {gate.passCount} 条音程结论通过，可以签发。</p>
          )}
          {gate.pending.length > 0 && (
            <p className="muted">另有 {gate.pending.length} 条音程邻管未测（不阻塞签发）。</p>
          )}
        </div>
        <button className="primary" disabled={!gate.canIssue} onClick={handleIssue}>
          签发维护报告
        </button>
      </div>

      {reports.length > 0 && (
        <ul className="report-list">
          {reports.map((r) => (
            <li key={r.id}>
              已于 {fmtTime(r.issuedAt)} 签发 · {r.pipeCount} 根音管 · {r.passCount} 条音程通过
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
