# Knowledge Base

Base de conhecimento operacional do projeto `apostas-lol-data`. Versionada junto com o código — o time e os subagents consultam antes de agir.

## Estrutura

| Pasta | O que vai aqui |
|-------|----------------|
| `audits/` | Resultados de auditorias pontuais — análise de período, validação de dados, investigação de bug |
| `decisions/` | Decisões arquiteturais e operacionais com contexto e motivação. Formato: `YYYY-MM-DD-titulo.md` |
| `lessons/` | Lições de bugs e incidentes: sintoma → causa raiz → fix → como evitar. Formato: `dominio-descricao.md` |
| `references/` | Cheat sheets, tabelas de lookup, IDs de ligas/times, configs de referência |

## Arquivos especiais

- `pending.md` — pendências aguardando ação na próxima sessão

## Como usar

**Antes de mexer em algo com histórico** (ex: fair line, método, Supabase): consulte `decisions/` e `lessons/` do domínio relevante.

**Depois de resolver bug não-trivial**: crie lição em `lessons/`.

**Depois de decisão estratégica**: crie entrada em `decisions/`.
