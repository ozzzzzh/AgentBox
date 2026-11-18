import type {
  KnowledgeProposal,
  KnowledgeProposalInput,
  KnowledgeProposalPatch,
  KnowledgeProposalStatus,
  KnowledgeProposalSummary,
  SearchRequest,
  SearchResponse,
  StatusResponse,
} from './types';

/**
 * Provider-neutral knowledge boundary. The agent/UI only depend on this
 * contract; local and remote servers can be swapped behind it.
 */
export interface KnowledgeProviderCapabilities {
  lexical: boolean;
  vector: boolean;
  propose: boolean;
  review: boolean;
  ingest: boolean;
}

export interface KnowledgeProvider {
  readonly id: string;
  readonly capabilities: KnowledgeProviderCapabilities;

  search(request: SearchRequest): Promise<SearchResponse>;
  status?(): Promise<StatusResponse>;

  createProposal?(input: KnowledgeProposalInput): Promise<KnowledgeProposal>;
  listProposals?(
    status?: KnowledgeProposalStatus
  ): Promise<KnowledgeProposalSummary[]>;
  updateProposal?(
    id: string,
    patch: KnowledgeProposalPatch
  ): Promise<KnowledgeProposal>;
  approveProposal?(id: string): Promise<KnowledgeProposal>;
  rejectProposal?(id: string): Promise<KnowledgeProposal>;
}
