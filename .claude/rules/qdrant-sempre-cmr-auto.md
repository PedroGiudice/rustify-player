## RULE ##

O Qdrant da VM tem a rustify_tracks mas quase vazia (1 ponto de teste). A collection real (~1300+ tracks) está na cmr-auto (onde o app roda).

Desde o hardening 2026-07-17 o Qdrant da cmr-auto escuta SÓ em 127.0.0.1.
Acesso da VM exige túnel SSH (idempotente — se a 16333 já responde, está de pé):

```bash
ssh -f -N -o ExitOnForwardFailure=yes -L 16333:localhost:6333 cmr-auto@100.102.249.9
curl -s http://127.0.0.1:16333/collections/rustify_tracks
```

O mesmo vale pro MCP bridge (:9223, também loopback-only):

```bash
ssh -f -N -o ExitOnForwardFailure=yes -L 9223:localhost:9223 cmr-auto@100.102.249.9
# driver_session: host=127.0.0.1 port=9223
```
