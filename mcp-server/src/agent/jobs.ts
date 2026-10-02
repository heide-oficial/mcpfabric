/**
 * Background jobs: multi-step macro actions (travel, explore, collect, craft) that run inside the
 * runtime instead of the model's tool loop. The model starts one, keeps thinking or waits on
 * `job_status`, and gets a summary at the end — the tick-level feedback loop stays out of the LLM.
 *
 * One job runs at a time because there is one body; starting another requires cancelling first.
 */

export type JobState = "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: number;
  kind: string;
  /** One-line description of what was asked. */
  summary: string;
  state: JobState;
  startedAt: number;
  endedAt?: number;
  progress: string;
  log: string[];
  result?: string;
}

/** Thrown inside a job to stop it with a readable reason. */
export class JobFailure extends Error {}

export class JobCancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

export interface JobContext {
  readonly signal: AbortSignal;
  log(message: string): void;
  progress(message: string): void;
  /** Abortable sleep; throws {@link JobCancelled} when the job is cancelled. */
  sleep(ms: number): Promise<void>;
  /** Throws {@link JobCancelled} if the job was cancelled. */
  checkpoint(): void;
}

const LOG_LINES = 40;
const HISTORY = 10;

/** No job runs longer than this, so nothing keeps driving the player for hours. */
export const JOB_TIME_LIMIT_MS = 60 * 60 * 1000;

export class JobManager {
  private nextId = 1;
  private current?: { job: Job; abort: AbortController; done: Promise<void>; owner?: object };
  private readonly history: Job[] = [];

  constructor(
    /** Called once when a job ends (not when cancelled): record it in episodic memory, etc. */
    private readonly onFinish: (job: Job) => void = () => {},
    /** Called when a job stops for any reason, to release the body (stop navigation, ...). */
    private readonly onStop: () => Promise<void> = async () => {},
    /** Wall-clock limit of a job: past it, the job fails with that reason. */
    private readonly timeLimitMs: number = JOB_TIME_LIMIT_MS,
  ) {}

  running(): Job | undefined {
    return this.current?.job;
  }

  /** Start a job. `owner` (an MCP session) can cancel it with {@link cancelOwnedBy} when it goes away. */
  start(kind: string, summary: string, run: (ctx: JobContext) => Promise<string>, owner?: object): Job {
    if (this.current) {
      throw new Error(`Job #${this.current.job.id} (${this.current.job.kind}) is still running; job_cancel it first.`);
    }
    const job: Job = { id: this.nextId++, kind, summary, state: "running", startedAt: Date.now(), progress: "starting", log: [] };
    const abort = new AbortController();
    const ctx: JobContext = {
      signal: abort.signal,
      log: (message) => {
        job.log.push(message);
        if (job.log.length > LOG_LINES) job.log.splice(0, job.log.length - LOG_LINES);
      },
      progress: (message) => {
        job.progress = message;
      },
      sleep: (ms) =>
        new Promise<void>((resolve, reject) => {
          if (abort.signal.aborted) return reject(new JobCancelled());
          const timer = setTimeout(() => {
            abort.signal.removeEventListener("abort", onAbort);
            resolve();
          }, ms);
          const onAbort = () => {
            clearTimeout(timer);
            reject(new JobCancelled());
          };
          abort.signal.addEventListener("abort", onAbort, { once: true });
        }),
      checkpoint: () => {
        if (abort.signal.aborted) throw new JobCancelled();
      },
    };

    let timedOut = false;
    const limitTimer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, this.timeLimitMs);
    limitTimer.unref();

    const done = (async () => {
      try {
        job.result = await run(ctx);
        job.state = abort.signal.aborted ? "cancelled" : "done";
      } catch (err) {
        if (err instanceof JobCancelled || abort.signal.aborted) {
          job.state = "cancelled";
          job.result ??= "cancelled";
        } else {
          job.state = "failed";
          job.result = err instanceof Error ? err.message : String(err);
        }
      } finally {
        clearTimeout(limitTimer);
        if (timedOut) {
          const ms = this.timeLimitMs;
          job.state = "failed";
          job.result = `stopped at the time limit of ${ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${ms} ms`}`;
        }
        job.endedAt = Date.now();
        this.current = undefined;
        this.history.unshift(job);
        if (this.history.length > HISTORY) this.history.pop();
        try {
          await this.onStop();
        } catch {
          // releasing the body is best effort
        }
        if (job.state !== "cancelled") {
          try {
            this.onFinish(job);
          } catch {
            // recording the outcome must never break the job manager
          }
        }
      }
    })();
    this.current = { job, abort, done, ...(owner ? { owner } : {}) };
    return job;
  }

  get(id?: number): Job | undefined {
    if (id === undefined) return this.current?.job ?? this.history[0];
    if (this.current?.job.id === id) return this.current.job;
    return this.history.find((j) => j.id === id);
  }

  /** Cancel the running job (optionally only if it has this id); resolves once it has stopped. */
  async cancel(id?: number): Promise<Job | undefined> {
    const cur = this.current;
    if (!cur || (id !== undefined && cur.job.id !== id)) return undefined;
    cur.abort.abort();
    await cur.done;
    return cur.job;
  }

  /** Cancel the running job if `owner` started it, e.g. an MCP session that closed. */
  async cancelOwnedBy(owner: object): Promise<Job | undefined> {
    const cur = this.current;
    if (!cur || cur.owner !== owner) return undefined;
    return this.cancel(cur.job.id);
  }

  /** Wait until the job ends or `timeoutMs` passes, whichever is first. */
  async wait(id: number | undefined, timeoutMs: number): Promise<Job | undefined> {
    const cur = this.current;
    if (cur && (id === undefined || cur.job.id === id) && timeoutMs > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([cur.done, new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))]);
      clearTimeout(timer);
    }
    return this.get(id);
  }
}

export function formatJob(job: Job, now: number = Date.now()): string {
  const secs = Math.round(((job.endedAt ?? now) - job.startedAt) / 1000);
  const lines = [`job #${job.id} ${job.kind} [${job.state}] ${secs}s — ${job.summary}`];
  if (job.state === "running") lines.push(`progress: ${job.progress}`);
  if (job.result) lines.push(`result: ${job.result}`);
  if (job.log.length > 0) lines.push("log:", ...job.log.slice(-8).map((l) => `  ${l}`));
  return lines.join("\n");
}
