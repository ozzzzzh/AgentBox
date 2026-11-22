import type {
  ApprovalDecision,
  StopReason,
} from '@agentbox/runtime';
import type {
  KnowledgeLibraryItem,
  KnowledgeProposalSummary,
  KnowledgeTurnInfo,
} from './knowledge/types';
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
  knowledgeServerUrl: string;
  knowledgeServerTokenConfigured: boolean;
  knowledgeAutoRetrieve: boolean;
  knowledgeTopK: number;
  knowledgeMaxChars: number;
  /** Write-only values; empty means keep the stored secret. */
  apiKey?: string;
  skillServerToken?: string;
  knowledgeServerToken?: string;
  clearApiKey?: boolean;
  clearSkillServerToken?: boolean;
  clearKnowledgeServerToken?: boolean;
}

export interface SessionSummary {
  id: string;
  title: string;
  busy: boolean;
}

export interface SetupStatus {
  platform: 'win32' | 'darwin' | 'linux';
  apiKeyConfigured: boolean;
  codexCommand: string;
  codexDetected: boolean;
}

/**
 * Events that belong to one conversation. They are recorded by the host and
 * replayed when a webview surface (sidebar or editor panel) attaches or when
 * the user switches sessions.
 */
export type SessionEvent =
  | { type: 'user.message'; text: string }
  | { type: 'busy'; busy: boolean }
  | {
      type: 'turn.start';
      turnId: string;
      /** Citations for the knowledge injected into this turn. */
      knowledge?: KnowledgeTurnInfo;
    }
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
  | {
      type: 'knowledge.proposals';
      proposals: KnowledgeProposalSummary[];
      serverConfigured: boolean;
    }
  | {
      type: 'knowledge.library';
      local: KnowledgeLibraryItem[];
      remote?: KnowledgeLibraryItem[];
      remoteError?: string;
    }
  | { type: 'setup.status'; status: SetupStatus }
  | { type: 'setup.open' }
  | { type: 'knowledge.open' }
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
      includeKnowledge?: boolean;
    }
  | { type: 'cancel' }
  | {
      type: 'approval.response';
      id: string;
      decision: ApprovalDecision;
    }
  | { type: 'openFile'; path: string; line?: number; endLine?: number }
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
  | { type: 'knowledge.reindex' }
  | { type: 'knowledge.search' }
  | { type: 'knowledge.status' }
  | { type: 'knowledge.open' }
  | { type: 'knowledge.refresh' }
  | { type: 'knowledge.capture' }
  | { type: 'knowledge.approve'; id: string; target?: 'local' | 'remote' }
  | { type: 'knowledge.reject'; id: string }
  | { type: 'knowledge.edit'; id: string }
  | { type: 'knowledge.deleteProposal'; id: string }
  | { type: 'knowledge.library.request' }
  | { type: 'setup.request' }
  | { type: 'setup.detectCodex' }
  | { type: 'setup.openDocs' }
  | { type: 'setup.dismiss' }
  | { type: 'session.new' }
  | { type: 'session.select'; id: string }
  | { type: 'session.rename'; id: string; title: string }
  | { type: 'session.close'; id: string; confirm: boolean };
