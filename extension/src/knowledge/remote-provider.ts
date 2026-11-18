import { KnowledgeServerClient } from './client';
import type {
  KnowledgeProvider,
  KnowledgeProviderCapabilities,
} from './provider';
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
 * HTTP implementation of the provider-neutral interface. The server may later
 * be replaced by another search backend as long as this contract is honored.
 */
export class RemoteKnowledgeProvider implements KnowledgeProvider {
  readonly id = 'remote';
  readonly capabilities: KnowledgeProviderCapabilities = {
    lexical: true,
    vector: false,
    propose: true,
    review: true,
    ingest: true,
  };

  constructor(private readonly client: KnowledgeServerClient) {}

  search(request: SearchRequest): Promise<SearchResponse> {
    return this.client.search(request);
  }

  status(): Promise<StatusResponse> {
    return this.client.status();
  }

  createProposal(input: KnowledgeProposalInput): Promise<KnowledgeProposal> {
    return this.client.createProposal(input);
  }

  listProposals(
    status?: KnowledgeProposalStatus
  ): Promise<KnowledgeProposalSummary[]> {
    return this.client.listProposals(status);
  }

  updateProposal(
    id: string,
    patch: KnowledgeProposalPatch
  ): Promise<KnowledgeProposal> {
    return this.client.updateProposal(id, patch);
  }

  approveProposal(id: string): Promise<KnowledgeProposal> {
    return this.client.approveProposal(id);
  }

  rejectProposal(id: string): Promise<KnowledgeProposal> {
    return this.client.rejectProposal(id);
  }
}
