import { utf8ByteLength } from "../encoding.js";
import type { ExecutionScope, ResourceLease } from "../execution-scope.js";
import type { ExecResult, ShellJobSnapshot } from "../types.js";
import { ExecutionAbortedError, ExecutionLimitError } from "./errors.js";
import type { InterpreterState } from "./types.js";

interface Job {
  pid: number;
  owner: number;
  args: string;
  stat: "running" | "done";
  result?: ExecResult;
  task: Promise<void>;
  foreground: boolean;
  lease: ResourceLease;
}

/** One invocation's bounded task and PID authority; never exposed to commands. */
export class ShellJobs {
  private nextPid = 2;
  private jobs = new Map<number, Job>();
  private completed = new Map<number, { owner: number; status: number }>();
  private fatal: unknown;
  private controller = new AbortController();
  readonly signal: AbortSignal = this.controller.signal;
  used = false;

  constructor(
    private scope: ExecutionScope,
    private maximum: number,
  ) {}

  allocate(minimum = 2): number {
    this.nextPid = Math.max(this.nextPid, minimum);
    return this.nextPid++;
  }

  registerOwner(state: InterpreterState, args: string, ppid: number): void {
    state.shellArgs = args;
    state.shellPpid = ppid;
  }

  canLaunch(count: number): boolean {
    return count <= this.maximum - this.jobs.size;
  }

  launch(
    state: InterpreterState,
    args: string,
    retainedBytes: number,
    prepare: (pid: number) => () => Promise<ExecResult>,
    foreground = false,
  ): number {
    this.scope.throwIfAborted("background launch");
    if (this.jobs.size >= this.maximum) {
      const error = new ExecutionLimitError(
        `background job limit exceeded (${this.maximum})`,
        "commands",
      );
      this.scope.poisonAfterAbort(error);
      throw error;
    }
    const lease = this.scope.reserveBytes(
      "background jobs",
      retainedBytes + utf8ByteLength(args),
      "background launch",
    );
    const pid = this.allocate(state.nextVirtualPid);
    this.used = true;
    const job: Job = {
      pid,
      owner: state.bashPid,
      args,
      stat: "running",
      lease,
      task: Promise.resolve(),
      foreground,
    };
    this.jobs.set(pid, job);
    // Defer effects until the record and the parent's $! have been admitted.
    let run: () => Promise<ExecResult>;
    try {
      run = prepare(pid);
    } catch (error) {
      this.jobs.delete(pid);
      lease.release();
      throw error;
    }
    job.task = Promise.resolve()
      .then(run)
      .then(
        (result) => {
          job.result = result;
        },
        (error: unknown) => {
          this.fatal ??= error;
          this.cancel(error);
          throw error;
        },
      )
      .finally(() => {
        job.stat = "done";
      });
    // A background rejection is observed again by wait/join, never unhandled.
    void job.task.catch(() => {});
    return pid;
  }

  cancel(reason?: unknown): void {
    this.controller.abort(reason);
  }

  async joinAll(): Promise<void> {
    for (;;) {
      const pending = [...this.jobs.values()].filter(
        (job) => job.stat === "running",
      );
      if (!pending.length) {
        if (this.fatal)
          throw this.signal.aborted ? this.signal.reason : this.fatal;
        return;
      }
      const settled = await Promise.allSettled(pending.map((job) => job.task));
      const rejected = settled.find((entry) => entry.status === "rejected");
      if (rejected?.status === "rejected") {
        this.cancel(rejected.reason);
        await Promise.allSettled(
          [...this.jobs.values()].map((job) => job.task),
        );
        throw this.signal.reason;
      }
    }
  }

  private consume(job: Job): number {
    const status = job.result?.exitCode ?? 126;
    this.jobs.delete(job.pid);
    job.lease.release();
    if (!job.foreground)
      this.completed.set(job.pid, { owner: job.owner, status });
    if (this.completed.size > 32)
      this.completed.delete(this.completed.keys().next().value as number);
    return status;
  }

  async wait(owner: number, pids?: number[]): Promise<number> {
    const selected =
      pids ??
      [...this.jobs.values()]
        .filter((job) => job.owner === owner && !job.foreground)
        .map((job) => job.pid);
    let status = 0;
    for (const pid of selected) {
      const job = this.jobs.get(pid);
      if (!job || job.owner !== owner) {
        const completed = this.completed.get(pid);
        status = completed?.owner === owner ? completed.status : 127;
        continue;
      }
      await job.task;
      status = this.consume(job);
    }
    return pids ? status : 0;
  }

  snapshot(state: InterpreterState): ShellJobSnapshot {
    const shell = Object.freeze({
      pid: state.bashPid,
      ppid: state.shellPpid ?? state.virtualPpid,
      stat: "running" as const,
      args: state.shellArgs ?? "shell",
    });
    const jobs = Object.freeze(
      [...this.jobs.values()]
        .filter((job) => job.owner === state.bashPid)
        .map((job) =>
          Object.freeze({
            pid: job.pid,
            ppid: job.owner,
            stat: job.stat,
            args: job.args,
          }),
        ),
    );
    return Object.freeze({ shell, jobs });
  }

  close(): void {
    this.cancel(new ExecutionAbortedError());
    for (const job of this.jobs.values()) job.lease.release();
    this.jobs.clear();
    this.completed.clear();
  }
}

export function allocateShellPid(ctx: {
  state: InterpreterState;
  executionScope: ExecutionScope;
}): number {
  ctx.state.shellPpid = ctx.state.bashPid;
  const pid = ctx.executionScope.shellJobs.allocate(ctx.state.nextVirtualPid);
  ctx.state.nextVirtualPid = pid + 1;
  return pid;
}
