import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KnowledgeServerClient,
  KnowledgeServerError,
} from '../src/knowledge/client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('knowledge server client', () => {
  it('searches with bearer auth and client identity', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          apiVersion: 1,
          mode: 'fts',
          results: [],
          truncated: false,
          warnings: [],
          latencyMs: 3,
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new KnowledgeServerClient(
      'http://127.0.0.1:4771',
      'token',
      'client-1',
      'machine'
    );
    const result = await client.search({
      collection: 'ws_test',
      query: '增量同步',
      topK: 5,
    });

    expect(result.mode).toBe('fts');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('http://127.0.0.1:4771/v1/knowledge/search');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer token');
    expect(init.headers['x-agentbox-client']).toBe('client-1');
    expect(JSON.parse(init.body).query).toBe('增量同步');
  });

  it('parses server error envelopes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: { code: 'QUERY_REQUIRED', message: 'query is required' } }),
          { status: 400 }
        )
      )
    );
    const client = new KnowledgeServerClient('http://127.0.0.1:4771');
    await expect(
      client.search({ collection: 'ws', query: '' })
    ).rejects.toMatchObject({
      name: 'KnowledgeServerError',
      status: 400,
      code: 'QUERY_REQUIRED',
    } satisfies Partial<KnowledgeServerError>);
  });

  it('rejects plain HTTP outside loopback', () => {
    expect(
      () => new KnowledgeServerClient('http://knowledge.example.internal')
    ).toThrow(/HTTPS/);
    expect(
      () => new KnowledgeServerClient('https://knowledge.example.internal')
    ).not.toThrow();
  });

  it('lists documents with pagination parameters', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ documents: [], total: 0 }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new KnowledgeServerClient('http://localhost:4771');
    await client.listDocuments('ws_test', 1000, 2000);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain('collection=ws_test');
    expect(url).toContain('limit=1000');
    expect(url).toContain('offset=2000');
  });
});
