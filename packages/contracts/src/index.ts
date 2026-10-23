export const priorities = ['emergency', 'user', 'proactive', 'background'] as const;
export type Priority = (typeof priorities)[number];

export const goalKinds = [
  'follow',
  'stop',
  'approach',
  'gather',
  'give',
  'defend',
  'retreat',
  'report',
] as const;
export type GoalKind = (typeof goalKinds)[number];

export type GoalSource = 'voice' | 'world' | 'agent';
export type GoalStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface Goal {
  id: string;
  kind: GoalKind;
  priority: Priority;
  args: Record<string, JsonValue>;
  source: GoalSource;
}

export interface PlayerObservation {
  position?: [number, number, number];
  health?: number;
}

export interface AgentObservation {
  position?: [number, number, number];
  health?: number;
}

export interface Observation {
  timestamp: number;
  game: string;
  player?: PlayerObservation;
  agent?: AgentObservation;
  threats?: unknown[];
  inventory?: Record<string, number>;
}

export interface GoalResult {
  status: GoalStatus;
  detail?: string;
}

export interface GameAdapter {
  connect(): Promise<void>;
  observe(): Promise<Observation>;
  capabilities(): readonly GoalKind[];
  execute(goal: Goal, signal: AbortSignal): Promise<GoalResult>;
  disconnect(): Promise<void>;
}

export interface EventBase {
  eventId: string;
  timestamp: number;
}

export type CompanionEvent =
  | (EventBase & { type: 'audio.input'; durationMs?: number })
  | (EventBase & { type: 'transcript.received'; text: string })
  | (EventBase & { type: 'intent.recognized'; intent: GoalKind })
  | (EventBase & { type: 'goal.proposed'; goal: Goal })
  | (EventBase & { type: 'goal.accepted'; goalId: string })
  | (EventBase & { type: 'action.started'; goalId: string })
  | (EventBase & { type: 'action.completed'; goalId: string; detail?: string; latencyMs?: number })
  | (EventBase & { type: 'action.cancelled'; goalId: string; reason?: string; latencyMs?: number })
  | (EventBase & { type: 'action.failed'; goalId: string; reason: string; latencyMs?: number })
  | (EventBase & { type: 'speech.response'; goalId?: string; text: string });

const unsafeArgumentKeys = new Set(['__proto__', 'prototype', 'constructor', 'command', 'shell', 'script', 'code']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertJsonValue(
  value: unknown,
  path: string,
  ancestors: Set<object> = new Set(),
  depth = 0,
): asserts value is JsonValue {
  if (depth > 32) throw new TypeError(`${path} exceeds the maximum nesting depth`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError(`${path} contains a circular reference`);
    ancestors.add(value);
    value.forEach((entry, index) => assertJsonValue(entry, `${path}[${index}]`, ancestors, depth + 1));
    ancestors.delete(value);
    return;
  }
  if (!isRecord(value)) throw new TypeError(`${path} must contain only JSON data`);
  if (ancestors.has(value)) throw new TypeError(`${path} contains a circular reference`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${path} must contain only plain JSON objects`);
  }

  ancestors.add(value);
  for (const [key, entry] of Object.entries(value)) {
    if (unsafeArgumentKeys.has(key.toLowerCase())) throw new TypeError(`${path}.${key} is not an allowed argument`);
    assertJsonValue(entry, `${path}.${key}`, ancestors, depth + 1);
  }
  ancestors.delete(value);
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === 'string' && options.includes(value as T);
}

/** Validate untrusted model output before it becomes an executable game goal. */
export function parseGoalProposal(value: unknown): Goal {
  if (!isRecord(value)) throw new TypeError('Goal proposal must be an object');
  const allowedKeys = new Set(['id', 'kind', 'priority', 'args', 'source']);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new TypeError(`Unexpected goal field: ${key}`);
  }
  if (typeof value.id !== 'string' || value.id.trim() === '') throw new TypeError('Goal id must be a non-empty string');
  if (!isOneOf(value.kind, goalKinds)) throw new TypeError('Goal kind is not supported');
  if (!isOneOf(value.priority, priorities)) throw new TypeError('Goal priority is not supported');
  if (!isOneOf(value.source, ['voice', 'world', 'agent'])) throw new TypeError('Goal source is not supported');
  if (!isRecord(value.args)) throw new TypeError('Goal args must be an object');
  assertJsonValue(value.args, 'args');

  return {
    id: value.id,
    kind: value.kind,
    priority: value.priority,
    args: value.args as Record<string, JsonValue>,
    source: value.source,
  };
}

/** Reject a valid goal when the selected adapter cannot implement it. */
export function validateGoalCapability(goal: Goal, capabilities: readonly GoalKind[]): true {
  if (!capabilities.includes(goal.kind)) {
    throw new Error(`Adapter does not support goal kind: ${goal.kind}`);
  }
  return true;
}
