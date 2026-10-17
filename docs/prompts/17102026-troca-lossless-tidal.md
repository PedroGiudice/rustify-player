# Retomada: troca por versão lossless da Tidal (CMR-297) e faixas da Tidal no caminho normal

<session_metadata>
branch: feat/crate-soundcloud (nada commitado desta leva; arquivos listados abaixo)
releases: nenhuma nesta leva; cmr-auto na 0.2.93
cmr-auto: ~/quarentena-lossy/ (25 originais: 24 trocados + nada mais), ~/cmr297-ouvir/ (2 pares em espera)
vm: ~/tidal-upgrade/ (antigas/ = cópia extra dos 25 originais; staging/ = as 2 versões da Tidal em espera)
issues: CMR-297, CMR-298 (dívida do S24 com id antigo)
</session_metadata>

## Contexto rápido

Das 167 faixas marcadas lossy por dentro, 25 tinham na Tidal a mesma gravação sem corte. Em 17/10 o CEO
escolheu trocar no MESMO caminho (opção (a)), aceitando que o arquivo da Tidal entre no share do Soulseek.
23 foram trocadas e conferidas (id, tags, like, vibe, plays intactos; classe `sem_corte`; MERT refeito).
Leia: `docs/contexto/17102026-troca-lossless-tidal.md` (seção "Decisão e execução") e o CLAUDE.md
(seções "Aquisicao Tidal" e "Qualidade real do acervo").

## Pendências

1. **2 trocas esperando o ouvido do CEO**: "Help Me" (Sonny Boy Williamson, Tidal mono) e "Zip a di dou da"
   (Henri Salvador, remaster 2021 estéreo). Se ele aprovar, mesmo procedimento: montar com tags/capa
   antigas (`build.py` da sessão, reproduzido no relatório), quarentena com sha256, renomear por cima,
   conferir no índice.
2. **Alcance de "todas do tidal no caminho normal"** (CEO, 17/10). Recomendação do CTO levada a ele:
   tirar o filtro `\[tidal\]` do slskd e parar de criar a marca nos downloads novos; NÃO renomear as 309
   pastas antigas (a marca não aparece na tela; renomear muda o id de 351 faixas e cria a dívida do S24).
   Se ele confirmar: `slskd.yml` (só a linha do filtro; o arquivo tem credenciais, nunca imprimir),
   reescanear o share; `tidal_mix_dl.py` sem a marca e com dedup que não dependa dela (`remote_rels`
   procura `*[tidal]*`); Crate ("faixa `[tidal]` nunca entra na fila do Soulseek"); CLAUDE.md.
3. Vetor de letra das 15 faixas trocadas volta no próximo boot do app: conferir depois.
4. Commitar o código desta leva (`upgrade_tidal.py`, `test_upgrade_tidal.py`, `tidal_mix_dl.py
   --no-dedup`, docs) quando o CEO pedir.

## Restrições

- Nada sai do acervo sem ordem do CEO; nunca mover/apagar faixa à mão.
- Não apagar `~/quarentena-lossy/` nem `~/tidal-upgrade/antigas/` sem o OK do CEO depois de ouvir.
- Segredos (`~/.secrets/*`, `slskd.yml`) nunca em log nem em chat.
