import { getSchedulerControlMap, setSchedulerControl } from "./scheduler-control";

export const SCHEDULER_PROJECT =
  process.env.SCHEDULER_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || "protein-test-469413";
export const SCHEDULER_LOCATION = process.env.SCHEDULER_LOCATION || process.env.REGION || "asia-northeast3";
export const SCHEDULER_RUNTIME_SERVICE_ACCOUNT =
  process.env.SCHEDULER_RUNTIME_SERVICE_ACCOUNT ||
  process.env.RUN_SERVICE_ACCOUNT ||
  `fnbutler-runner@${SCHEDULER_PROJECT}.iam.gserviceaccount.com`;

const SCHEDULER_BASE = "https://cloudscheduler.googleapis.com/v1";

export interface ManagedScheduleDefinition {
  id: string;
  title: string;
  group: string;
  cadence: string;
  cron: string;
  targetJob: string;
  command: string;
  purpose: string;
  runBudget: string;
}

export const MANAGED_SCHEDULES = [
  {
    id: "fnbutler-refresh-weekdays",
    title: "일일 리프레시",
    group: "데이터",
    cadence: "매일 18:30 KST",
    cron: "30 18 * * *",
    targetJob: "fnbutler-refresh",
    command: "refresh-daily.ts --no-stockanalysis-nasdaq-estimates",
    purpose: "국내 리포트·시세·캘린더와 FMP/Seeking Alpha/Yahoo 해외 추정치를 회전 갱신",
    runBudget: "FMP 240 calls/day · Seeking Alpha 500/day",
  },
  {
    id: "fnbutler-stockanalysis-backfill-6h",
    title: "StockAnalysis 해외 백필",
    group: "백필",
    cadence: "02:10 · 08:10 · 14:10 · 20:10 KST",
    cron: "10 2,8,14,20 * * *",
    targetJob: "fnbutler-stockanalysis-backfill",
    command: "backfill-stockanalysis-nasdaq-estimates.ts",
    purpose: "미국 상장기업 실제/추정 재무, 밸류에이션, 목표가, 브로커 타깃 보강",
    runBudget: "45 symbols/run · 약 180/day · 약 7일 회전",
  },
  {
    id: "fnbutler-news-refresh-2h",
    title: "기업 뉴스 회전 수집",
    group: "뉴스",
    cadence: "07:15-23:15 2시간 간격 KST",
    cron: "15 7-23/2 * * *",
    targetJob: "fnbutler-news-refresh",
    command: "backfill-company-news.ts",
    purpose: "국내 NAVER 뉴스와 해외 StockAnalysis 기사 피드 회전 저장",
    runBudget: "80 companies/run",
  },
  {
    id: "fnbutler-calendar-weekly",
    title: "캘린더 주간 보강",
    group: "캘린더",
    cadence: "토요일 08:00 KST",
    cron: "0 8 * * 6",
    targetJob: "fnbutler-calendar-refresh",
    command: "refresh-daily.ts --calendar-only",
    purpose: "NASDAQ 실적 캘린더와 DART 잠정실적 공시 보강",
    runBudget: "주 1회",
  },
] as const satisfies readonly ManagedScheduleDefinition[];

export type ManagedScheduleId = (typeof MANAGED_SCHEDULES)[number]["id"];
export type SchedulerAction = "pause" | "resume" | "run";

export interface ManagedScheduleJob extends ManagedScheduleDefinition {
  fullName: string;
  state: string;
  controlEnabled: boolean;
  controlUpdatedAt: string | null;
  controlUpdatedBy: string | null;
  schedule: string;
  timeZone: string;
  nextRunAt: string | null;
  lastAttemptAt: string | null;
  updatedAt: string | null;
  targetUri: string | null;
  error: string | null;
}

export interface SchedulerDashboard {
  project: string;
  location: string;
  checkedAt: string;
  manageable: boolean;
  accessError: string | null;
  jobs: ManagedScheduleJob[];
}

interface CloudSchedulerJob {
  name?: string;
  schedule?: string;
  timeZone?: string;
  state?: string;
  scheduleTime?: string;
  lastAttemptTime?: string;
  userUpdateTime?: string;
  httpTarget?: {
    uri?: string;
  };
}

const jobById = new Map<string, ManagedScheduleDefinition>(MANAGED_SCHEDULES.map((job) => [job.id, job]));

export function getManagedScheduleDefinition(id: string): ManagedScheduleDefinition | undefined {
  return jobById.get(id);
}

export function isManagedScheduleId(id: string): id is ManagedScheduleId {
  return jobById.has(id);
}

export async function getSchedulerDashboard(): Promise<SchedulerDashboard> {
  const checkedAt = new Date().toISOString();
  const controls = await getSchedulerControlMap();
  const tokenResult = await getCloudAccessToken().then(
    (token) => ({ token, error: null as string | null }),
    (error: unknown) => ({ token: null as string | null, error: errorMessage(error) }),
  );

  if (!tokenResult.token) {
    return {
      project: SCHEDULER_PROJECT,
      location: SCHEDULER_LOCATION,
      checkedAt,
      manageable: false,
      accessError: tokenResult.error,
      jobs: MANAGED_SCHEDULES.map((definition) => emptyJob(definition, tokenResult.error, controls)),
    };
  }

  const jobs = await Promise.all(
    MANAGED_SCHEDULES.map((definition) =>
      readSchedulerJob(definition, tokenResult.token!, controls).catch((error: unknown) =>
        emptyJob(definition, formatSchedulerError(error), controls),
      ),
    ),
  );
  const sharedAccessError =
    jobs.length > 0 && jobs.every((job) => job.error)
      ? uniqueNonEmpty(jobs.map((job) => job.error))[0] || "Cloud Scheduler 상태를 확인할 수 없습니다."
      : null;

  return {
    project: SCHEDULER_PROJECT,
    location: SCHEDULER_LOCATION,
    checkedAt,
    manageable: jobs.some((job) => !job.error),
    accessError: sharedAccessError,
    jobs,
  };
}

export async function setSchedulerJobControl(id: ManagedScheduleId, enabled: boolean, updatedBy: string | null): Promise<void> {
  await setSchedulerControl(id, enabled, updatedBy);
}

export async function mutateCloudSchedulerJob(id: ManagedScheduleId, action: SchedulerAction): Promise<void> {
  if (!getManagedScheduleDefinition(id)) throw new Error(`관리 대상 스케줄이 아닙니다: ${id}`);

  const token = await getCloudAccessToken();
  const path = `${jobResourcePath(id)}:${action}`;
  await schedulerFetch(path, token, { method: "POST", body: "{}" });
}

type ControlMap = Map<string, { enabled: number; updated_at: string; updated_by: string | null }>;

async function readSchedulerJob(
  definition: ManagedScheduleDefinition,
  token: string,
  controls: ControlMap,
): Promise<ManagedScheduleJob> {
  const job = await schedulerFetch<CloudSchedulerJob>(jobResourcePath(definition.id), token);
  const control = controls.get(definition.id);
  return {
    ...definition,
    fullName: job.name || jobFullName(definition.id),
    state: job.state || "UNKNOWN",
    controlEnabled: control ? Number(control.enabled) === 1 : true,
    controlUpdatedAt: control?.updated_at || null,
    controlUpdatedBy: control?.updated_by || null,
    schedule: job.schedule || definition.cron,
    timeZone: job.timeZone || "Asia/Seoul",
    nextRunAt: job.scheduleTime || null,
    lastAttemptAt: job.lastAttemptTime || null,
    updatedAt: job.userUpdateTime || null,
    targetUri: job.httpTarget?.uri || null,
    error: null,
  };
}

function emptyJob(definition: ManagedScheduleDefinition, error: string | null, controls: ControlMap): ManagedScheduleJob {
  const control = controls.get(definition.id);
  return {
    ...definition,
    fullName: jobFullName(definition.id),
    state: "UNKNOWN",
    controlEnabled: control ? Number(control.enabled) === 1 : true,
    controlUpdatedAt: control?.updated_at || null,
    controlUpdatedBy: control?.updated_by || null,
    schedule: definition.cron,
    timeZone: "Asia/Seoul",
    nextRunAt: null,
    lastAttemptAt: null,
    updatedAt: null,
    targetUri: null,
    error,
  };
}

async function schedulerFetch<T = unknown>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${SCHEDULER_BASE}/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(formatSchedulerErrorText(`Cloud Scheduler ${res.status}: ${body || res.statusText}`));
  }
  return (await res.json()) as T;
}

async function getCloudAccessToken(): Promise<string> {
  const explicit = process.env.CLOUD_SCHEDULER_ACCESS_TOKEN || process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  if (explicit) return explicit;

  const res = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(2500),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Metadata token ${res.status}: ${res.statusText}`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("Metadata token response did not include access_token");
  return body.access_token;
}

function jobResourcePath(id: string): string {
  return `projects/${encodeURIComponent(SCHEDULER_PROJECT)}/locations/${encodeURIComponent(SCHEDULER_LOCATION)}/jobs/${encodeURIComponent(id)}`;
}

function jobFullName(id: string): string {
  return `projects/${SCHEDULER_PROJECT}/locations/${SCHEDULER_LOCATION}/jobs/${id}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatSchedulerError(error: unknown): string {
  return formatSchedulerErrorText(errorMessage(error));
}

function formatSchedulerErrorText(message: string): string {
  if (message.includes("PERMISSION_DENIED") || message.includes("lacks IAM permission") || message.includes("Cloud Scheduler 403")) {
    const needsRead = message.includes("cloudscheduler.jobs.get");
    const needsWrite =
      message.includes("cloudscheduler.jobs.pause") ||
      message.includes("cloudscheduler.jobs.resume") ||
      message.includes("cloudscheduler.jobs.run");
    if (needsRead) {
      return `Cloud Scheduler 조회 권한이 없습니다. ${SCHEDULER_RUNTIME_SERVICE_ACCOUNT}에 roles/cloudscheduler.admin 권한이 필요합니다. 웹 ON/OFF 스위치는 DB에 저장되어 계속 동작하지만 Scheduler 상태, 다음 실행, 최근 시도, 즉시 실행은 권한 부여 전까지 제한됩니다.`;
    }
    if (needsWrite) {
      return `Cloud Scheduler 실행/일시정지 권한이 없습니다. ${SCHEDULER_RUNTIME_SERVICE_ACCOUNT}에 roles/cloudscheduler.admin 권한이 필요합니다. 웹 ON/OFF 스위치는 DB에는 반영됩니다.`;
    }
    return `Cloud Scheduler 접근 권한이 없습니다. ${SCHEDULER_RUNTIME_SERVICE_ACCOUNT}에 roles/cloudscheduler.admin 권한을 부여해야 웹에서 Scheduler 상태를 조회하고 제어할 수 있습니다.`;
  }
  return message;
}

function uniqueNonEmpty(values: Array<string | null>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}
