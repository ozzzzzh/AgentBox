import type { StopReason } from '../types.js';

export type CheckDefinition =
  | { type: 'text-contains-all'; values: string[]; ignoreCase?: boolean }
  | { type: 'file-contains'; path: string; value: string; ignoreCase?: boolean }
  | {
      type: 'file-not-contains';
      path: string;
      value: string;
      ignoreCase?: boolean;
    }
  | { type: 'file-exists'; path: string }
  | { type: 'python-compile'; path: string }
  | {
      type: 'command';
      command: string;
      args?: string[];
      cwd?: string;
      timeoutMs?: number;
    }
  | { type: 'approval-and-file-exists'; path: string }
  | { type: 'all'; checks: CheckDefinition[] };

export interface TaskDefinition {
  id: string;
  name: string;
  prompt: string;
  files?: Record<string, string>;
  check: CheckDefinition;
  approval?: 'allow' | 'deny';
  limits?: {
    maxSteps?: number;
    turnTimeoutMs?: number;
  };
}

export interface TaskCheckResult {
  ok: boolean;
  type: string;
  detail: string;
}

export interface TaskResult {
  id: string;
  name: string;
  ok: boolean;
  turnOk: boolean;
  reason: StopReason | 'error' | 'not_started';
  steps: number;
  toolErrors: number;
  approvals: number;
  durationMs: number;
  firstTokenMs: number | null;
  check: TaskCheckResult;
  workDir: string;
  jsonl: string;
  error?: string;
}

export interface EvalMetrics {
  total: number;
  passed: number;
  successRate: number;
  avgSteps: number;
  avgDurationMs: number;
  avgFirstTokenMs: number | null;
  totalApprovals: number;
  totalToolErrors: number;
  taskErrors: number;
}

export interface EvalReport {
  taskFile: string;
  runtime: string;
  model?: string;
  startedAt: string;
  finishedAt: string;
  metrics: EvalMetrics;
  tasks: TaskResult[];
}
