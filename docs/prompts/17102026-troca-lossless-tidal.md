# Retomada: depois da troca lossless e da Tidal no caminho normal (CMR-297, 17/10/2026)

<session_metadata>
branch: feat/crate-soundcloud (commits da leva até a 0.2.94; docs finais no commit seguinte; sem push)
releases: 0.2.94 publicada e instalada na cmr-auto (commit b758fe6)
cmr-auto: ~/quarentena-lossy/ (originais das 23 trocas + 1 .lrc), ~/cmr297-ouvir/ (2 pares em espera),
          ~/slskd_dados/slskd.yml.bak-cmr297-20261017 (yml com o filtro antigo)
vm: ~/tidal-upgrade/ (antigas/ = cópia extra dos 25 originais; staging/ = 2 versões da Tidal em espera),
    ~/tidal-unmark/ (plano, foto e verificação da renomeação)
issues: CMR-297, CMR-298 (dívida do S24 com id antigo)
</session_metadata>

## Contexto rápido

1. 23 faixas lossy por dentro foram trocadas pela versão limpa da Tidal no mesmo caminho (id igual,
   like/vibe/plays intactos, original em quarentena). 2 esperam o ouvido do CEO.
2. Decisão do CEO: faixa da Tidal é faixa normal. A 0.2.94 trouxe `lib_unmark_tidal`; as 351 faixas
   em pasta `[tidal]` foram renomeadas com o id migrado (auditoria externa 351/351), o filtro saiu do
   slskd e o baixador não cria mais a marca.
Leia: `docs/contexto/17102026-troca-lossless-tidal.md` e o CLAUDE.md (seções "Aquisicao Tidal",
"Qualidade real do acervo" e "Mover para playlist").

## Pendências

1. **S24**: manifest de 11/09, o celular não vê as 351 renomeadas nem as movidas de 13-14/10. Com o
   celular no USB da cmr-auto: encode do acervo (`phone_sync_encode.py`), `export_manifest.py --deploy`
   (túnel 16333), `~/phone_push_retry.sh`, `lib_rescan`. Até lá, plays/likes dele nessas faixas ficam no
   id antigo (custo aceito).
2. **2 trocas em espera**: "Help Me" (Sonny Boy Williamson) e "Zip a di dou da" (Henri Salvador). Se o
   CEO aprovar, o mesmo procedimento da troca (tags/capa antigas, quarentena com sha256, renomear por
   cima, conferir). O cartão "Troca por áudio melhor sem quebrar a identidade" propõe virar comando.
3. Vetor de letra de "Manhattan" volta no próximo boot do app (texto restaurado em `lyrics_text`).
4. Erro não tratado do vitest (iconify renderiza depois do teardown do jsdom): existia antes desta leva,
   1061/1061 testes passam.

## Restrições

- Nada sai do acervo sem ordem do CEO; nunca mover/apagar faixa à mão (o mover do app faz isso).
- Não apagar `~/quarentena-lossy/` nem `~/tidal-upgrade/antigas/` sem o OK do CEO.
- Segredos (`~/.secrets/*`, `slskd.yml`) nunca em log nem em chat.
