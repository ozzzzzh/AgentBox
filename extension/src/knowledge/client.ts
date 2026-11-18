import type {
  AuditEntry,
  DocumentListResponse,
  SearchRequest,
  SearchResponse,
  StatusResponse,
  UpsertRequest,
  UpsertResponse,
} from './types';

export class KnowledgeServerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string
  ) {
    super(message);
    this.name = 'KnowledgeServerError';
  }
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

function validateServerUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') throw new KnowledgeServerError('Knowledge server URL is not configured');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new KnowledgeServerError('Knowledge server URL is invalid');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new KnowledgeServerError('Knowledge server URL must not contain credentials');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new KnowledgeServerError('Knowledge server URL must use http(s)');
  }
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    throw new KnowledgeServerError(
      'Knowledge server must use HTTPS outside localhost'
    );
  }
  return trimmed;
}

export class KnowledgeServerClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token?: string,
    private readonly clientId?: string,
    private readonly clientName?: string
  ) {
    this.baseUrl = validateServerUrl(baseUrl);
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs = 15_000
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(joinUrl(this.baseUrl, path), {
        ...init,
        redirect: 'error',
        headers: {
          accept: 'application/json',
          ...(init.body !== undefined
            ? { 'content-type': 'application/json' }
            : {}),
          ...(this.token !== undefined && this.token !== ''
            ? { authorization: `Bearer ${this.token}` }
            : {}),
          ...(this.clientId !== undefined && this.clientId !== ''
            ? {
                'x-agentbox-client': this.clientId,
                ...(this.clientName !== undefined && this.clientName !== ''
                  ? { 'x-agentbox-client-name': this.clientName }
                  : {}),
              }
            : {}),
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
      const text = await response.text();
      let value: unknown;
      try {
        value = text === '' ? undefined : JSON.parse(text);
      } catch {
        value = undefined;
      }
      if (!response.ok) {
        const record =
          typeof value === 'object' && value !== null
            ? (value as { error?: { code?: string; message?: string } })
            : {};
        throw new KnowledgeServerError(
          record.error?.message ?? `Knowledge server HTTP ${response.status}`,
          response.status,
          record.error?.code
        );
      }
      return value as T;
    } catch (error) {
      if (error instanceof KnowledgeServerError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new KnowledgeServerError('Knowledge server request timed out');
      }
      throw new KnowledgeServerError(
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      clearTimeout(timer);
    }
  }

  status(): Promise<StatusResponse> {
    return this.request<StatusResponse>('/v1/knowledge/status');
  }

  search(request: SearchRequest): Promise<SearchResponse> {
    return this.request<SearchResponse>(
      '/v1/knowledge/search',
      { method: 'POST', body: JSON.stringify(request) },
      5_000
    );
  }

  listDocuments(
    collection: string,
    limit = 500,
    offset = 0
  ): Promise<DocumentListResponse> {
    const params = new URLSearchParams({
      collection,
      limit: String(limit),
      offset: String(offset),
    });
    return this.request<DocumentListResponse>(
      `/v1/knowledge/documents?${params.toString()}`
    );
  }

  upsert(request: UpsertRequest): Promise<UpsertResponse> {
    return this.request<UpsertResponse>(
      '/v1/knowledge/documents',
      { method: 'POST', body: JSON.stringify(request) },
      30_000
    );
  }

  deleteDocument(id: string): Promise<{ ok: true; deleted: true }> {
    return this.request(
      `/v1/knowledge/documents/${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    );
  }

  reindex(): Promise<{ ok: true; documents: number; chunks: number }> {
    return this.request('/v1/knowledge/reindex', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  audit(limit = 100, action?: string): Promise<{ apiVersion: number; entries: AuditEntry[] }> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (action !== undefined && action !== '') params.set('action', action);
    return this.request(`/v1/knowledge/audit?${params.toString()}`);
  }
}
