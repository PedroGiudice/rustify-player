# rustify-embed

CPU-only MERT-v1-95M audio embedding service for the rustify-player
library indexer. Runs on the VM (extractlab) and is called by the
client via Tailscale; never exposed publicly.

## Wire protocol

```
POST /embed
  Content-Type: application/octet-stream
  Content-Encoding: zstd
  X-Sample-Rate: 24000
  <body: zstd-compressed LE f32 samples, mono, 24 kHz, ≤ 30 s>

→ 200 { "vector": [768 floats], "model": "mert-v1-95m" }

GET /health
→ 200 { "model": "mert-v1-95m", "status": "ok" }
```

Client implementation: `src-tauri/crates/library-indexer/src/embed_client.rs`.

## Build + deploy on extractlab (VM)

```bash
# On the VM
cd /home/opc/rustify-player/services/rustify-embed

# Build (first build downloads MERT weights ≈ 400 MB, takes a few minutes)
docker build -t rustify-embed:latest .

# Install systemd user unit
mkdir -p ~/.config/systemd/user
cp rustify-embed.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now rustify-embed

# Verify
curl -fsS http://127.0.0.1:8448/health
# → {"model":"mert-v1-95m","status":"ok"}

# Logs
journalctl --user -u rustify-embed -f
```

## Expose on Tailnet

The container binds `127.0.0.1:8448` inside the VM (firewall defense in
depth). Tailscale Serve routes a tailnet URL to that port:

```bash
sudo tailscale serve --https=8448 --bg 127.0.0.1:8448
```

Client uses `https://extractlab.cormorant-alpha.ts.net:8448` as the
base URL. Do **not** use Funnel — the service has no authentication.

## Memory and CPU footprint

- Container limits: 14 CPU, 8 GB RAM (leaves breathing room for other
  services on the VM).
- Resident memory after model load: ~1.5 GB (PyTorch + MERT-95M).
- Per-request: single inference takes ~1-3 s on 30 s of audio, CPU-bound.
- Throughput is single-threaded per request — MERT doesn't benefit from
  batching at this scale. If the first-scan queue becomes a bottleneck
  (unlikely at 800 tracks), run multiple containers on different ports
  and round-robin on the client side.

## Offline fallback

Client-side: if the service is unreachable, the indexer marks the track
`embedding_status = 'pending'` and moves on. Next startup retries. The
player remains fully usable without embeddings — only the "similar
tracks" feature degrades gracefully to tag-based matching (not yet
implemented; future v1.1).
