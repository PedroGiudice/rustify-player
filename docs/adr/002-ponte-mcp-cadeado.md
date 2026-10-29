# ADR 002: cadeado da ponte MCP (cópia local do plugin)

Data: 29/10/2026. Estado: aceita (decisão de produto do CEO).

## Contexto

A ponte MCP (`tauri-plugin-mcp-bridge`, WebSocket em `127.0.0.1:9223`)
executa JS/IPC arbitrário no app e aceita qualquer cliente que chegue por
túnel SSH, sem autorização e sem sinal na tela. Em 29/10/2026 (00:06 a
00:17, hora da cmr-auto) uma sessão de medição de fps trocou de tela, abriu o
Tweaks e mudou a cena do fundo enquanto o CEO usava o app. O plugin é um
crate externo cujo despacho de comandos e contagem de conexões são funções
privadas: não há como interceptar por fora.

## Decisão

1. O app só obedece à ponte quando o CEO liga **Tweaks > Controle remoto >
   Ponte MCP** (padrão desligado, persistido no `kv-tweaks`, reaplicado ao
   backend no boot). Desligada, a conexão é aceita e só saúde/versão responde,
   sem dados da tela; todo o resto volta `ponte desligada no app; ligue em
   Tweaks > Controle remoto`.
2. Com a ponte ligada e cliente conectado, a sidebar mostra a pílula âmbar
   "Ponte conectada" (abre o Tweaks). Sinal, não decoração.
3. Para isso o plugin foi vendorizado em `src-tauri/crates/mcp-bridge` (fork
   de 0.11.1, MIT, mesmo nome de pacote) com o gate em `gate.rs`, checado no
   despacho. Fechado por padrão: sem gate no estado, recusa.
4. O bind continua só em `127.0.0.1`; o cadeado é camada a mais, não troca.

## Consequências

- Toda sessão que use a ponte (`app_eval.sh`, `driver_session`) depende de o
  CEO ligar o interruptor naquela rodada; a autorização vira gesto dele.
- Atualizar o plugin = recopiar o upstream e reaplicar o gate (README do crate).
- O contador de clientes é por conexão viva; desligar não derruba conexões
  abertas, só as deixa recusadas comando a comando.
