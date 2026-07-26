# Lição: schedule fantasma na lolesports API (LPL split 3)

**Quando aparece:** getSchedule retorna jogos com `state: "completed"` ANTES do horário de início, e/ou dias com jogos a mais/horário errado. Detectado 2026-07-23: API listava 3 jogos LPL no dia 23 (07:00/09:00/11:00Z, todos "completed" de madrugada) quando o real eram 2 jogos (~09:00/11:00Z) com o terceiro (AL×LGD) no dia 24. O Elvis pegou pelo stream/Leaguepedia; gol.gg confirmou as datas.

**Causa raiz:** desconhecida (cache/reagendamento mal propagado no persisted/gw). O campo `state` do getSchedule está não-confiável nesta semana — `completed` em jogo futuro é o sintoma-sentinela.

**Fix/como operar:**
1. `state: "completed"` com `startTime` no futuro = BANDEIRA VERMELHA → cross-check gol.gg (`tournament-matchlist`) ou Leaguepedia ANTES de afirmar horário ao Elvis.
2. `getEventDetails` + livestats window são mais confiáveis que o state do schedule (games "unstarted" + window vazia = jogo realmente não começou).
3. Contagem de jogos do briefing pode vir errada nesses dias — validar contra gol.gg quando o dia parecer atípico (LPL com 3 jogos em dia de semana é raro).

**Custo evitável:** Elvis acordado 04:00 pra jogo das 06:00; briefing de 23/07 anunciou 3 jogos LPL (eram 2).

**Referência:** conversa 2026-07-23 madrugada; gol.gg LPL 2026 Split 3 matchlist.
