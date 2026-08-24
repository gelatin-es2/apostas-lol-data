// mapPhase.cjs — fase de um MAPA num instante. Substitui o uso indevido de
// `odds_timeline.phase`. Criado 2026-08-23 (fase 3, item 3.4).
//
// ============================================================================
// O PROBLEMA QUE ISTO RESOLVE
// ============================================================================
// `odds_timeline.phase` é a fase da SÉRIE na leitura da Pinnacle, não a fase do
// mapa daquela linha (gravado em capture_pinnacle_to_supabase.cjs:265). Numa BO3,
// enquanto o mapa 1 rola a Pinnacle já cota o mapa 2 — e essa leitura entra no
// banco com `phase='live'`. Pro mapa 2 ela é uma leitura PRÉ-JOGO.
//
// Consequência prática: `where phase='live'` pra estudar mercado ao vivo mistura
// linha pré-mapa com linha in-play. Em 23/08 isso era 3.771 linhas `phase='live'`,
// das quais boa parte é pré-mapa. Toda conclusão sobre "under ao vivo" tirada desse
// filtro está contaminada.
//
// A fase de VERDADE precisa do relógio do mapa, que a Pinnacle não dá. Vem de duas
// fontes independentes, nesta ordem:
//   1. game_drafts.first_frame_utc / last_frame_utc — relógio da Riot (fonte boa,
//      mas só 341 de 8.966 drafts têm em 23/08).
//   2. closing_lines.first_seen_live_at — 1ª leitura live daquele (série, mapa) na
//      própria Pinnacle (294 de 653 em 23/08). Não sabe quando o mapa ACABOU, então
//      só distingue 'pre' de 'live_or_post'.
// Sem nenhuma das duas: null. NULL é resposta legítima — não inventar fase.
//
// ============================================================================
// USO
// ============================================================================
//   const { deriveMapPhase, buildMapPhaseIndex } = require('../lib/mapPhase.cjs');
//
//   // puro, sem I/O:
//   deriveMapPhase({ capturedAt: row.captured_at,
//                    firstFrameUtc: draft.first_frame_utc,
//                    lastFrameUtc:  draft.last_frame_utc })   // -> 'pre'|'live'|'post'|null
//
//   // com o banco:
//   const idx = await buildMapPhaseIndex(supabaseUrl, supabaseKey, { from, to });
//   idx.phaseOf(row);   // row de odds_timeline -> { phase, source, confident }
//
'use strict';

const { supabaseGetAll } = require('./supabaseQuery.cjs');

const ms = (t) => (t ? new Date(t).getTime() : NaN);

/**
 * Fase de UM mapa num instante, a partir das âncoras da Riot. Função pura.
 *
 * @param {object} a
 * @param {string} a.capturedAt     ISO — instante da leitura/aposta
 * @param {string} [a.firstFrameUtc] ISO — 1º frame do mapa (início real)
 * @param {string} [a.lastFrameUtc]  ISO — último frame do mapa (fim real)
 * @returns {'pre'|'live'|'post'|null}  null = sem âncora, não dá pra afirmar
 */
function deriveMapPhase({ capturedAt, firstFrameUtc, lastFrameUtc }) {
  const t = ms(capturedAt);
  const t0 = ms(firstFrameUtc);
  if (!Number.isFinite(t) || !Number.isFinite(t0)) return null;
  if (t < t0) return 'pre';
  const t1 = ms(lastFrameUtc);
  if (Number.isFinite(t1) && t > t1) return 'post';
  // Sem last_frame_utc não dá pra separar 'live' de 'post'. Devolve 'live' porque o
  // mapa comprovadamente já tinha começado — quem precisa da distinção tem que
  // checar `confident` no índice abaixo.
  return 'live';
}

/**
 * Índice consultável de fase por mapa, montado do banco.
 * Usa game_drafts como fonte primária e closing_lines como fallback.
 *
 * @param {string} supabaseUrl
 * @param {string} supabaseKey
 * @param {object} [opts]
 * @param {string} [opts.from] ISO/date — janela por start_time (default: sem limite)
 * @param {string} [opts.to]
 */
async function buildMapPhaseIndex(supabaseUrl, supabaseKey, opts = {}) {
  const { from, to } = opts;

  let dq = '/rest/v1/game_drafts?select=game_id,match_id,game_number,first_frame_utc,last_frame_utc,match_start&order=game_id.asc';
  if (from) dq += `&or=(match_start.gte.${from},first_frame_utc.gte.${from})`;
  if (to) dq += `&or=(match_start.lte.${to}T23:59:59,first_frame_utc.lte.${to}T23:59:59)`;
  const drafts = await supabaseGetAll(supabaseUrl, supabaseKey, dq);

  let cq = '/rest/v1/closing_lines?select=series_id::text,map_number,first_seen_live_at,start_time&order=series_id.asc';
  if (from) cq += `&start_time=gte.${from}`;
  if (to) cq += `&start_time=lte.${to}T23:59:59`;
  const closings = await supabaseGetAll(supabaseUrl, supabaseKey, cq);

  const byGameId = new Map();
  for (const d of drafts) if (d.game_id) byGameId.set(String(d.game_id), d);

  const bySeriesMap = new Map();
  for (const c of closings) bySeriesMap.set(`${c.series_id}|${c.map_number}`, c);

  /**
   * @param {object} row  linha de odds_timeline (ou qualquer objeto com
   *   captured_at + riot_game_id e/ou series_id + map_number)
   * @returns {{phase: string|null, source: string, confident: boolean}}
   *   confident=false quando não dá pra distinguir 'live' de 'post'.
   */
  function phaseOf(row) {
    const at = row.captured_at || row.bet_datetime || row.at;

    const d = row.riot_game_id ? byGameId.get(String(row.riot_game_id)) : null;
    if (d && d.first_frame_utc) {
      const phase = deriveMapPhase({
        capturedAt: at, firstFrameUtc: d.first_frame_utc, lastFrameUtc: d.last_frame_utc,
      });
      return { phase, source: 'game_drafts.first_frame_utc', confident: !!d.last_frame_utc || phase === 'pre' };
    }

    const c = bySeriesMap.get(`${row.series_id}|${row.map_number}`);
    if (c && c.first_seen_live_at) {
      const t = ms(at), t0 = ms(c.first_seen_live_at);
      if (Number.isFinite(t) && Number.isFinite(t0)) {
        // A Pinnacle só vira 'live' pro mapa depois que ele começa; ela não avisa
        // quando acaba. Então 'pre' é confiável e 'live' pode na verdade ser 'post'.
        const phase = t < t0 ? 'pre' : 'live';
        return { phase, source: 'closing_lines.first_seen_live_at', confident: phase === 'pre' };
      }
    }

    return { phase: null, source: 'sem_ancora', confident: false };
  }

  return {
    phaseOf,
    stats: {
      drafts_indexados: byGameId.size,
      drafts_com_first_frame: drafts.filter((d) => d.first_frame_utc).length,
      closings_indexados: bySeriesMap.size,
      closings_com_first_seen_live: closings.filter((c) => c.first_seen_live_at).length,
    },
  };
}

module.exports = { deriveMapPhase, buildMapPhaseIndex };
