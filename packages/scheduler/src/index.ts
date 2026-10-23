import type { CompanionEvent, Goal, GoalKind, GoalResult, GoalStatus } from '../../contracts/src/index.ts';

type Executor = (goal: Goal, signal: AbortSignal) => Promise<GoalResult>;
type EventSink = (event: CompanionEvent) => void;

interface SchedulerOptions {
  timeoutMs?: number;
  recovery?: (goal: Goal, reason: string) => void | Promise<void>;
}

interface ActiveAction {
  goal: Goal;
  controller: AbortController;
  token: number;
  cancellationConfirmed: boolean;
  promise: Promise<void>;
}

const priorityRank = { emergency: 0, user: 1, proactive: 2, background: 3 } as const;
const goalKinds: readonly GoalKind[] = ['follow', 'stop', 'approach', 'gather', 'give', 'defend', 'retreat', 'report'];

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function compatible(left: Goal, right: Goal): boolean {
  return left.kind === right.kind && stableJson(left.args) === stableJson(right.args);
}

/** Serial goal scheduler with priority preemption and cancellation-safe event emission. */
export class GoalScheduler {
  private queue: Goal[] = [];
  private active?: ActiveAction;
  private sequence = 0;
  private objectiveValue?: string;
  private stopped = false;
  private stopInProgress = false;
  private stopTask?: Promise<void>;
  private readonly timeoutMs: number;
  private readonly recovery?: SchedulerOptions['recovery'];
  private readonly execute: Executor;
  private readonly emit: EventSink;

  constructor(
    execute: Executor,
    emit: EventSink = () => undefined,
    options: SchedulerOptions = {},
  ) {
    this.execute = execute;
    this.emit = emit;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.recovery = options.recovery;
  }

  get objective(): string | undefined { return this.objectiveValue; }
  get currentGoal(): Goal | undefined { return this.active?.goal; }
  get queuedGoals(): readonly Goal[] { return this.queue; }

  setObjective(objective: string | undefined): void {
    this.objectiveValue = objective;
  }

  async submit(goal: Goal): Promise<void> {
    if (!goalKinds.includes(goal.kind)) throw new TypeError(`Unsupported goal kind: ${goal.kind}`);
    if (goal.kind === 'stop') {
      await this.stop(goal.id);
      return;
    }
    if (this.stopInProgress) {
      this.queue.push(goal);
      this.sortQueue();
      return;
    }
    this.stopped = false;
    if (this.active && !compatible(this.active.goal, goal)
      && priorityRank[goal.priority] <= priorityRank[this.active.goal.priority]
      && (goal.priority === 'emergency' || goal.priority === 'user')) {
      const active = this.active;
      this.queue = this.queue.filter((queued) => queued.priority !== 'user' || compatible(queued, goal));
      this.queue.unshift(goal);
      this.sortQueue();
      if (!active.controller.signal.aborted) active.controller.abort(`Replaced by ${goal.priority} goal ${goal.id}`);
    } else {
      this.queue.push(goal);
    }
    this.sortQueue();
    this.pump();
  }

  async stop(id = `stop-${Date.now()}`): Promise<void> {
    if (this.stopTask) {
      await this.stopTask;
      return;
    }
    const task = this.performStop(id);
    this.stopTask = task;
    try {
      await task;
    } finally {
      if (this.stopTask === task) this.stopTask = undefined;
    }
  }

  private async performStop(id: string): Promise<void> {
    this.stopInProgress = true;
    this.stopped = true;
    this.queue = [];
    void this.cancelActive('Stopped by user');
    this.publish({ type: 'goal.accepted', goalId: id });
    const stopGoal: Goal = { id, kind: 'stop', priority: 'emergency', source: 'voice', args: {} };
    const controller = new AbortController();
    this.publish({ type: 'action.started', goalId: id });
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.execute(stopGoal, controller.signal),
        new Promise<GoalResult>((resolve) => { stopTimer = setTimeout(() => {
          controller.abort('Stop action timed out');
          resolve({ status: 'failed', detail: `Stop timed out after ${this.timeoutMs}ms` });
        }, this.timeoutMs); }),
      ]);
      if (stopTimer) clearTimeout(stopTimer);
      if (result.status === 'completed') this.publish({ type: 'action.completed', goalId: id, detail: result.detail });
      else if (result.status === 'cancelled') this.publish({ type: 'action.cancelled', goalId: id, reason: result.detail });
      else this.publish({ type: 'action.failed', goalId: id, reason: result.detail ?? `Stop ${result.status}` });
    } catch (error) {
      if (stopTimer) clearTimeout(stopTimer);
      this.publish({ type: 'action.failed', goalId: id, reason: error instanceof Error ? error.message : String(error) });
    } finally {
      this.stopInProgress = false;
      if (this.queue.length > 0) {
        this.stopped = false;
        this.pump();
      }
    }
  }

  async cancel(goalId: string, reason = 'Cancelled by request'): Promise<boolean> {
    const queuedIndex = this.queue.findIndex((goal) => goal.id === goalId);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.publish({ type: 'action.cancelled', goalId, reason });
      return true;
    }
    if (this.active?.goal.id !== goalId) return false;
    return this.cancelActive(reason);
  }

  async drain(): Promise<void> {
    while (this.active || this.queue.length > 0 || this.stopInProgress) {
      if (this.stopInProgress && this.stopTask) {
        await this.stopTask;
        continue;
      }
      if (this.active) await this.active.promise;
      else this.pump();
    }
  }

  private async cancelActive(reason: string): Promise<boolean> {
    const action = this.active;
    if (!action) return false;
    action.controller.abort(reason);
    await action.promise;
    return action.cancellationConfirmed;
  }

  private sortQueue(): void {
    this.queue = [...this.queue].sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority]);
  }

  private pump(): void {
    if (this.active || this.stopped || this.queue.length === 0) return;
    const goal = this.queue.shift()!;
    const controller = new AbortController();
    const token = ++this.sequence;
    const action: ActiveAction = { goal, controller, token, cancellationConfirmed: false, promise: Promise.resolve() };
    this.active = action;
    this.publish({ type: 'goal.accepted', goalId: goal.id });
    this.publish({ type: 'action.started', goalId: goal.id });
    action.promise = this.run(action);
  }

  private async run(action: ActiveAction): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timed = new Promise<GoalResult>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        action.controller.abort('Action timed out');
        resolve({ status: 'failed', detail: `Timed out after ${this.timeoutMs}ms` });
      }, this.timeoutMs);
    });
    try {
      const actual = this.execute(action.goal, action.controller.signal);
      const result = await Promise.race([actual, timed]);
      if (this.active?.token !== action.token) return;
      if (timedOut) {
        this.publish({ type: 'action.failed', goalId: action.goal.id, reason: result.detail ?? 'Action timed out' });
        await this.recovery?.(action.goal, result.detail ?? 'Action timed out');
      } else if (action.controller.signal.aborted) {
        if (result.status === 'cancelled') {
          action.cancellationConfirmed = true;
          this.publish({ type: 'action.cancelled', goalId: action.goal.id, reason: action.controller.signal.reason as string });
        }
      } else if (result.status === 'completed') {
        this.publish({ type: 'action.completed', goalId: action.goal.id, detail: result.detail });
      } else if (result.status === 'cancelled') {
        action.cancellationConfirmed = true;
        this.publish({ type: 'action.cancelled', goalId: action.goal.id, reason: result.detail });
      } else {
        this.publish({ type: 'action.failed', goalId: action.goal.id, reason: result.detail ?? `Action ${result.status}` });
        if (result.status === 'failed') await this.recovery?.(action.goal, result.detail ?? 'Action failed');
      }
    } catch (error) {
      if (this.active?.token === action.token) {
        const reason = error instanceof Error ? error.message : String(error);
        this.publish({ type: 'action.failed', goalId: action.goal.id, reason });
        await this.recovery?.(action.goal, reason);
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (this.active?.token === action.token) {
        this.active = undefined;
        this.pump();
      }
    }
  }

  private publish(event: Omit<CompanionEvent, 'eventId' | 'timestamp'>): void {
    this.emit({ ...event, eventId: `scheduler-${++this.sequence}`, timestamp: Date.now() } as CompanionEvent);
  }
}
