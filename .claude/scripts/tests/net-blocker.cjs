// Preload (--require) que bloqueia QUALQUER tentativa de rede do processo.
// Uso: node --require .claude/scripts/tests/net-blocker.cjs <script>
// Prova que --validate-only do supabase-save-bet.cjs roda 100% offline:
// se algo tocar rede, o processo estoura com NETWORK BLOCKED.

'use strict';

const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const dns = require('dns');

function boom(what) {
  // stderr pra diagnóstico + throw síncrono pra derrubar o caller
  process.stderr.write(`[NET-BLOCKER] tentativa de rede bloqueada: ${what}\n`);
  throw new Error(`NETWORK BLOCKED: ${what}`);
}

net.Socket.prototype.connect = function () { boom('net.Socket.prototype.connect'); };
net.connect = () => boom('net.connect');
net.createConnection = () => boom('net.createConnection');
tls.connect = () => boom('tls.connect');
http.request = () => boom('http.request');
http.get = () => boom('http.get');
https.request = () => boom('https.request');
https.get = () => boom('https.get');
dns.lookup = () => boom('dns.lookup');
dns.resolve = () => boom('dns.resolve');
if (typeof globalThis.fetch === 'function') {
  globalThis.fetch = () => boom('globalThis.fetch');
}
