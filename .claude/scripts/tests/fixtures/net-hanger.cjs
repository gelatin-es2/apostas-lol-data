// Preload (--require) que faz TODA chamada https pendurar pra sempre.
// Uso: node --require net-hanger.cjs <script>
// Serve pra provar o watchdog do timeout interno do settle (SETTLE_TIMEOUT_MS):
// o request nunca responde, o event loop fica vivo (timer de 60s não-unref) e o
// watchdog precisa disparar sozinho com exit 3 + JSON degradado.
// Nunca toca rede real.

'use strict';

const https = require('https');
const { EventEmitter } = require('events');

// timer não-unref segura o processo vivo enquanto o request "pendura"
setTimeout(() => {}, 60 * 1000);

function hangingRequest() {
  const req = new EventEmitter();
  req.setTimeout = () => req;   // ignora timeouts do caller: pendura mesmo
  req.write = () => true;
  req.end = () => req;
  req.destroy = () => req;
  req.abort = () => req;
  return req;
}

https.request = () => hangingRequest();
https.get = () => hangingRequest();
