const { resolve } = require('node:path');

process.env.PORT = process.env.PORT || '4771';
process.env.KNOWLEDGE_SERVER_HOSTNAME =
  process.env.KNOWLEDGE_SERVER_HOSTNAME || '127.0.0.1';
process.env.KNOWLEDGE_SERVER_DATA =
  process.env.KNOWLEDGE_SERVER_DATA || resolve(__dirname, '..', '.knowledge-data');
process.env.KNOWLEDGE_SERVER_TOKENS =
  process.env.KNOWLEDGE_SERVER_TOKENS ||
  JSON.stringify({
    'dev-reader': 'reader',
    'dev-author': 'author',
    'dev-admin': 'admin',
  });
process.env.KNOWLEDGE_SERVER_ALLOW_ANONYMOUS_READER =
  process.env.KNOWLEDGE_SERVER_ALLOW_ANONYMOUS_READER || '1';

console.log('dev tokens: dev-reader -> reader, dev-author -> author, dev-admin -> admin');
console.log('anonymous loopback reader is enabled; writes need dev-author/dev-admin');
require('../dist/index.js');
