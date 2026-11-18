import * as vscode from 'vscode';
import { collectionForRoot } from './scanner';

export interface KnowledgeSettings {
  serverUrl: string;
  autoRetrieve: boolean;
  topK: number;
  maxChars: number;
  /** Empty means derive from the workspace root. */
  collection: string;
  maxFileBytes: number;
}

export function knowledgeServerTokenKey(): string {
  return 'agentbox.knowledgeServer.token';
}

export function readKnowledgeSettings(): KnowledgeSettings {
  const config = vscode.workspace.getConfiguration('agentbox');
  const topK = config.get<number>('knowledge.topK', 5);
  const maxChars = config.get<number>('knowledge.maxChars', 6_000);
  const maxFileBytes = config.get<number>('knowledge.maxFileBytes', 1_048_576);
  return {
    serverUrl: config.get<string>('knowledge.serverUrl', '').trim(),
    autoRetrieve: config.get<boolean>('knowledge.autoRetrieve', true),
    topK:
      Number.isInteger(topK) && topK >= 1 && topK <= 20
        ? topK
        : 5,
    maxChars:
      Number.isInteger(maxChars) && maxChars >= 1_000 && maxChars <= 20_000
        ? maxChars
        : 6_000,
    collection: config.get<string>('knowledge.collection', '').trim(),
    maxFileBytes:
      Number.isInteger(maxFileBytes) && maxFileBytes >= 1_024
        ? maxFileBytes
        : 1_048_576,
  };
}

export function collectionForWorkspace(
  root: string,
  settings: KnowledgeSettings = readKnowledgeSettings()
): string {
  if (settings.collection !== '') {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(settings.collection)) {
      throw new Error(
        'agentbox.knowledge.collection must match ^[A-Za-z0-9._:-]{1,128}$'
      );
    }
    return settings.collection;
  }
  return collectionForRoot(root);
}
