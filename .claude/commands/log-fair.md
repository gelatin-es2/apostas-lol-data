---
description: Registra fair lines Pinnacle manual do dia em cron-data/YYYY-MM-DD-fair-pinnacle.json. Aceita ancoras de time + linha (ex: "we 27,5").
argument-hint: [YYYY-MM-DD] [anchor linha...]
allowed-tools: Read, Write, Bash
---

Você vai registrar as fair lines Pinnacle que o Elvis passou manualmente.

## Argumentos

`$ARGUMENTS`

O argumento pode ser:
- Data opcional no formato `YYYY-MM-DD` (se omitida, usa hoje conforme `currentDate` do system prompt)
- Seguido de linhas no formato `anchor valor` — uma por linha ou separadas por espaço
- Vírgula no número é aceita como ponto decimal (`27,5` → `27.5`)

Exemplos válidos:
```
we 27,5
dpolus 28,5
ig 28,5
ns 30,5
kc 27,5
los 27,5
c9 26,5
```

Ou com data explícita:
```
2026-05-24
we 27,5
```

## Passos

1. **Parse dos argumentos**: extrair data (se presente) e lista de `[anchor, valor]`.

2. **Carregar briefing do dia**: rodar `node .claude/scripts/daily_briefing.cjs <data>` para obter a lista de matches do dia.

3. **Fuzzy-match**: para cada anchor informado, encontrar o match correspondente no briefing usando:
   - Normalização: lowercase, strip espaços/pontuação
   - Match por `team_anchor` no arquivo pinnacle existente (se houver)
   - Fallback: match por team_a ou team_b name/code no schedule do briefing
   - Se ambíguo (>1 match possível), marcar como `ambiguous` e listar os candidatos

4. **Ler arquivo pinnacle existente** (se existir): `cron-data/<data>-fair-pinnacle.json`
   - Se existe, atualizar apenas as entradas que batem com as anchors passadas
   - Campos não presentes no input permanecem intactos (merge, não overwrite total)

5. **Gerar/atualizar arquivo** `cron-data/<data>-fair-pinnacle.json`:
   - Schema canônico (ver abaixo)
   - Para entradas sem `lolesports_match_id`: tentar resolver via `node .claude/scripts/lolesports-find-match.cjs` se disponível
   - `captured_at`: timestamp UTC do momento do registro
   - `applies_to_all_maps: true` — fair única vale pra todos os mapas

6. **Reportar resumo**:
   - Quantas linhas casaram (formato `anchor → team_a vs team_b: XX.X`)
   - Quais ficaram ambíguas (se houver) — com lista de candidatos
   - Quais não foram encontradas
   - Arquivo gerado com path completo

## Schema canônico do arquivo

```json
{
  "date": "YYYY-MM-DD",
  "source": "pinnacle_manual_elvis",
  "captured_at": "ISO timestamp",
  "applies_to_all_maps": true,
  "market": "total_kills",
  "fair_lines": [
    {
      "liga": "LPL",
      "hora_brt": "03:00",
      "team_a": "...",
      "team_b": "...",
      "team_anchor": "WE",
      "fair_line": 27.5,
      "lolesports_match_id": "..."
    }
  ]
}
```

## Regras importantes

- Vírgula decimal aceita: `27,5` → `27.5`
- Anchor case-insensitive: `WE`, `we`, `We` → mesmo match
- Se o arquivo já existe e tem entradas que NÃO foram passadas no input, mantê-las (merge)
- NÃO deletar `cron-data/*-polymarket-lines.json` ou `cron-data/*-fair-pre.json` — são histórico
- Após salvar, confirmar que o arquivo é JSON válido (parse de volta)
