// Fixtures do schedule lolesports pros testes do finder (contrato v1).
// makeFetch(leagueId, events) → fetchJson fake injetável em runFindMatch:
// devolve `events` pra liga alvo e schedule vazio pras demais. Zero rede.

'use strict';

// Data-alvo fixa dos testes: futuro distante pra nunca colidir com
// cron-data real (fair file de hoje) nem com clock da máquina.
const TARGET_DATE = '2027-01-15';
const NOW_MS = Date.parse('2027-01-15T07:30:00Z');

function ev(startTime, state, matchId, codeA, nameA, codeB, nameB) {
  return {
    startTime,
    state,
    match: {
      id: matchId,
      teams: [
        { code: codeA, name: nameA },
        { code: codeB, name: nameB },
      ],
    },
  };
}

// fetch fake: só a liga `leagueId` tem eventos; demais ligas devolvem vazio.
function makeFetch(leagueId, events) {
  return async (url) => {
    const m = url.match(/leagueId=(\d+)/);
    const isTarget = m && m[1] === leagueId;
    return {
      data: {
        schedule: {
          events: isTarget ? events : [],
          pages: {}, // sem paginação
        },
      },
    };
  };
}

const LCK_ID = '98767991310872058';

const FIXTURES = {
  TARGET_DATE,
  NOW_MS,
  LCK_ID,

  // 1. match único exato — unstarted, começa em 30min (starting_soon)
  unique: [ev(`${TARGET_DATE}T08:00:00Z`, 'unstarted', '111111111111111111', 'T1', 'T1', 'GEN', 'Gen.G')],

  // 2. dois candidatos ambíguos no mesmo dia (mesmos times, horários diferentes)
  ambiguous: [
    ev(`${TARGET_DATE}T08:00:00Z`, 'unstarted', '222222222222222221', 'T1', 'T1', 'GEN', 'Gen.G'),
    ev(`${TARGET_DATE}T12:00:00Z`, 'unstarted', '222222222222222222', 'T1', 'T1', 'GEN', 'Gen.G'),
  ],

  // 3. match live (inProgress agora)
  live: [ev(`${TARGET_DATE}T07:00:00Z`, 'inProgress', '333333333333333333', 'T1', 'T1', 'GEN', 'Gen.G')],

  // 4. match concluído no mesmo dia
  completedSameDay: [ev(`${TARGET_DATE}T01:00:00Z`, 'completed', '444444444444444444', 'T1', 'T1', 'GEN', 'Gen.G')],

  // 5. nenhum match na data (evento de outro dia)
  otherDay: [ev('2027-01-14T08:00:00Z', 'completed', '555555555555555555', 'T1', 'T1', 'GEN', 'Gen.G')],

  // estado fora do enum → state: "unknown" + state_raw preservado
  weirdState: [ev(`${TARGET_DATE}T08:00:00Z`, 'somethingNew', '666666666666666666', 'T1', 'T1', 'GEN', 'Gen.G')],
};

module.exports = { FIXTURES, makeFetch };
