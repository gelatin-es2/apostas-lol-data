# Lição: settle-pending-bets.cjs erro 400 livestats "window with end time less than 190 sec old"

**Quando aparece:** ao rodar settle pra bet de match recém-terminado (poucos minutos depois). Erro: `HTTP 400: BAD_QUERY_PARAMETER, disallowed window with end time less than 190 sec old`.

**Causa raiz:** `fetchGameWindow` em `settle-pending-bets.cjs` calculava `targetMs = Math.min(matchStart + 6h, Date.now() - 60s)`. Pra match recém-iniciado/terminado, baseMs (matchStart+6h) cai no futuro → fallback usa `Date.now() - 60s`. Mas a API livestats da Riot exige **mínimo 190s de idade** na janela. Resultado: 400 sempre que o cron tentava antes de 190s pós-match.

**Fix:** Mudei o offset de fallback de `60s` pra `200s` (margem segura sobre o limite 190s da API).

```js
const baseMs = ... ? startMs + 6 * 3600 * 1000 : Date.now() - 200 * 1000;
const targetMs = Math.min(baseMs, Date.now() - 200 * 1000);
```

**Como evitar:** quando uma API externa tem rate-limit/window-limit, sempre adicionar margem ≥10% sobre o limite documentado. 60s vs 190s era subdimensionado pra caso normal (match rolando agora). 200s passa folgado e ainda mantém latência baixa pro cron.

**Sintoma colateral:** bets de matches recém-terminados ficavam pending até o cron passar várias vezes (toda passada falhava com 400 até o match estar 190s+ velho). Elvis tinha que pedir settle manual — que também falhava no script velho.

**Referência:** 2026-05-07, EstrelaBet SLY vs ZYB Map 1 (35a330a6) — settle deu 400 duas vezes consecutivas, fix aplicou e fechou GREEN +R$438.

**Cross-check antes do fix:** `getEventDetails` confirmou `Game 1: completed, Game 2: completed, Game 3: unneeded` (SLY 2-0 ZYB) — match terminado, dados existiam, só o cálculo da janela não chegava. Vale lembrar: não confiar em `getSchedule` `state` (estava `inProgress`), confiar em `getEventDetails`.
