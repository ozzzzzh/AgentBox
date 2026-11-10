import type {
  ApprovalDecision,
  StopReason,
} from '@agentbox/runtime';
import type { SkillCatalogItem } from './skills/catalog';
import type { ClientGroupInfo } from './skills/client';
import type { SkillUsage } from './skills/model';

export interface ContextInfo {
  file?: string;
  selection?: {
    startLine: number;
    endLine: number;
    preview: string;
  };
}

export interface SettingsValues {
  runtime: string;
  taskProfile: string;
  provider: string;
  model: string;
  baseUrl: string;
  approvalPolicy: string;
  reasoningEffort: string;
  /** Whether a key exists for the current provider. Never the key itself. */
  apiKeyConfigured: boolean;
  codexCommand: string;
  extraInstructions: string;
  skillServerUrl: string;
  skillServerTokenConfigured: boolean;
  skillsAutoSync: boolean;
  skillsRequiredMissing: string;
  skillsLocalDir: string;
  /** Write-only values; empty means keep the stored secret. */
  apiKey?: string;
  skillServerToken?: string;
  clearApiKey?: boolean;
  clearSkillServerToken?: boolean;
}

export interface SessionSummary {
  id: string;
  title: string;
  busy: boolean;
}

/**
 * Events that belong to one conversation. They are recorded by the host and
 * replayed when a webview surface (sidebar or editor panel) attaches or when
 * the user switches sessions.
 */
export type SessionEvent =
  | { type: 'user.message'; text: string }
  | { type: 'busy'; busy: boolean }
  | { type: 'turn.start'; turnId: string }
  | { type: 'assistant.delta'; text: string }
  | { type: 'reasoning.delta'; text: string; kind?: 'summary' | 'raw' }
  | { type: 'reasoning.end'; text: string; kind?: 'summary' | 'raw' }
  | {
      type: 'tool.start';
      callId: string;
      name: string;
      args: unknown;
    }
  | {
      type: 'tool.end';
      callId: string;
      name: string;
      ok: boolean;
      result: string;
    }
  | { type: 'file.changed'; path: string }
  | { type: 'token.usage'; turn: number; session: number }
  | {
      type: 'approval.request';
      id: string;
      turnId: string;
      callId: string;
      name: string;
      args: unknown;
      warning?: string;
    }
  | {
      type: 'approval.resolved';
      id: string;
      decision: ApprovalDecision;
    }
  | { type: 'approval.cancelled'; id: string }
  | { type: 'turn.end'; reason: StopReason }
  | { type: 'error'; code?: string; message: string }
  | { type: 'log'; text: string };

export type HostToWebview =
  | {
      type: 'state';
      busy: boolean;
      runtime: string;
      model: string;
      provider?: string;
      workspaceRoot?: string;
    }
  | { type: 'sessions'; sessions: SessionSummary[]; activeId: string }
  | { type: 'session.load'; id: string; events: SessionEvent[] }
  | { type: 'skills'; skills: SkillUsage[] }
  | { type: 'skills.catalog'; items: SkillCatalogItem[] }
  | { type: 'skills.groups'; groups: ClientGroupInfo[] }
  | { type: 'context'; context: ContextInfo }
  | { type: 'settings'; values: SettingsValues }
  | { type: 'settings.open' }
  | { type: 'settings.saved' }
  | { type: 'settings.error'; message: string }
  | { type: 'clear' }
  | SessionEvent;

export type WebviewToHost =
  | { type: 'ready' }
  | {
      type: 'prompt';
      text: string;
      includeFile: boolean;
      includeSelection: boolean;
    }
  | { type: 'cancel' }
  | {
      type: 'approval.response';
      id: string;
      decision: ApprovalDecision;
    }
  | { type: 'openFile'; path: string }
  | { type: 'openToolDetails'; callId: string }
  | { type: 'openExternal'; url: string }
  | { type: 'openEditor' }
  | { type: 'showLog' }
  | { type: 'settings.request' }
  | { type: 'settings.save'; values: SettingsValues }
  | { type: 'skills.open' }
  | { type: 'skills.toggle'; id: string; enabled: boolean }
  | { type: 'skills.create' }
  | { type: 'skills.openFolder' }
  | { type: 'skills.upload' }
  | { type: 'skills.sync' }
  | { type: 'skills.requestGroups' }
  | { type: 'skills.joinGroups'; ids: string[] }
  | { type: 'session.new' }
  | { type: 'session.select'; id: string }
  | { type: 'session.close'; id: string; confirm: boolean };
