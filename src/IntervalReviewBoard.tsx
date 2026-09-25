// 页面交互：音程复核板（筛选、录入、关联查看、复核与报告签发）
import { useEffect, useMemo, useState } from "react";
import { INTERVAL_DEFS } from "./intervalJudge";
import {
  intervalStatus,
  issueBlockers,
  issueReport,
  liveJudgement,
  loadState,
  remeasurePipe,
  reviewAllIntervals,
  reviewInterval,
  saveState,
} from "./reviewStore";
import type { IntervalStatus, PipeRecord, ReviewState } from "./reviewStore";

const STATUS_META: Record<IntervalStatus, { label: string; cls: string }> = {
  pass: { label: "合格", cls: "badge-pass" },
  fail: { label: "超限", cls: "badge-fail" },
  pending: { label: "待复核", cls: "badge-pending" },
  unmeasured: { label: "待测", cls: "badge-unmeasured" },
};

type StatusCounts = Record<IntervalStatus, number> & { total: number };

const emptyCounts = (): StatusCounts => ({ total: 0, pass: 0, fail: 0, pending: 0, unmeasured: 0 });

const fmtCents = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
const fmtTime = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("zh-CN", {
        hour12: false,
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

function StatusBadge({ status }: { status: IntervalStatus }) {
  const meta = STATUS_META[status];
  return <span className={`badge ${meta.cls}`}>{meta.label}</span>;
}

interface PipeGroup {
  key: string;
  venue: string;
  stop: string;
  octave: number;
  pipes: PipeRecord[];
}

export default function IntervalReviewBoard() {
  const [state, setState] = useState<ReviewState>(() => loadState());
  const [venue, setVenue] = useState("全部");
  const [stop, setStop] = useState("全部");
  const [octave, setOctave] = useState("全部");
  const [onlyFail, setOnlyFail] = useState(false);
  const [selectedPipeId, setSelectedPipeId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");

  // 数据只存本机
  useEffect(() => {
    saveState(state);
  }, [state]);

  const pipeById = useMemo(() => new Map(state.pipes.map((p) => [p.id, p])), [state.pipes]);

  const venues = useMemo(() => [...new Set(state.pipes.map((p) => p.venue))], [state.pipes]);
  const stops = useMemo(
    () => [...new Set(state.pipes.filter((p) => venue === "全部" || p.venue === venue).map((p) => p.stop))],
    [state.pipes, venue]
  );
  const octaves = useMemo(
    () => [...new Set(state.pipes.map((p) => p.octave))].sort((a, b) => a - b),
    [state.pipes]
  );

  const stats = useMemo(() => {
    const counts = emptyCounts();
    for (const iv of state.intervals) {
      counts.total += 1;
      counts[intervalStatus(state, iv)] += 1;
    }
    return counts;
  }, [state]);

  // 按场馆 → 音栓 → 八度组织音管
  const groups = useMemo<PipeGroup[]>(() => {
    const map = new Map<string, PipeGroup>();
    for (const p of state.pipes) {
      if (venue !== "全部" && p.venue !== venue) continue;
      if (stop !== "全部" && p.stop !== stop) continue;
      if (octave !== "全部" && p.octave !== Number(octave)) continue;
      const key = `${p.venue}::${p.stop}::${p.octave}`;
      let g = map.get(key);
      if (!g) {
        g = { key, venue: p.venue, stop: p.stop, octave: p.octave, pipes: [] };
        map.set(key, g);
      }
      g.pipes.push(p);
    }
    return [...map.values()];
  }, [state.pipes, venue, stop, octave]);

  const filteredIntervals = useMemo(
    () =>
      state.intervals.filter((iv) => {
        if (venue !== "全部" && iv.venue !== venue) return false;
        if (stop !== "全部" && iv.stop !== stop) return false;
        if (onlyFail && intervalStatus(state, iv) !== "fail") return false;
        return true;
      }),
    [state, venue, stop, onlyFail]
  );

  const selectedPipe = selectedPipeId ? (pipeById.get(selectedPipeId) ?? null) : null;
  const related = useMemo(
    () =>
      selectedPipeId
        ? state.intervals.filter((iv) => iv.lowerPipeId === selectedPipeId || iv.upperPipeId === selectedPipeId)
        : [],
    [state.intervals, selectedPipeId]
  );

  const venueCounts = (v: string): StatusCounts => {
    const counts = emptyCounts();
    for (const iv of state.intervals) {
      if (iv.venue !== v) continue;
      counts.total += 1;
      counts[intervalStatus(state, iv)] += 1;
    }
    return counts;
  };

  const handleMeasure = (pipeId: string) => {
    const raw = (drafts[pipeId] ?? "").trim();
    const freq = Number(raw);
    if (!raw || !Number.isFinite(freq) || freq < 15 || freq > 20000) {
      setNotice("请输入有效的实测频率（15–20000 Hz）");
      return;
    }
    const pipe = pipeById.get(pipeId);
    const cleared = state.intervals.filter(
      (iv) => (iv.lowerPipeId === pipeId || iv.upperPipeId === pipeId) && iv.conclusion
    ).length;
    setState((prev) => remeasurePipe(prev, pipeId, Math.round(freq * 1000) / 1000, new Date().toISOString()));
    setDrafts((d) => ({ ...d, [pipeId]: "" }));
    setSelectedPipeId(pipeId);
    setNotice(
      `已录入 ${pipe ? `${pipe.venue} · ${pipe.stop} · ${pipe.note}` : pipeId} = ${freq.toFixed(2)} Hz；` +
        `涉及它的 ${cleared} 条复核结论已清除（转入上次结论），其余音程结论继续有效`
    );
  };

  const handleReview = (intervalId: string) => {
    setState((prev) => reviewInterval(prev, intervalId, new Date().toISOString()));
  };

  const handleReviewAll = () => {
    setState((prev) => reviewAllIntervals(prev, new Date().toISOString()));
    setNotice("已用当前实测频率复核全部可判定音程");
  };

  const handleIssue = (v: string) => {
    const result = issueReport(state, v, new Date().toISOString());
    if (result.ok) {
      setState(result.state);
      setNotice(`${v} 的单次维护报告已签发（仅保存在本机）`);
    } else {
      setNotice(`${v} 不能签发：${result.blockers.join("；")}`);
    }
  };

  return (
    <section className="panel board">
      <div className="heading">
        <div>
          <p>音程复核</p>
          <h2>音程复核板</h2>
          <span className="muted">
            按场馆、音栓和八度组织音管，录入实测频率后比较纯五度与八度的偏差和拍频；重测某根管只清除涉及它的复核结论，
            仍有未通过音程时单次维护报告不能签发。数据仅保存本机。
          </span>
        </div>
        <button className="primary" onClick={handleReviewAll}>
          复核全部可判定音程
        </button>
      </div>

      {notice && <div className="notice">{notice}</div>}

      <div className="metrics metrics-5">
        <article>
          <small>音程总数</small>
          <strong>{stats.total}</strong>
        </article>
        <article>
          <small>合格</small>
          <strong>{stats.pass}</strong>
        </article>
        <article>
          <small>超限</small>
          <strong>{stats.fail}</strong>
        </article>
        <article>
          <small>待复核</small>
          <strong>{stats.pending}</strong>
        </article>
        <article>
          <small>待测</small>
          <strong>{stats.unmeasured}</strong>
        </article>
      </div>

      <div className="filter-bar">
        <label>
          <span>场馆</span>
          <select
            value={venue}
            onChange={(e) => {
              setVenue(e.target.value);
              setStop("全部");
            }}
          >
            <option>全部</option>
            {venues.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label>
          <span>音栓</span>
          <select value={stop} onChange={(e) => setStop(e.target.value)}>
            <option>全部</option>
            {stops.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          <span>八度</span>
          <select value={octave} onChange={(e) => setOctave(e.target.value)}>
            <option>全部</option>
            {octaves.map((o) => (
              <option key={o} value={o}>
                第 {o} 八度
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={onlyFail} onChange={(e) => setOnlyFail(e.target.checked)} />
          <span>仅看超限音程</span>
        </label>
      </div>

      <div className="board-grid">
        <div className="pipe-groups">
          {groups.map((g) => (
            <div className="pipe-group" key={g.key}>
              <h3>
                {g.venue} · {g.stop} · 第 {g.octave} 八度（{g.pipes.length} 管）
              </h3>
              <div className="table-wrap">
                <table className="pipe-table">
                  <thead>
                    <tr>
                      <th>音管</th>
                      <th>实测频率</th>
                      <th>录入 / 重测</th>
                      <th>测量时间</th>
                      <th>关联</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.pipes.map((p) => {
                      const relCount = state.intervals.filter(
                        (iv) => iv.lowerPipeId === p.id || iv.upperPipeId === p.id
                      ).length;
                      return (
                        <tr
                          key={p.id}
                          className={`selectable${selectedPipeId === p.id ? " selected" : ""}`}
                          onClick={() => setSelectedPipeId(p.id)}
                        >
                          <td>
                            <b>{p.note}</b> <span className="muted">MIDI {p.midi}</span>
                          </td>
                          <td>{p.measuredFreq ? `${p.measuredFreq.toFixed(2)} Hz` : <span className="muted">未测</span>}</td>
                          <td onClick={(e) => e.stopPropagation()}>
                            <div className="freq-cell">
                              <input
                                className="freq-input"
                                type="number"
                                step="0.01"
                                placeholder="Hz"
                                value={drafts[p.id] ?? ""}
                                onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                              />
                              <button className="mini" onClick={() => handleMeasure(p.id)}>
                                录入
                              </button>
                            </div>
                          </td>
                          <td className="muted">{fmtTime(p.measuredAt)}</td>
                          <td>{relCount} 个音程</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          {groups.length === 0 && <p className="muted">当前筛选条件下没有音管。</p>}
        </div>

        <aside className="related-panel">
          <h3>关联对象{selectedPipe ? `：${selectedPipe.note}` : ""}</h3>
          {!selectedPipe && <p className="muted">点击左侧任意音管，查看它参与的纯五度 / 八度音程及上次结论。</p>}
          {selectedPipe && (
            <p className="muted">
              {selectedPipe.venue} · {selectedPipe.stop} · 第 {selectedPipe.octave} 八度
            </p>
          )}
          {selectedPipe && related.length === 0 && <p className="muted">该管暂无关联音程。</p>}
          {related.map((iv) => {
            const isLower = iv.lowerPipeId === selectedPipeId;
            const other = pipeById.get(isLower ? iv.upperPipeId : iv.lowerPipeId);
            const live = liveJudgement(state, iv);
            return (
              <article className="related-item" key={iv.id}>
                <header>
                  <b>{INTERVAL_DEFS[iv.type].label}</b>
                  <span>
                    {isLower ? "本管为低音" : "本管为高音"} → 对方 {other?.note ?? "?"}
                  </span>
                  <StatusBadge status={intervalStatus(state, iv)} />
                </header>
                {live ? (
                  <p>
                    偏差 {fmtCents(live.deviationCents)} ¢ · 拍频 {live.beatHz.toFixed(2)} Hz
                  </p>
                ) : (
                  <p className="muted">尚有音管未实测，无法判定</p>
                )}
                {iv.lastConclusion && (
                  <p className="muted">
                    上次结论：{iv.lastConclusion.status === "pass" ? "合格" : "超限"}{" "}
                    {fmtCents(iv.lastConclusion.deviationCents)} ¢ / {iv.lastConclusion.beatHz.toFixed(2)} Hz（
                    {fmtTime(iv.lastConclusion.reviewedAt)}）
                  </p>
                )}
              </article>
            );
          })}
        </aside>
      </div>

      <div className="heading sub-heading">
        <div>
          <p>复核结论</p>
          <h2>音程列表{onlyFail ? "（仅超限）" : ""}</h2>
        </div>
      </div>
      <div className="table-wrap">
        <table className="interval-table">
          <thead>
            <tr>
              <th>音程</th>
              <th>类型</th>
              <th>实测偏差</th>
              <th>拍频</th>
              <th>结论</th>
              <th>上次结论</th>
              <th>复核时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {filteredIntervals.map((iv) => {
              const lower = pipeById.get(iv.lowerPipeId);
              const upper = pipeById.get(iv.upperPipeId);
              const live = liveJudgement(state, iv);
              return (
                <tr key={iv.id}>
                  <td>
                    <b>
                      {lower?.note} → {upper?.note}
                    </b>
                    <br />
                    <span className="muted">
                      {iv.venue} · {iv.stop}
                    </span>
                  </td>
                  <td>{INTERVAL_DEFS[iv.type].label}</td>
                  <td>{live ? `${fmtCents(live.deviationCents)} ¢` : "—"}</td>
                  <td>{live ? `${live.beatHz.toFixed(2)} Hz` : "—"}</td>
                  <td>
                    <StatusBadge status={intervalStatus(state, iv)} />
                  </td>
                  <td className="muted">
                    {iv.lastConclusion
                      ? `${iv.lastConclusion.status === "pass" ? "合格" : "超限"} ${fmtCents(iv.lastConclusion.deviationCents)} ¢`
                      : "—"}
                  </td>
                  <td className="muted">{fmtTime(iv.conclusion?.reviewedAt ?? null)}</td>
                  <td>
                    <button className="mini" disabled={!live} onClick={() => handleReview(iv.id)}>
                      复核
                    </button>
                  </td>
                </tr>
              );
            })}
            {filteredIntervals.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">
                  当前筛选条件下没有音程。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="heading sub-heading">
        <div>
          <p>报告签发</p>
          <h2>单次维护报告</h2>
        </div>
      </div>
      <div className="report-rows">
        {venues.map((v) => {
          const counts = venueCounts(v);
          const blockers = issueBlockers(state, v);
          const latest = state.reports.find((r) => r.venue === v);
          return (
            <div className="report-row" key={v}>
              <div>
                <b>{v}</b>
                <p className="muted">
                  合格 {counts.pass} / 共 {counts.total} · 超限 {counts.fail} · 待复核 {counts.pending} · 待测{" "}
                  {counts.unmeasured}
                </p>
                {blockers.length > 0 ? (
                  <p className="blocker">不能签发：{blockers.join("；")}</p>
                ) : (
                  <p className="ok-text">全部音程合格，可以签发</p>
                )}
                {latest && (
                  <p className="muted">
                    最近签发：{fmtTime(latest.issuedAt)}（覆盖 {latest.intervalCount} 个音程）
                  </p>
                )}
              </div>
              <button className="primary" disabled={blockers.length > 0} onClick={() => handleIssue(v)}>
                签发维护报告
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
