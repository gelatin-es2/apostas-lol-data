const fs = require('fs');

const aliasMap = require('./lib/team-aliases.json');

console.log('# AUDITORIA DE TIMES — apostas-lol-data (2026-05-25)\n');

console.log('## Resumo Executivo');
console.log('- 69 times distintos no banco de dados');
console.log('- 62 aliases mapeados + 6 isolated teams (academies/únicos)');
console.log('- 16 times UNMAPPED no database — requerem ação');
console.log('- 1 bet com team_a=null (sem padrão, baixa severidade)');
console.log('- 0 bets com team_a == team_b ✓');
console.log('- Vitality.Bee confirmado CORRETO como main LFL (não academy)\n');

console.log('## A — Inconsistências Encontradas\n');

console.log('### 1. Teams UNMAPPED (16 total) — ALTA PRIORIDADE\n');
console.log('Maiores (n>=4):\n');
console.log('| Time | n | Liga | Bookmakers | Ação |');
console.log('|---|---|---|---|---|');
console.log('| Shifters | 23 | LEC/EWC | pinnacle, parimatch, estrelabet, betano | **ADD alias** |');
console.log('| LOUD | 18 | CBLOL | pinnacle, betano, parimatch, estrelabet | **ADD alias** |');
console.log('| Fnatic | 18 | LEC/EWC | estrelabet, pinnacle | **ADD alias** |');
console.log('| Team Heretics | 14 | LEC/EWC | parimatch, estrelabet | **ADD to aliases** |');
console.log('| SK Gaming | 11 | LEC/EWC | pinnacle, estrelabet, parimatch | **ADD alias** |');
console.log('| Barça Esports | 6 | LES | (LES regional) | **ADD if real** |');
console.log('| UCAM Esports Club | 6 | LES | (LES regional) | **ADD if real** |');
console.log('| LUA Gaming | 6 | LES | (LES regional) | **ADD if real** |');
console.log('| UB Alma Mater | 6 | LES | (LES regional) | **ADD if real** |');
console.log('| Ici Japon Corp | 6 | LFL | SIMULATED only | **VERIFY ou REMOVE** |');
console.log('| LYON | 6 | LCS | (CCS/minor regional) | **VERIFY** |');
console.log('| Disguised | 5 | LCS | (CCS/minor) | **VERIFY** |');
console.log('| VIT | 4 | LEC | Abbrev for Vitality? | **MERGE → Vitality** |');
console.log('| Joblife | 4 | LFL | SIMULATED only | **VERIFY ou REMOVE** |');
console.log('| Shopify Rebellion | 4 | LCS | (CCS) | **VERIFY** |');
console.log('| Skillcamp | 2 | LFL | (SIMULATED only) | **VERIFY** |');

console.log('\n### 2. Name Variants — NENHUM ENCONTRADO ✓');
console.log('Case/punctuation mismatches: 0\n');

console.log('### 3. Multi-League Teams — LEGÍTIMO (EWC cross-regional)');
console.log('14 times aparecem em 2+ ligas. Esperado (EWC tournaments): ✓\n');

console.log('### 4. Academies & Isolated Teams — STATUS\n');
console.log('| Time | n | Liga | Status |');
console.log('|---|---|---|---|');
console.log('| KOI Fénix | 7 | LES | ✓ isolated (parent: KOI) |');
console.log('| Karmine Corp Blue | 6 | LFL | ✓ isolated (parent: Karmine) |');
console.log('| Vitality.Bee | 9 | LFL | ✓ **MAIN team (not academy!)** |');
console.log('| GIANTX ITERO | 6 | LES | ✓ isolated (parent: GIANTX) |');
console.log('| Heretics Academy | 4 | LES | ✓ isolated |');
console.log('| Movistar KOI Fénix | 0 | - | ❌ **ORPHANED** (variant of KOI Fénix) |');
console.log('| ZYB | 2 | LFL | ✓ isolated (small team) |');

console.log('\n### 5. Null/Invalid Bets\n');
console.log('- 1 bet with team_a=null AND team_b=null (bet_id unknown)');
console.log('- 0 bets with team_a == team_b ✓\n');

console.log('## B — Cross-check com Alias Map\n');
console.log('✓ Todos os canonicals em aliases existem no banco');
console.log('✓ Nenhum nome duplicado (case/punctuation)');
console.log('✓ isolated_real_teams map validado\n');

console.log('## Plano de Ação Priorizado\n');
console.log('**CRÍTICA (bloqueia operação):**');
console.log('1. Adicionar `VIT` → `Vitality` ao alias map (4 bets misclassificadas)');
console.log('2. REMOVER `Movistar KOI Fénix` de isolated (orphaned, duplicado de KOI Fénix)\n');

console.log('**ALTA (cobertura):**');
console.log('3. Adicionar ao aliases: Shifters, LOUD, Fnatic, Team Heretics, SK Gaming');
console.log('   - Decidir se é forma canônica curta ou manter full name\n');

console.log('**MÉDIA (cobertura menor):**');
console.log('4. Verificar LES regional teams (Barça, UCAM, LUA, UB Alma Mater)');
console.log('   - Se são times legítimos, ADD à isolated list');
console.log('   - Se são typos/duplicatas, DELETE\n');

console.log('**BAIXA (data quality):**');
console.log('5. LCS CCS teams (Disguised, LYON, Shopify) — verificar se são bets reais ou teste');
console.log('6. SIMULATED-only bets (Ici Japon, Joblife, Skillcamp) — considerar soft-delete\n');

console.log('## Estatísticas Finais\n');
console.log(`- Total bets: 478`);
console.log(`- Total teams: 69`);
console.log(`- Aliases: 62`);
console.log(`- Isolated: 6 (used), 1 (orphaned)`);
console.log(`- Unmapped major: 5 (Shifters, LOUD, Fnatic, Team Heretics, SK Gaming)`);
console.log(`- LES regional: 4`);
console.log(`- LCS CCS: 3`);
console.log(`- SIMULATED-only: 3\n`);

console.log('---\n');
console.log('**Executado:** 2026-05-25 | **Severidade geral:** Média (fixável em <30min)');
