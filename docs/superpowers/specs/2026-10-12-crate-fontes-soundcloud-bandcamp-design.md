# Crate: fontes SoundCloud e Bandcamp (design)

Data: 2026-10-12. Estado: aprovado pelo CEO em conversa (seções 1 a 3 revisadas uma a
uma; 4 a 7 escritas direto por ordem dele). Spec anterior do Crate, que continua
valendo para o Soulseek: `2026-08-07-crate-in-app-downloads-design.md`.

## 1. Problema e recorte

Funk brasileiro quase não existe no Soulseek, e o pouco que há chega sujo. O
piloto de 12/10 (`docs/contexto/12102026-piloto-funk-br.md`) provou que a fonte
legítima é o arquivo original do produtor no SoundCloud e o lossless do Bandcamp,
mas o fluxo rodou em scripts fora do app. Esta spec leva o pipeline para dentro do
Crate: uma busca de faixa devolve Soulseek e SoundCloud lado a lado, um link do
Bandcamp vira release no acervo, e tudo entra pelo mesmo funil de validação,
dedup, pasta canônica, ingest, MERT e letra que o Soulseek já usa.

Decisões de produto fechadas com o CEO:

- Busca por texto cobre Soulseek e SoundCloud; Bandcamp entra por link colado,
  porque a busca do bandcamp.com bloqueia qualquer cliente que não seja navegador.
- Release pago no Bandcamp: o app abre a página para a compra e espera o item
  aparecer na coleção; quando aparece, baixa, normaliza e indexa sozinho.
- SoundCloud: MP3 320 original entra convertido para FLAC com a tag de origem
  marcando lossy; abaixo de 320 não baixa. WAV, AIFF e FLAC entram sem perda.
- Antes de gravar, um card pré-preenchido com Artista, Título, Ano e Playlist, que
  o CEO confirma ou corrige. Vale para as duas fontes novas.
- Só rotas gratuitas: Soulseek, SoundCloud com download nativo, Bandcamp NYP,
  free e comprado. Gates externos (Hypeddit, ToneDen), YouTube e extração de
  streaming ficam fora.

Abordagem escolhida (C, híbrida): SoundCloud nativo em Rust; Bandcamp por um
helper Python nosso com contrato JSON, porque passar no desafio TLS do Fastly é a
única coisa que Rust não resolve barato; conversão pelo `ffmpeg` da máquina; tags
escritas pelo app com `lofty`.

Entrega em duas fases, releases separados:

- Fase 1: generalização do job por fonte, workers, normalização e tags no app,
  SoundCloud de ponta a ponta na busca.
- Fase 2: Bandcamp por link (NYP e free direto, e-mail quando o artista exigir,
  espera de compra), sobre a infraestrutura da fase 1.

## 2. Modelo de job e threads

### 2.1 Origem no job

`DownloadJob` ganha `source: Source`:

```rust
#[serde(tag = "kind", rename_all = "snake_case")]
enum Source {
    Soulseek { username: String, remote_filename: String, size: u64 },
    SoundCloud { track_id: u64, permalink_url: String },
    Bandcamp { item_type: String, item_id: u64, url: String },
}
```

Campos hoje soltos no job (`username`, `remote_filename`, `size`, `alternates`,
`tried_source_ids`) migram para a variante Soulseek. `job_id` continua um hash
determinístico: `"{kind}\u{1}{identificador}"`, onde o identificador é
`username\u{1}remote_filename`, `track_id` ou `item_type\u{1}item_id`. O mesmo
clique nunca cria dois jobs.

Campos novos comuns a todo job: `meta: ConfirmedMeta` (o que o CEO confirmou no
card: artist, title, album, year, playlist, label opcional), `format_in` (o
formato de origem detectado: `flac`, `wav24`, `wav16`, `aiff`, `mp3_320`) e
`tracks: u16` (1 para single; n para release do Bandcamp).

### 2.2 Estados

Os onze estados e as transições de `board.rs` valem para todas as origens.
`Enqueued` passa a significar "aceito pela fonte, aguardando início";
`Processing` cobre localizar, converter, escrever tags e validar. Acréscimos:

- `Waiting { reason: WaitReason, url: String, since_secs: u64 }`, com
  `WaitReason::Purchase | EmailLink`. Só o Bandcamp entra nele. Transições:
  `{queued, enqueued, downloading} -> waiting` (compra: logo após a sondagem;
  e-mail: depois do POST que o helper faz), `waiting -> {enqueued, canceled,
  failed}`. Não é terminal e não conta como in-flight para o teto de
  transferências.
- `RejectReason::LowBitrate { kbps: u32 }` e `RejectReason::NoDownload`.
- `Ready { track_id }` continua; para release com n faixas o `track_id` é o da
  primeira e `tracks` diz quantas entraram.

### 2.3 Persistência e boot

`slsk_jobs.json` persiste `source`, `meta`, `tracks` e o estado. No boot:

- Soulseek: cruzado com `/transfers/downloads` como hoje.
- SoundCloud e Bandcamp em `Enqueued`, `Downloading`, `Stalled` ou `Processing`
  voltam para `Queued` e recomeçam; o download HTTP recomeça do zero e o
  incoming órfão é limpo como hoje. `Waiting` é restaurado como está.

### 2.4 Workers

A thread `slsk-coord` continua escritora única do board e dona do funil final.
Cada origem nova ganha um worker próprio, no padrão do `slsk-lyrics`:

```
coord --(bounded 16, try_send)--> sc-worker  : Fetch{job_id, source, meta, dest_tmp}
sc-worker --(unbounded)--> coord            : Progress{job_id, pct, bps, eta} | Done{job_id, flac_path, format_in} | Failed{job_id, reason, retryable} | Rejected{job_id, reason}
```

O loop do coordinator drena o canal de retorno a cada tick (antes do
`emit_if_dirty`) e aplica no board. Download, sondagem de formato, conversão,
escrita de tags e capa acontecem no worker. No `Done`, o coordinator chama
`stage_and_ingest` com o caminho do FLAC pronto, exatamente como faz com o
arquivo localizado do slskd. O `Processing` é marcado pelo coordinator quando
recebe o `Done` e permanece até o ingest.

Tetos e pacing por origem: `MAX_ACTIVE` passa a ser consultado por `Source`
(Soulseek 3, SoundCloud 2, Bandcamp 1). O `Pacer` do Soulseek fica como está;
o SoundCloud tem um `Pacer` próprio (mínimo 1 s entre chamadas, 120 buscas/h,
sem "frio"); o Bandcamp, 1 sondagem a cada 5 s. `fail_network_dependent_jobs`
(slskd fora do ar) passa a atingir só jobs Soulseek.

### 2.5 O que não muda

`stage_file` (parse_flac, 32 bit, decode_probe, dedup colaborativa, quarentena),
`canonical_dest`, `place_at_destination`, `try_ingest` com `IngestPaths` e
retry, `send_lyrics_job`, `emit_if_dirty`, o evento `slsk-jobs`. O ingest
continua um path por chamada; release do Bandcamp manda n chamadas.

## 3. SoundCloud

### 3.1 Cliente (`crates/soundcloud-client`, puro, `ureq` + `rustls`)

- `client_id`: extraído dos bundles JS de `soundcloud.com` (regex
  `client_id:"..."` nos `<script src>` da home), cache em
  `<data_dir>/soundcloud_client_id.json` com timestamp; em 401/403 na API o
  cache é descartado e a extração roda de novo uma vez.
- `search(query, limit=10)`: `GET /search/tracks?q=&limit=&client_id=`. Para
  cada item: `id`, `title`, `permalink_url`, `user.username`, `user.permalink`,
  `duration`, `playback_count`, `created_at`, `release_date`, `genre`,
  `artwork_url`, `downloadable`, `has_downloads_left`, `purchase_url`.
- `resolve(url)`: `GET /resolve?url=` para link colado do SoundCloud.
- `availability(item) -> Native | QuotaExhausted | ExternalGate(url) | None`.
- `probe_original(track_id, token)`: `GET /tracks/{id}/download?client_id=` com
  `Authorization: OAuth <token>` devolve `redirectUri`; um `HEAD` nele dá
  tamanho e `Content-Type`; a extensão vem da URL. `bitrate_estimate_kbps =
  size*8/duration_ms`. Devolve `Original{url, ext, size, kbps_est}`; 401 vira
  `NoToken`.
- `download(url, dest, progress_cb)`: streaming com `Content-Length`, progresso
  a cada 256 KiB.
- Fixtures: JSON real capturado da API (busca, track com download, track com
  gate, track sem download) e o HTML do `client_id`, com testes de parsing.

### 3.2 Política de formato

| Extensão do original | Decisão |
|---|---|
| `.wav`, `.aiff`, `.aif`, `.flac` | entra; `format_in` = `wav24`/`wav16`/`aiff`/`flac` após sondar o cabeçalho |
| `.mp3` com estimativa >= 300 kbps | entra como `mp3_320`; bitrate real conferido no cabeçalho após baixar; < 300 real rejeita `LowBitrate` |
| `.mp3` com estimativa < 300 kbps | card mostra "MP3 <kbps>, não entra", Baixar desabilitado |
| `.m4a`, `.ogg`, `.opus`, outros | não entra (`NoDownload` com motivo "formato") |

O limiar 300 absorve a variação de VBR e cabeçalho; 320 CBR estima 318 a 322.

### 3.3 Sugestão de metadado (frontend, puro, testado)

`src/lib/trackMetaGuess.ts`: `guessFromSoundCloud(item) -> {artist, title,
year, album}`:

1. Título bruto sem sufixos `(FREE DOWNLOAD)`, `[FREE DL]`, `.wav`, `.mp3`,
   `WAV`, `MP3` no fim, e espaços duplicados.
2. Se o título tem ` - ` e a cauda, comparada frouxamente (caixa, pontuação,
   `&` igual a ` e `), bate com `user.username` ou com o começo dele, a cauda
   vira artista e a cabeça vira título. Senão, se a cabeça bate, inverte.
   Senão, artista = `user.username`.
3. Caixa alta integral vira Title Case, preservando siglas conhecidas (`DJ`,
   `MC`, `MCs`, `BPM`, `SP`, `RJ`, `BH`) e tokens com dígitos.
4. `year` = ano de `release_date` ou `created_at`.
5. `album` = título (single).
6. Playlist: `suggested_dest` do backend pela pasta do artista no acervo; senão
   a última usada (`kv-crate-dest`); senão seletor obrigatório, como hoje.

Artista que parece URL (`www.`, `.com`, `http`) nunca é sugerido; cai no nome
do perfil ou fica vazio para o CEO preencher.

## 4. Normalização e tags no app

### 4.1 Conversão

`crates/library-indexer/src/transcode.rs`: `to_flac(src, dst) -> Result` chama
`ffmpeg -nostdin -loglevel error -y -i src -vn -map_metadata -1 -c:a flac
-compression_level 8 dst`. Antes de rodar, `ffmpeg_available()` (`ffmpeg
-version`) é checado no boot e exposto no status; a ausência faz o worker
falhar o job com `retryable: false` e mensagem "ffmpeg ausente". FLAC de origem
não passa pelo ffmpeg. Saída validada por `parse_flac` e duração dentro de 2%
da origem (o piloto do S24 ensinou que o ffmpeg pode sair com 0 e escrever
lixo).

### 4.2 Tags e capa

`crates/library-indexer/src/tagwrite.rs` com `lofty`: `write_tags(path,
&ConfirmedMeta, track_no, track_total, source_note: Option<&str>, cover:
Option<&[u8]>)`. Apaga todos os Vorbis Comments e PICTUREs existentes e grava:
ARTIST, ALBUMARTIST, ALBUM, TITLE, DATE, TRACKNUMBER, TRACKTOTAL, GENRE (=
playlist), LABEL e ORGANIZATION quando houver, COMMENT `source: lossy mp3`
quando `format_in` for lossy. Para release do Bandcamp com artista por faixa,
ARTIST recebe o crédito da faixa e ALBUMARTIST o do release.

Capa: o worker baixa a arte (SoundCloud: `artwork_url` trocado para `t500x500`;
Bandcamp: `art_url` da sondagem), redimensiona a no máximo 1500 px no lado maior
com o crate `image`, JPEG qualidade 90, embute como PICTURE tipo 3 e grava
`cover.jpg` na pasta final do release (depois do `place_at_destination`, pelo
coordinator, porque só ele sabe a pasta final).

### 4.3 Ordem no worker

Baixar para `.rustify-incoming/<job_id>.a<tentativa>.<ext>` → sondar bitrate
real (MP3) → converter para `.rustify-incoming/<job_id>.a<tentativa>.flac` (ou
renomear, se FLAC) → escrever tags e capa → `Done{flac_path}`. A tentativa
(`DownloadJob::attempt`) muda a cada criação do job e volta em todo evento do
worker: cancelar e baixar de novo a mesma faixa não deixa a tarefa antiga
mexer na nova, nem no arquivo dela. O coordinator então faz o
`stage_and_ingest` de hoje. Como as tags já estão certas, a pasta canônica sai
certa e o dedup compara o que o CEO confirmou.

### 4.4 Nomes

`canonical_dest` continua dono do layout `<Playlist>/<Artista>/<AAAA -
Álbum>/<NN - Título>.flac`. `sanitize_component` passa a trocar também `: " * ?
< > |` por `_`, porque o acervo vai para o S24 e o storage do Android recusa
esses caracteres (lição do `phone_sync_encode.py`). Isso vale para o Soulseek
também; é correção, não regressão.

## 5. Tela

### 5.1 Busca e resultados

- Placeholder: "Buscar no Soulseek e SoundCloud, ou colar link do Bandcamp".
- Enter dispara `slsk_search` (como hoje) e `crate_sc_search` em paralelo. Link
  do SoundCloud colado vai para `crate_sc_resolve`; link do Bandcamp, para a
  sondagem da fase 2.
- A lista tem duas seções: "SoundCloud" em cima (chega em ~1 s, até 10 itens) e
  "Soulseek" embaixo (vai preenchendo ao longo dos 25 s, como hoje). Cada linha
  leva um badge da fonte à esquerda do formato.
- Linha do SoundCloud: título, perfil, duração, plays (`tabular-nums`), ano, e o
  chip de disponibilidade: "Original" (verde do tema, botão Baixar ativo),
  "Cota esgotada", "Download externo" e "Sem download" (linha apagada, sem
  Baixar, com "Abrir" que leva ao Chrome). O formato real só aparece no card,
  porque exige o token.
- Estados da seção: "buscando…", "nada no SoundCloud", "SoundCloud indisponível
  (motivo)". A seção Soulseek mantém os banners de rede fria e cooldown.

### 5.2 Card de confirmação

Abre ao clicar Baixar numa linha do SoundCloud (e, na fase 2, ao sondar um link
do Bandcamp). Expande na própria linha, sem modal:

- Capa pequena (data URL vinda do Rust, para a CSP continuar sem hosts externos).
- Campos editáveis: Artista, Título, Ano, Playlist (o `DestChip` de hoje); no
  Bandcamp, Álbum e Selo também, e a lista de faixas somente leitura.
- Linha de formato, preenchida pela sondagem com o token assim que o card abre:
  "WAV 24 bit · 50 MB", "MP3 320 · 7 MB", "MP3 128 · não entra" (Baixar
  desabilitado), "sem token do SoundCloud" (Baixar desabilitado, link para a
  seção de status).
- Aviso "Já no acervo: <artista> - <título>" quando o `slsk_dedup_probe` com os
  campos confirmados encontra a faixa; o Baixar continua possível, como hoje.
- Botões: Baixar (Enter) e Cancelar (Esc). Baixar manda `crate_download` com a
  origem, o `ConfirmedMeta` e a playlist.

### 5.3 Fila

`CrateJobRow` mostra o badge da fonte e o subtítulo passa a ser o perfil ou o
peer. `StateLine` ganha `Waiting`: "Aguardando compra no Bandcamp" com botão
"Abrir" e "Verificar agora"; "Link enviado para o seu e-mail" com um campo para
colar o link e botão "Continuar". Rejeições novas: "MP3 <kbps>: abaixo de 320",
"sem download nativo".

### 5.4 Status das fontes

Ao lado do indicador de rede do Soulseek, dois pontos: "SoundCloud: token ok /
sem token / API indisponível" e "ffmpeg: ok / ausente" (fase 2 acrescenta
"Bandcamp: identidade ok / sem identidade / uv ausente"). Vem de
`crate_sources_status`, consultado a cada 30 s e ao abrir a aba.

### 5.5 Regras visuais

Tokens do tema e do `:root`, nada solto; Instrument Sans 400 a 700; números
que mudam com `tabular-nums`; um acento por tela (o Baixar ativo); estados
vazio, carregando e erro desenhados; sem modal. Classes novas `.crate-src`,
`.crate-card`, `.crate-fmt` no `extractor-lab.css`.

## 6. Bandcamp (fase 2)

### 6.1 Helper

`src-tauri/helpers/bandcamp_helper.py`, empacotado como resource do bundle e
executado com `uv run --with curl_cffi --with free-bandcamp-downloader
<helper> <comando>` (o `uv` da cmr-auto; caminho configurável). Contrato em
JSON por linha no stdout; stderr só para log; nunca imprime cookie ou token.

| Comando | Entrada | Saída |
|---|---|---|
| `probe <url>` | URL de álbum ou faixa | `{item_type, item_id, artist, title, year, label, tracks:[{n,title,artist?,duration}], availability: free\|nyp\|paid\|email, price, currency, art_url}` |
| `download <url> --dest <dir> [--identity-file f] [--email e]` | item NYP/free/comprado | linhas `{pct}` e ao fim `{ok, files:[...]}`; item com e-mail obrigatório devolve `{email_sent: true}` após o POST |
| `download-link <link> --dest <dir>` | link do e-mail | idem |
| `collection <url> --identity-file f` | item pago | `{owned: bool, download_url?}` |

Usa `curl_cffi` impersonando Firefox para a sondagem (é o que passa no desafio
do Fastly; Chrome não passa) e a lib do `bcdl-free` para os downloads. Testes do
helper em Python com fixtures de `data-tralbum` reais.

### 6.2 Fluxo

1. Link colado → `crate_bc_probe` → worker Bandcamp roda `probe` → card com
   artista, álbum, ano, selo, faixas e a disponibilidade.
2. NYP ou free sem e-mail: `download` → zip → extrair → para cada FLAC,
   `write_tags` com o card (artista por faixa quando o Bandcamp credita) e capa
   → `Done` por faixa → `stage_and_ingest` por faixa. Um job por release;
   progresso agregado.
3. Free com e-mail obrigatório: o helper faz o POST com o e-mail configurado
   (decisão do CEO: o Gmail dele, nunca descartável) e o job vai para
   `Waiting{EmailLink}`; o CEO cola o link do e-mail no card da fila →
   `crate_resume(job_id, link)` → `download-link`.
4. Pago: card mostra o preço e "Comprar no Bandcamp" abre o Chrome (capability
   `opener:allow-open-url` restrita a `https://*.bandcamp.com/*`); o job vai
   para `Waiting{Purchase}`; o worker roda `collection` a cada 5 min e no
   "Verificar agora", por até 24 h; quando `owned`, segue como o item NYP, com
   `--identity-file`.
5. Release já no acervo por artista e álbum: o card avisa e o Baixar segue
   possível, com dedup por faixa no `stage_file`.

## 7. Configuração, segredos e status

`<data_dir>/sources.json` (criado com defaults na primeira execução):

```json
{
  "soundcloud": { "oauth_token_file": "~/.secrets/soundcloud-oauth.txt" },
  "bandcamp":   { "identity_file": "~/.secrets/bandcamp-identity.txt", "email": "" },
  "tools":      { "ffmpeg": "ffmpeg", "uv": "~/.local/bin/uv" }
}
```

Variáveis de ambiente sobrepõem (`RUSTIFY_SC_TOKEN_FILE`,
`RUSTIFY_BC_IDENTITY_FILE`, `RUSTIFY_BC_EMAIL`, `RUSTIFY_FFMPEG`, `RUSTIFY_UV`).
Os arquivos de segredo são lidos no momento do uso, não no boot: trocar o
token não exige reiniciar. O app avisa se a permissão do arquivo for mais
aberta que 0600. Nenhum valor entra em log; `Debug` dos structs redige.

`crate_sources_status -> {soundcloud: TokenOk|NoToken|ApiDown, ffmpeg: bool,
uv: bool, bandcamp: IdentityOk|NoIdentity}`. A checagem do token é um `GET
/me` com cache de 10 min.

A CSP não muda: todo tráfego externo sai do Rust ou do helper. A capa do card
chega como data URL.

## 8. Testes e critérios de aceite

Rust:

- `board.rs`: `job_id` por origem, transições com `Waiting`, motivos novos.
- `soundcloud-client`: parsing de fixtures reais, `availability`, estimativa de
  bitrate, extração de `client_id`.
- `transcode.rs` e `tagwrite.rs`: WAV e MP3 sintéticos de 2 s gerados no teste
  com ffmpeg (teste pulado com aviso se não houver ffmpeg), tags lidas de volta
  com `parse_flac`, capa presente, duração preservada.
- `coordinator.rs`: roteamento por origem com worker falso; `Done` leva a
  `stage_and_ingest`; `Rejected` leva a quarentena; comandos com resposta
  continuam respondendo em menos de 2 s durante um download simulado.
- `trackMetaGuess.test.ts`: os casos do piloto ("FESTA DO PENTE RALA - DJ
  ARANA", "MC GW e DJ Piu - Bumbum na Nuca", "user-577945535", sufixos).
- `Crate.test.tsx`: seções, chip de disponibilidade, card, estados.

Aceite no app real (cmr-auto, pela ponte MCP):

- Busca "mandelão": seção SoundCloud em menos de 2 s, seção Soulseek
  preenchendo; nenhum comando do Crate acima de 2 s durante um download.
- Download de um WAV de ~50 MB: card mostra formato e tamanho; job passa por
  Downloading com progresso, Processing, Indexing e Ready; faixa toca; Qdrant
  tem `embedding_status: done` e capa; arquivo na pasta canônica com as tags
  confirmadas.
- MP3 128 aparece com "não entra" e não baixa.
- Sem token: status mostra "sem token" e o card explica.
- Fase 2: link NYP vira release completo no acervo; link pago abre o Chrome e,
  depois da compra, entra sozinho em até 5 min.

Documentação: `docs/soulseek/manual-qa.md` ganha os casos novos; o CLAUDE.md
troca a seção "Aquisicao Bandcamp + SoundCloud" pelo fluxo in-app, mantendo os
scripts como caminho de leva grande.

## 9. Fora de escopo

Busca por texto no Bandcamp; gates Hypeddit e ToneDen; YouTube; streaming;
anotação automática de vibe (CMR-178); Crate no S24; edição de tags de faixas já
no acervo.
