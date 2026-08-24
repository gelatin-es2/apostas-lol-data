#!/usr/bin/env node
// diag-read-logged-tab.cjs — lê PASSIVAMENTE a linha de kills que está na tela de
// uma aba da Pinnacle JÁ LOGADA pelo Elvis, e carimba a hora ao milissegundo.
//
// Par do diag-guest-vs-logged.cjs (lado deslogado). Juntos respondem a pergunta
// aberta de 07/08: a Pinnacle serve odd atrasada pra quem está deslogado?
// O report 2026-08-23 provou atraso de até 905s POR CACHE Cloudflare e não achou
// gate por login (86 pares, 0 divergências) — mas "não achei evidência" não é
// prova de ausência. Este script fecha a metade que faltava.
//
// O QUE ELE FAZ: conecta no Chrome via CDP (porta de debug), acha a aba da
// Pinnacle, e lê o TEXTO JÁ RENDERIZADO da página.
// O QUE ELE NÃO FAZ: não loga, não navega, não clica, não recarrega, não fica em
// loop. Zero requisição HTTP sai pra Pinnacle por causa dele — é um print
// programático. Atualizar a página é papel do Elvis, no navegador dele.
//
// COMO USAR
// 1) Feche o Chrome. Reabra com a porta de debug e um perfil separado:
//      "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
//        --remote-debugging-port=9222 ^
//        --user-data-dir="%TEMP%\pinn-debug-profile"
// 2) Nessa janela, logue na Pinnacle e abra o jogo de LoL no mercado de kills.
// 3) Rode:  node .claude/scripts/diag-read-logged-tab.cjs
//
// ⚠️ SEGURANÇA: com --remote-debugging-port aberto, qualquer programa rodando
// nesta máquina pode controlar esse Chrome. Por isso o perfil separado, e por
// isso FECHE essa janela quando terminar o teste.

const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const HOST = `http://127.0.0.1:${CDP_PORT}`;

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

async function listTargets() {
  const res = await fetch(`${HOST}/json/list`);
  if (!res.ok) throw new Error(`CDP respondeu HTTP ${res.status}`);
  return res.json();
}

// Runtime.evaluate numa aba, via WebSocket (global no Node 22+, sem dependência).
function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('timeout no CDP')); }, 15000);
    ws.onopen = () => ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: false },
    }));
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (msg.error) return reject(new Error(msg.error.message));
      const r = msg.result?.result;
      if (r?.subtype === 'error') return reject(new Error(r.description || 'erro no evaluate'));
      resolve(r?.value);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('falha na conexão CDP')); };
  });
}

// Extrai do DOM RENDERIZADO as linhas que parecem mercado de kills. Heurística
// deliberadamente burra e tolerante: a Pinnacle troca de markup com frequência, e
// aqui o que importa é o NÚMERO na tela, não a estrutura.
const EXTRACTOR = `(() => {
  const out = { url: location.href, title: document.title, when: new Date().toISOString(), rows: [] };
  // pt-BR: a Pinnacle BR chama kills de "abates"; mantém 'kill' pro site em inglês
  const wanted = /kill|abate|total/i;
  const seen = new Set();
  for (const el of document.querySelectorAll('div,section,li,tr,span')) {
    if (el.children.length > 6) continue;
    const t = (el.innerText || '').trim();
    if (!t || t.length > 220 || !wanted.test(t)) continue;
    if (!/\\d/.test(t)) continue;
    const norm = t.replace(/\\s+/g, ' ');
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.rows.push(norm);
    if (out.rows.length >= 40) break;
  }
  const nums = (document.body.innerText.match(/\\b\\d{2}\\.5\\b/g) || []);
  out.halfLines = [...new Set(nums)].slice(0, 30);
  // fallback: texto cru da página, pra quando a heurística acima não casar com o
  // markup do dia (a Pinnacle troca de estrutura com frequência)
  out.bodyText = (document.body.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 4000);

  // O mercado costuma viver fora do DOM raso: iframe same-origin ou shadow root.
  // Varre os dois e junta o texto — se o número da linha estiver na tela, cai aqui.
  const extra = [];
  for (const f of document.querySelectorAll('iframe')) {
    try {
      const t = f.contentDocument?.body?.innerText;
      if (t && t.trim()) extra.push('[iframe ' + (f.src || 'inline') + ']\\n' + t.slice(0, 2500));
    } catch (e) { extra.push('[iframe bloqueado: ' + (f.src || 'inline') + ']'); }
  }
  const walkShadow = (root, depth) => {
    if (depth > 4) return;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const t = el.shadowRoot.textContent;
        if (t && t.trim().length > 20) extra.push('[shadow ' + el.tagName.toLowerCase() + ']\\n' + t.trim().slice(0, 1500));
        walkShadow(el.shadowRoot, depth + 1);
      }
    }
  };
  try { walkShadow(document, 0); } catch (e) {}
  out.extraText = extra.join('\\n\\n').slice(0, 5000);
  out.readyState = document.readyState;
  return out;
})()`;

(async () => {
  let targets;
  try {
    targets = await listTargets();
  } catch (err) {
    console.error(`Não achei o Chrome com porta de debug em ${HOST}.`);
    console.error(`(${err.message})`);
    console.error('');
    console.error('Abra o Chrome assim, logue na Pinnacle, e rode de novo:');
    console.error('  chrome.exe --remote-debugging-port=9222 --user-data-dir="%TEMP%\\pinn-debug-profile"');
    process.exit(1);
  }

  // Não filtra só 'page': o miolo do sportsbook pode viver num iframe fora do
  // processo (OOPIF), que o Chrome expõe como target separado do tipo 'iframe'.
  const readable = targets.filter((t) => t.webSocketDebuggerUrl && /^(page|iframe|webview)$/.test(t.type));
  const pinn = readable.filter((t) => /pinnacle/i.test(t.url || ''));

  if (!pinn.length) {
    console.error('Chrome achado, mas nenhum alvo da Pinnacle.');
    console.error('Alvos visíveis agora:');
    targets.forEach((p) => console.error(`  - [${p.type}] ${p.title} :: ${p.url}`));
    process.exit(2);
  }
  console.log(`(${pinn.length} alvo(s) da Pinnacle: ${pinn.map((t) => t.type).join(', ')})`);

  console.log('='.repeat(78));
  console.log(`LINHA NA TELA LOGADA — carimbo local ${stamp()}`);
  console.log('='.repeat(78));

  for (const tab of pinn) {
    console.log('');
    console.log(`aba: ${tab.title}`);
    console.log(`url: ${tab.url}`);
    let data;
    try {
      data = await evaluate(tab.webSocketDebuggerUrl, EXTRACTOR);
    } catch (err) {
      console.log(`  [erro lendo a aba] ${err.message}`);
      continue;
    }
    console.log(`  lido às ${stamp()}  (UTC ${data.when})`);
    if (data.halfLines?.length) {
      console.log(`  números de linha vistos na página: ${data.halfLines.join(', ')}`);
    }
    if (!data.rows?.length) {
      console.log(`  (heurística não casou — readyState=${data.readyState}; texto cru abaixo)`);
      console.log('  ' + String(data.bodyText || '').split('\n').join('\n  '));
      if (data.extraText) {
        console.log('  --- iframes / shadow DOM ---');
        console.log('  ' + String(data.extraText).split('\n').join('\n  '));
      }
    } else {
      console.log('  blocos de mercado na tela:');
      data.rows.forEach((r) => console.log(`    ${r}`));
    }
  }

  console.log('');
  console.log('-'.repeat(78));
  console.log('Rode agora o par deslogado, no mesmo minuto:');
  console.log('  node .claude/scripts/diag-guest-vs-logged.cjs');
  console.log('Linha igual = não há gate por login. Diferente = há, e a conclusão muda.');
  console.log('-'.repeat(78));
})().catch((e) => { console.error(e); process.exit(1); });
