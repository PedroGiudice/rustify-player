"""
rustify-embed — MERT audio embedding service.

Runs MERT-v1-95M via transformers on CPU. The player (Rust crate
library-indexer) sends zstd-compressed 24 kHz mono f32 waveforms over
Tailscale and gets back a 768-dim L2-normalized vector.

Why MERT-95M on CPU:
- library-indexer runs on the user's i5 8th gen laptop, which is too
  weak to churn through audio embedding for an ~800-track library in
  reasonable time. VM Contabo has 16 vCPU AMD EPYC — ~1-3 s per track
  is fast enough, and the service stays always-on with no cold start.
- CPU is sufficient because embedding is one-shot per track: first scan
  of 800 tracks ≈ 20-40 min, then incremental (one track at a time)
  lands in under a second including network.

Wire format (see library-indexer/src/embed_client.rs for the client):
- POST /embed
  - Content-Type: application/octet-stream
  - Content-Encoding: zstd
  - X-Sample-Rate: 24000
  - body: zstd-compressed LE f32 samples (mono, 24 kHz, up to 30 s)
- Response 200: { "vector": [768 floats], "model": "mert-v1-95m" }
- GET  /health → { "model": "mert-v1-95m", "status": "ok" }
"""

from __future__ import annotations

import logging
import os
import struct
import time

import numpy as np
import torch
import zstandard as zstd
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel
from transformers import AutoModel, Wav2Vec2FeatureExtractor

MODEL_ID = os.environ.get("RUSTIFY_EMBED_MODEL", "m-a-p/MERT-v1-95M")
TARGET_SR = 24_000
MAX_SAMPLES = TARGET_SR * 30  # 30 s cap — matches client preprocessing

logger = logging.getLogger("rustify-embed")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# ---------------------------------------------------------------------------
# Model load (once at process start)
# ---------------------------------------------------------------------------

logger.info("loading model: %s", MODEL_ID)
_t0 = time.time()
_processor = Wav2Vec2FeatureExtractor.from_pretrained(MODEL_ID, trust_remote_code=True)
_model = AutoModel.from_pretrained(MODEL_ID, trust_remote_code=True)
_model.eval()
logger.info("model ready in %.1fs", time.time() - _t0)

_decompressor = zstd.ZstdDecompressor()


class EmbedResponse(BaseModel):
    vector: list[float]
    model: str


class HealthResponse(BaseModel):
    model: str
    status: str


app = FastAPI(title="rustify-embed", version="0.1.0")


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(model=_short_model_id(), status="ok")


@app.post("/embed", response_model=EmbedResponse)
async def embed(request: Request) -> EmbedResponse:
    # Use X-Audio-Encoding instead of Content-Encoding to avoid reverse
    # proxies (Tailscale Serve, nginx) stripping or altering the header.
    content_encoding = request.headers.get(
        "X-Audio-Encoding",
        request.headers.get("Content-Encoding", ""),
    ).lower()
    try:
        sample_rate = int(request.headers.get("X-Sample-Rate", str(TARGET_SR)))
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid X-Sample-Rate")
    if sample_rate != TARGET_SR:
        # Resampling is the client's job; we reject mismatched rates
        # rather than silently embed garbage.
        raise HTTPException(
            status_code=400,
            detail=f"expected sample_rate={TARGET_SR}, got {sample_rate}",
        )

    raw = await request.body()
    if content_encoding == "zstd":
        try:
            raw = _decompressor.decompress(raw, max_output_size=MAX_SAMPLES * 4 + 4096)
        except zstd.ZstdError as e:
            raise HTTPException(status_code=400, detail=f"zstd decompress: {e}")
    elif content_encoding not in ("", "identity"):
        raise HTTPException(
            status_code=415,
            detail=f"unsupported Content-Encoding: {content_encoding}",
        )

    if len(raw) % 4 != 0:
        raise HTTPException(status_code=400, detail="audio body is not aligned to f32")
    n_samples = len(raw) // 4
    if n_samples == 0:
        raise HTTPException(status_code=400, detail="empty audio body")
    if n_samples > MAX_SAMPLES:
        # Truncate rather than fail — client should already have windowed.
        logger.warning(
            "payload is %d samples > %d MAX_SAMPLES; truncating", n_samples, MAX_SAMPLES
        )
        raw = raw[: MAX_SAMPLES * 4]
        n_samples = MAX_SAMPLES

    audio = np.frombuffer(raw, dtype="<f4").astype(np.float32)
    vector = _embed(audio)
    return EmbedResponse(vector=vector.tolist(), model=_short_model_id())


def _embed(audio: np.ndarray) -> np.ndarray:
    """Run MERT on a 24 kHz mono f32 waveform, return 768-d L2-normalized vec."""
    t0 = time.time()
    inputs = _processor(audio, sampling_rate=TARGET_SR, return_tensors="pt")
    with torch.no_grad():
        outputs = _model(**inputs, output_hidden_states=False)
    # Last hidden state: [1, seq_len, hidden_dim]. Mean-pool over seq_len.
    hidden = outputs.last_hidden_state.squeeze(0)  # [seq_len, hidden_dim]
    vector = hidden.mean(dim=0).cpu().numpy().astype(np.float32)
    # L2-normalize so client-side cosine sim == dot product.
    norm = float(np.linalg.norm(vector))
    if norm > 0:
        vector = vector / norm
    logger.info(
        "embed: %d samples → dim=%d in %.2fs", audio.shape[0], vector.shape[0], time.time() - t0
    )
    return vector


def _short_model_id() -> str:
    # "m-a-p/MERT-v1-95M" → "mert-v1-95m"
    return MODEL_ID.split("/")[-1].lower()


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("RUSTIFY_EMBED_PORT", "8448"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
