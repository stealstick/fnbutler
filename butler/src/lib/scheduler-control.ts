import { all, ensureMigrated, getDb, nowIso, one, query, type Queryable } from "./db";

export interface SchedulerControl {
  job_id: string;
  enabled: number;
  updated_at: string;
  updated_by: string | null;
}

export async function getSchedulerControlMap(db: Queryable = getDb()): Promise<Map<string, SchedulerControl>> {
  await ensureMigrated();
  const rows = await all<SchedulerControl>("SELECT job_id, enabled, updated_at, updated_by FROM scheduler_controls", [], db);
  return new Map(rows.map((row) => [row.job_id, row]));
}

export async function setSchedulerControl(
  jobId: string,
  enabled: boolean,
  updatedBy: string | null,
  db: Queryable = getDb(),
): Promise<SchedulerControl> {
  await ensureMigrated();
  const row = await one<SchedulerControl>(
    `INSERT INTO scheduler_controls (job_id, enabled, updated_at, updated_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT(job_id)
     DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by
     RETURNING job_id, enabled, updated_at, updated_by`,
    [jobId, enabled ? 1 : 0, nowIso(), updatedBy],
    db,
  );
  if (!row) throw new Error("스케줄 스위치 저장 실패");
  return row;
}

export async function isSchedulerJobEnabled(jobId: string, db: Queryable = getDb()): Promise<boolean> {
  const row = await one<Pick<SchedulerControl, "enabled">>(
    "SELECT enabled FROM scheduler_controls WHERE job_id = $1",
    [jobId],
    db,
  );
  return row ? Number(row.enabled) === 1 : true;
}

export async function skipIfSchedulerDisabled(jobId: string, label: string, db: Queryable = getDb()): Promise<boolean> {
  const enabled = await isSchedulerJobEnabled(jobId, db);
  if (enabled) return false;
  process.stdout.write(`[${nowIso()}] ${label} 스케줄 OFF — 실행을 건너뜀\n`);
  return true;
}
