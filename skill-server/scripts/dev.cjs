/**
 * Local-only Skill Registry launcher.
 *
 * It fills in development defaults for the environment variables so the
 * admin page can be opened without crafting a token JSON by hand.
 * Never use these tokens for a shared or production server.
 */
const { resolve } = require('node:path');

const defaults = {
  PORT: '4770',
  SKILL_SERVER_DATA: resolve(__dirname, '..', '.dev-data'),
  SKILL_SERVER_TOKENS: JSON.stringify({
    'dev-reader': 'reader',
    'dev-author': 'author',
    'dev-reviewer': 'reviewer',
    'dev-admin': 'admin',
  }),
  SKILL_SERVER_ALLOW_ANONYMOUS_READER: '1',
  SKILL_SERVER_DEV_ADMIN_TOKEN: 'dev-admin',
};

for (const [key, value] of Object.entries(defaults)) {
  if (process.env[key] === undefined || process.env[key] === '') {
    process.env[key] = value;
  }
}

const tokens = JSON.parse(process.env.SKILL_SERVER_TOKENS);
console.log('');
console.log('AgentBox Skill Registry — development mode');
console.log('  URL:   http://127.0.0.1:' + process.env.PORT + '/admin');
console.log('  Data:  ' + process.env.SKILL_SERVER_DATA);
console.log('  Tokens (key -> role):');
for (const [token, role] of Object.entries(tokens)) {
  console.log('    ' + token + ' -> ' + role);
}
console.log('');
console.log('Admin page: auto-login enabled (dev-admin).');
console.log('Extension sync: no token needed on loopback (anonymous reader enabled).');
console.log('Do not use these development tokens on a shared server.');
console.log('');

require(resolve(__dirname, '..', 'dist', 'index.js'));
