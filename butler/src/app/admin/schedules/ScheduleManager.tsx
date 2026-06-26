"use client";

import { useMemo, useState } from "react";
import type { ManagedScheduleJob, SchedulerAction, SchedulerDashboard } from "@/lib/cloud-scheduler";

export default function ScheduleManager({ initialData }: { initialData: SchedulerDashboard }) {
  const [data, setData] = useState(initialData);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const totals = useMemo(() => {
    const enabled = data.jobs.filter((job) => job.controlEnabled).length;
    const paused = data.jobs.filter((job) => !job.controlEnabled).length;
    const blocked = data.jobs.filter((job) => job.error).length;
    return { enabled, paused, blocked, total: data.jobs.length };
  }, [data.jobs]);

  async function refresh() {
    setErr(null);
    setBusy("refresh");
    try {
      const res = await fetch("/api/admin/schedules", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "스케줄 조회 실패");
      setData(json);
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function act(job: ManagedScheduleJob, action: SchedulerAction) {
    setErr(null);
    setBusy(`${job.id}:${action}`);
    try {
      const res = await fetch(`/api/admin/schedules/${encodeURIComponent(job.id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "스케줄 변경 실패");
      if (json.cloudError) {
        setErr(`웹 스위치는 반영됐지만 Cloud Scheduler 상태 변경은 실패했습니다: ${json.cloudError}`);
      }
      setData(json.dashboard);
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="panel schedule-overview">
        <div className="schedule-head">
          <div>
            <h2>
              운영 스케줄 <span className="sub">Cloud Scheduler · Cloud Run Job</span>
            </h2>
            <div className="muted mono" style={{ fontSize: 12 }}>
              {data.project} / {data.location} · 확인 {fmt(data.checkedAt)}
            </div>
          </div>
          <button className="btn ghost" type="button" onClick={refresh} disabled={busy !== null}>
            새로고침
          </button>
        </div>
        <div className="stat-row">
          <Stat n={totals.total} l="관리 대상" />
          <Stat n={totals.enabled} l="ON" />
          <Stat n={totals.paused} l="OFF" />
          <Stat n={totals.blocked} l="확인 필요" />
        </div>
        {data.accessError ? <div className="schedule-alert down">{data.accessError}</div> : null}
        {err ? <div className="schedule-alert down">{err}</div> : null}
      </div>

      <div className="schedule-grid">
        {data.jobs.map((job) => (
          <section className={`schedule-card state-${job.state.toLowerCase()}`} key={job.id}>
            <div className="schedule-card-top">
              <div>
                <div className="schedule-title-row">
                  <span className="schedule-title">{job.title}</span>
                  <span className="pill">{job.group}</span>
                </div>
                <div className="muted">{job.purpose}</div>
              </div>
              <span className={`schedule-state ${stateTone(job)}`}>{stateLabel(job)}</span>
            </div>

            <div className="schedule-controls">
              <button
                className={`schedule-switch ${job.controlEnabled ? "on" : ""}`}
                type="button"
                aria-pressed={job.controlEnabled}
                disabled={busy !== null}
                onClick={() => act(job, job.controlEnabled ? "pause" : "resume")}
              >
                <span className="knob" />
                <span>{job.controlEnabled ? "ON" : "OFF"}</span>
              </button>
              <button
                className="btn ghost"
                type="button"
                disabled={busy !== null || Boolean(job.error) || !job.controlEnabled}
                onClick={() => act(job, "run")}
              >
                지금 실행
              </button>
            </div>

            <div className="schedule-meta">
              <Meta label="주기" value={job.cadence} />
              <Meta label="웹 스위치" value={job.controlEnabled ? "ON" : `OFF · ${fmt(job.controlUpdatedAt)}`} />
              <Meta label="Cron" value={job.schedule} mono />
              <Meta label="Scheduler" value={job.state} mono />
              <Meta label="대상" value={job.targetJob} mono />
              <Meta label="명령" value={job.command} mono />
              <Meta label="예산" value={job.runBudget} />
              <Meta label="다음" value={fmt(job.nextRunAt)} mono />
              <Meta label="최근 시도" value={fmt(job.lastAttemptAt)} mono />
            </div>

            {job.error ? <div className="schedule-job-error">{job.error}</div> : null}
          </section>
        ))}
      </div>
    </>
  );
}

function Stat({ n, l }: { n: number; l: string }) {
  return (
    <div className="s">
      <div className="n mono">{n.toLocaleString("ko-KR")}</div>
      <div className="l">{l}</div>
    </div>
  );
}

function Meta({ label, value, mono = false }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div>
      <div className="k">{label}</div>
      <div className={`v ${mono ? "mono" : ""}`}>{value || "-"}</div>
    </div>
  );
}

function stateLabel(job: ManagedScheduleJob): string {
  if (!job.controlEnabled) return "OFF";
  if (job.error) return "확인 필요";
  if (job.state === "ENABLED") return "ON";
  if (job.state === "PAUSED") return "OFF";
  if (job.state === "DISABLED") return "비활성";
  if (job.state === "UPDATE_FAILED") return "업데이트 실패";
  return job.state || "UNKNOWN";
}

function stateTone(job: ManagedScheduleJob): string {
  if (!job.controlEnabled) return "paused";
  if (job.error || job.state === "UPDATE_FAILED") return "bad";
  if (job.state === "ENABLED") return "good";
  if (job.state === "PAUSED") return "paused";
  return "muted-state";
}

function fmt(value: string | null | undefined): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
