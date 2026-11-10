import { resolve } from 'node:path';
import { parseTokens } from './auth';
import { createSkillServer } from './server';

const port = Number(process.env.PORT ?? '4770');
const hostname = process.env.SKILL_SERVER_HOSTNAME ?? '127.0.0.1';
const dataDir = resolve(process.env.SKILL_SERVER_DATA ?? './data');
const tokens = parseTokens(process.env.SKILL_SERVER_TOKENS);
const allowAnonymousReader =
  process.env.SKILL_SERVER_ALLOW_ANONYMOUS_READER === '1';
const devAdminToken = process.env.SKILL_SERVER_DEV_ADMIN_TOKEN?.trim() || undefined;

const app = createSkillServer({
  dataDir,
  auth: { tokens, allowAnonymousReader },
  ...(devAdminToken === undefined ? {} : { devAdminToken }),
});

app.server.listen(port, hostname, () => {
  console.log(`AgentBox skill registry listening on http://${hostname}:${port}`);
  console.log(`data: ${dataDir}`);
  console.log(`admin: http://localhost:${port}/admin`);
});

function shutdown(): void {
  void app.close().finally(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
