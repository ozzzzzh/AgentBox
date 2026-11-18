import { resolve } from 'node:path';
import { isLoopbackHost, parseTokens } from './auth';
import { createKnowledgeServer } from './server';

const major = Number(process.versions.node.split('.')[0] ?? '0');
if (major < 24) {
  console.error(
    `AgentBox knowledge-server requires Node >= 24 (node:sqlite); current ${process.versions.node}`
  );
  process.exit(1);
}

const port = Number(process.env.PORT ?? '4771');
const hostname = process.env.KNOWLEDGE_SERVER_HOSTNAME ?? '127.0.0.1';
const dataDir = resolve(process.env.KNOWLEDGE_SERVER_DATA ?? './data');
const tokens = parseTokens(process.env.KNOWLEDGE_SERVER_TOKENS);
const allowAnonymousReader =
  process.env.KNOWLEDGE_SERVER_ALLOW_ANONYMOUS_READER === '1';

if (allowAnonymousReader && !isLoopbackHost(hostname)) {
  console.error(
    'KNOWLEDGE_SERVER_ALLOW_ANONYMOUS_READER is only allowed on a loopback bind'
  );
  process.exit(1);
}
if (Object.keys(tokens).length === 0 && !allowAnonymousReader) {
  console.error(
    'No KNOWLEDGE_SERVER_TOKENS configured. Set tokens or enable anonymous loopback reader.'
  );
  process.exit(1);
}

const app = createKnowledgeServer({
  dataDir,
  auth: { tokens, allowAnonymousReader },
});

app.server.listen(port, hostname, () => {
  console.log(`AgentBox knowledge server listening on http://${hostname}:${port}`);
  console.log(`data: ${dataDir}`);
  console.log(`fts: sqlite trigram (node:sqlite)`);
  if (allowAnonymousReader) {
    console.log('auth: anonymous reader enabled (loopback only)');
  } else {
    console.log(`auth: ${Object.keys(tokens).length} bearer token(s)`);
  }
});

function shutdown(): void {
  void app.close().finally(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
