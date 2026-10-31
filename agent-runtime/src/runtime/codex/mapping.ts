import { RuntimeError } from '../../errors.js';
import { toWorkspaceRelative } from '../../security/paths.js';
import type {
  ApprovalDecision,
  StopReason,
  TokenUsageBreakdown,
  TokenUsageSnapshot,
} from '../../types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function tokenBreakdown(value: unknown): TokenUsageBreakdown | null {
  if (!isRecord(value)) return null;
  return {
    inputTokens: numberValue(value.inputTokens),
    cachedInputTokens: numberValue(value.cachedInputTokens),
    outputTokens: numberValue(value.outputTokens),
    reasoningOutputTokens: numberValue(value.reasoningOutputTokens),
    totalTokens: numberValue(value.totalTokens),
  };
}

export function getTokenUsage(params: unknown): TokenUsageSnapshot | null {
  if (!isRecord(params) || !isRecord(params.tokenUsage)) return null;
  const raw = params.tokenUsage;
  const last = tokenBreakdown(raw.last);
  const total = tokenBreakdown(raw.total);
  if (last === null || total === null) return null;
  const contextWindow = raw.modelContextWindow;
  return {
    last,
    total,
    modelContextWindow:
      typeof contextWindow === 'number' && Number.isFinite(contextWindow)
        ? contextWindow
        : null,
  };
}

function jsonResult(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? '');
  } catch {
    return String(value);
  }
}

function relativePath(workspaceRoot: string, candidate: unknown): string | undefined {
  if (typeof candidate !== 'string' || candidate === '') return undefined;
  try {
    return toWorkspaceRelative(workspaceRoot, candidate);
  } catch {
    return undefined;
  }
}

export interface ToolStartPayload {
  callId: string;
  name: string;
  args: unknown;
}

export interface ToolEndPayload {
  callId: string;
  name: string;
  ok: boolean;
  result: string;
}

export interface ItemMapping {
  start?: ToolStartPayload;
  end?: ToolEndPayload;
  files?: string[];
}

function commandExecution(
  item: Record<string, unknown>,
  phase: 'started' | 'completed'
): ItemMapping | null {
  const callId = stringValue(item.id);
  if (callId === undefined) return null;
  if (phase === 'started') {
    return {
      start: {
        callId,
        name: 'commandExecution',
        args: {
          command: item.command,
          cwd: item.cwd,
          source: item.source,
        },
      },
    };
  }
  const status = stringValue(item.status);
  return {
    end: {
      callId,
      name: 'commandExecution',
      ok: status === 'completed',
      result:
        stringValue(item.aggregatedOutput) ??
        (item.exitCode !== undefined
          ? `exit ${String(item.exitCode)}`
          : status ?? 'unknown'),
    },
  };
}

function fileChange(
  item: Record<string, unknown>,
  workspaceRoot: string,
  phase: 'started' | 'completed'
): ItemMapping | null {
  const callId = stringValue(item.id);
  if (callId === undefined) return null;
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const files = changes
    .map((change) => relativePath(workspaceRoot, isRecord(change) ? change.path : undefined))
    .filter((value): value is string => value !== undefined);

  if (phase === 'started') {
    return {
      start: { callId, name: 'fileChange', args: { changes } },
      files,
    };
  }

  const status = stringValue(item.status);
  return {
    end: {
      callId,
      name: 'fileChange',
      ok: status === 'completed',
      result: status ?? 'unknown',
    },
    files,
  };
}

function mcpToolCall(
  item: Record<string, unknown>,
  phase: 'started' | 'completed'
): ItemMapping | null {
  const callId = stringValue(item.id);
  if (callId === undefined) return null;
  const server = stringValue(item.server) ?? 'mcp';
  const tool = stringValue(item.tool) ?? 'tool';
  const name = `mcp:${server}/${tool}`;
  if (phase === 'started') {
    return {
      start: { callId, name, args: item.arguments },
    };
  }
  const status = stringValue(item.status);
  return {
    end: {
      callId,
      name,
      ok: status === 'completed',
      result: jsonResult(item.result ?? item.error ?? status),
    },
  };
}

function dynamicToolCall(
  item: Record<string, unknown>,
  phase: 'started' | 'completed'
): ItemMapping | null {
  const callId = stringValue(item.id);
  if (callId === undefined) return null;
  const tool = stringValue(item.tool) ?? 'tool';
  const name = `tool:${tool}`;
  if (phase === 'started') {
    return {
      start: { callId, name, args: item.arguments },
    };
  }
  return {
    end: {
      callId,
      name,
      ok: item.success === true,
      result: jsonResult(item.contentItems ?? item.success),
    },
  };
}

/**
 * Map Codex ThreadItem lifecycle notifications to our normalized tool events.
 * Text deltas are handled separately (`item/agentMessage/delta`).
 */
export function mapItem(
  item: unknown,
  workspaceRoot: string,
  phase: 'started' | 'completed'
): ItemMapping | null {
  if (!isRecord(item)) return null;
  switch (item.type) {
    case 'commandExecution':
      return commandExecution(item, phase);
    case 'fileChange':
      return fileChange(item, workspaceRoot, phase);
    case 'mcpToolCall':
      return mcpToolCall(item, phase);
    case 'dynamicToolCall':
      return dynamicToolCall(item, phase);
    default:
      return null;
  }
}

export function getAgentMessageDelta(params: unknown): string | undefined {
  return isRecord(params) ? stringValue(params.delta) : undefined;
}

export function getTurnId(params: unknown): string | undefined {
  return isRecord(params) ? stringValue(params.turnId) : undefined;
}

export function getThreadId(params: unknown): string | undefined {
  return isRecord(params) ? stringValue(params.threadId) : undefined;
}

export function mapTurnStopReason(
  status: unknown,
  aborted: boolean
): StopReason {
  if (aborted) return 'cancelled';
  switch (status) {
    case 'completed':
      return 'end_turn';
    case 'interrupted':
      return 'cancelled';
    case 'failed':
    default:
      return 'error';
  }
}

export function getTurnError(params: unknown): {
  message: string;
  code: string;
} | null {
  if (!isRecord(params) || !isRecord(params.turn)) return null;
  const error = params.turn.error;
  if (!isRecord(error)) return null;
  const message = stringValue(error.message) ?? 'Codex turn failed';
  const codexErrorInfo = isRecord(error.codexErrorInfo)
    ? error.codexErrorInfo
    : null;
  const code =
    codexErrorInfo !== null && typeof codexErrorInfo.type === 'string'
      ? codexErrorInfo.type
      : 'RUNTIME_ERROR';
  return { message, code };
}

export interface ApprovalMapping {
  name: string;
  callId: string;
  args: unknown;
}

export function isApprovalMethod(method: string): boolean {
  return (
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval' ||
    method === 'item/permissions/requestApproval' ||
    method === 'execCommandApproval' ||
    method === 'applyPatchApproval'
  );
}

export function mapApprovalRequest(
  method: string,
  params: unknown
): ApprovalMapping | null {
  if (!isRecord(params)) return null;
  const itemId = stringValue(params.itemId);
  const approvalId = stringValue(params.approvalId);
  const callId = itemId ?? approvalId ?? stringValue(params.callId);
  if (callId === undefined) return null;

  switch (method) {
    case 'item/commandExecution/requestApproval':
      return {
        name: 'commandExecution',
        callId,
        args: {
          kind: params.kind,
          command: params.command,
          cwd: params.cwd,
          reason: params.reason,
          availableDecisions: params.availableDecisions,
        },
      };
    case 'item/fileChange/requestApproval':
      return {
        name: 'fileChange',
        callId,
        args: {
          reason: params.reason,
          grantRoot: params.grantRoot,
        },
      };
    case 'item/permissions/requestApproval':
      return {
        name: 'permissions',
        callId,
        args: {
          reason: params.reason,
          permissions: params.permissions,
          cwd: params.cwd,
        },
      };
    case 'execCommandApproval':
      return {
        name: 'execCommand',
        callId,
        args: {
          command: params.command,
          cwd: params.cwd,
          reason: params.reason,
        },
      };
    case 'applyPatchApproval':
      return {
        name: 'applyPatch',
        callId,
        args: {
          fileChanges: params.fileChanges,
          reason: params.reason,
          grantRoot: params.grantRoot,
        },
      };
    default:
      return null;
  }
}

export function mapApprovalResult(
  method: string,
  decision: ApprovalDecision,
  params: unknown
): unknown {
  if (method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval') {
    return { decision: decision === 'allow' ? 'accept' : 'decline' };
  }
  if (method === 'item/permissions/requestApproval') {
    if (decision === 'deny') {
      throw new RuntimeError('POLICY_DENIED', 'permission request denied');
    }
    const permissions = isRecord(params) ? params.permissions : undefined;
    return { permissions: permissions ?? {}, scope: 'turn' };
  }
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    return {
      decision:
        decision === 'allow'
          ? 'approved'
          : { denied: { rejection: 'denied by user' } },
    };
  }
  return { decision: 'decline' };
}
