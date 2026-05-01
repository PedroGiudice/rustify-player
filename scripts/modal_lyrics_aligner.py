#!/usr/bin/env python3
"""Modal DEPLOYED worker for Lyrics Alignment -- Whisper (vLLM) + Demucs.

Copied from modal_whisper_http.py (ELCO-machina). Same pattern:
    1. @modal.enter(snap=True) -- start vllm serve, warm up, sleep. Snapshot taken after.
    2. @modal.enter(snap=False) -- wake vLLM, ready to serve.

Added: demucs vocal separation + batch lyrics pipeline.

Pipeline:
  - Tracks with plain text: Demucs -> vLLM Whisper (timestamps) -> LRC
  - Tracks without text: Demucs -> vLLM Whisper (transcription + timestamps) -> LRC

Results persisted in volume /lyrics-data/output/<track_id>.lrc
Kill-safe -- rerun skips completed tracks.

Workflow:
    1. Deploy:  modal deploy scripts/modal_lyrics_aligner.py
    2. Test:    python3 scripts/modal_lyrics_aligner.py --audio /path/to/file.flac
    3. Batch:   python3 scripts/modal_lyrics_aligner.py --all-pending /tmp/tracks_new.csv --lyrics-dir /tmp/lyrics/

GPU: H100 (24GB). Whisper large-v3 FP16 ~3GB + Demucs htdemucs ~300MB.
"""

import json
import os
import socket
import subprocess
import tempfile
import time

import modal

APP_NAME = "rustify-lyrics-aligner"
app = modal.App(
    APP_NAME,
    tags={
        "project": "rustify-player",
        "model": "whisper-demucs",
        "engine": "vllm-http",
    },
)

GPU_TYPE = "H100"
MINUTES = 60
VLLM_PORT = 8000
VLLM_MODEL = "openai/whisper-large-v3"
CHUNK_SECONDS = 20
OVERLAP_SECONDS = 1

image = (
    modal.Image.from_registry("nvidia/cuda:12.9.0-devel-ubuntu22.04", add_python="3.12")
    .entrypoint([])
    .apt_install(["ffmpeg", "libsndfile1"])
    .run_commands(
        "pip install uv",
        "uv pip install --system --compile-bytecode "
        "torch torchaudio --index-url https://download.pytorch.org/whl/cu124",
        "uv pip install --system --compile-bytecode "
        "vllm==0.8.5.post1 transformers==4.52.4 'huggingface-hub>=0.28.0' "
        "librosa soundfile requests 'fastapi[standard]' demucs",
    )
    .env(
        {
            "HF_XET_HIGH_PERFORMANCE": "1",
            "VLLM_SERVER_DEV_MODE": "1",
            "TORCHINDUCTOR_COMPILE_THREADS": "1",
            "NCCL_DEBUG": "ERROR",
            "TORCH_NCCL_ENABLE_MONITORING": "0",
            "TORCH_CPP_LOG_LEVEL": "FATAL",
        }
    )
)

vllm_cache_vol = modal.Volume.from_name("vllm-cache", create_if_missing=True)
lyrics_volume = modal.Volume.from_name("rustify-lyrics-data", create_if_missing=True)
LYRICS_VOLUME_PATH = "/lyrics-data"

with image.imports():
    import requests


def _wait_ready(proc: subprocess.Popen, timeout: int = 5 * MINUTES) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            socket.create_connection(("localhost", VLLM_PORT), timeout=1).close()
            return
        except OSError:
            if proc.poll() is not None:
                raise RuntimeError(f"vLLM exited with {proc.returncode}")
            time.sleep(1)
    raise TimeoutError(f"vLLM not ready within {timeout}s")


def _warmup() -> None:
    """Warm-up with short audio via /v1/audio/transcriptions endpoint."""
    import io
    import struct

    sr = 16000
    num_samples = sr
    wav_buf = io.BytesIO()
    data_size = num_samples * 2
    wav_buf.write(b"RIFF")
    wav_buf.write(struct.pack("<I", 36 + data_size))
    wav_buf.write(b"WAVE")
    wav_buf.write(b"fmt ")
    wav_buf.write(struct.pack("<I", 16))
    wav_buf.write(struct.pack("<H", 1))
    wav_buf.write(struct.pack("<H", 1))
    wav_buf.write(struct.pack("<I", sr))
    wav_buf.write(struct.pack("<I", sr * 2))
    wav_buf.write(struct.pack("<H", 2))
    wav_buf.write(struct.pack("<H", 16))
    wav_buf.write(b"data")
    wav_buf.write(struct.pack("<I", data_size))
    wav_buf.write(b"\x00" * data_size)
    wav_bytes = wav_buf.getvalue()

    for _ in range(2):
        resp = requests.post(
            f"http://localhost:{VLLM_PORT}/v1/audio/transcriptions",
            files={"file": ("warmup.wav", wav_bytes, "audio/wav")},
            data={"model": VLLM_MODEL},
            timeout=300,
        )
        resp.raise_for_status()


def _sleep(level: int = 1) -> None:
    requests.post(
        f"http://localhost:{VLLM_PORT}/sleep?level={level}"
    ).raise_for_status()


def _wake_up() -> None:
    requests.post(f"http://localhost:{VLLM_PORT}/wake_up").raise_for_status()


def _chunk_audio_bytes(audio_bytes: bytes) -> tuple[list[bytes], float]:
    """Load audio, chunk if >30s, return (list of WAV bytes, duration)."""
    import io
    import tempfile

    import librosa
    import soundfile as sf

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(audio_bytes)
        tmp_path = f.name

    try:
        audio_array, sr = librosa.load(tmp_path, sr=16000, mono=True)
    finally:
        os.unlink(tmp_path)

    total_samples = len(audio_array)
    audio_duration = total_samples / sr
    chunk_samples = CHUNK_SECONDS * sr
    overlap_samples = OVERLAP_SECONDS * sr
    step = chunk_samples - overlap_samples

    if total_samples <= chunk_samples:
        buf = io.BytesIO()
        sf.write(buf, audio_array, sr, format="WAV", subtype="PCM_16")
        return [buf.getvalue()], audio_duration

    chunks_wav = []
    start = 0
    while start < total_samples:
        end = min(start + chunk_samples, total_samples)
        chunk = audio_array[start:end]

        buf = io.BytesIO()
        sf.write(buf, chunk, sr, format="WAV", subtype="PCM_16")
        chunks_wav.append(buf.getvalue())

        start += step
        if end == total_samples:
            break

    return chunks_wav, audio_duration


def _separate_vocals(
    audio_path: str, demucs_model, device: str, output_dir: str = "/tmp/demucs"
) -> str:
    """Demucs: isolate vocals from audio. Returns path to vocals WAV."""
    import torch
    import torchaudio
    from demucs.apply import apply_model

    wav, sr = torchaudio.load(audio_path)
    if wav.shape[0] == 1:
        wav = wav.repeat(2, 1)

    ref = wav.mean(0)
    wav_norm = (wav - ref.mean()) / ref.std()
    wav_norm = wav_norm.unsqueeze(0).to(device)

    with torch.no_grad():
        sources = apply_model(demucs_model, wav_norm, device=device)

    vocals = sources[0, 3]

    os.makedirs(output_dir, exist_ok=True)
    basename = os.path.splitext(os.path.basename(audio_path))[0]
    vocals_path = f"{output_dir}/{basename}_vocals.wav"
    torchaudio.save(vocals_path, vocals.cpu(), sr)

    del sources, wav_norm
    torch.cuda.empty_cache()

    return vocals_path


@app.cls(
    image=image,
    gpu="L4",
    timeout=10 * MINUTES,
    volumes={LYRICS_VOLUME_PATH: lyrics_volume},
    secrets=[modal.Secret.from_name("huggingface-secret")],
    scaledown_window=120,
)
class DemucsWorker:
    """Standalone demucs vocal separation. No snapshot, no vLLM."""

    @modal.enter()
    def load_model(self):
        import logging

        import torch
        from demucs.pretrained import get_model

        logging.basicConfig(
            level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
        )
        self.logger = logging.getLogger("demucs-worker")
        self.device = "cuda" if torch.cuda.is_available() else "cpu"

        self.logger.info("Loading demucs htdemucs on %s...", self.device)
        self.model = get_model("htdemucs")
        self.model.to(self.device)
        self.model.eval()

        if self.device == "cuda":
            free, total = torch.cuda.mem_get_info()
            self.logger.info(
                "VRAM: %.1fGB used / %.1fGB total", (total - free) / 1e9, total / 1e9
            )

    @modal.method()
    def check_done_batch(self, track_ids: list[str]) -> dict[str, bool]:
        stems_dir = os.path.join(LYRICS_VOLUME_PATH, "stems")
        return {
            tid: os.path.exists(os.path.join(stems_dir, f"{tid}_vocals.wav"))
            for tid in track_ids
        }

    @modal.method()
    def separate(self, track_id: str, volume_path: str) -> dict:
        """Separate vocals from a single track. Saves to volume stems dir."""
        import torch
        import torchaudio
        from demucs.apply import apply_model

        stems_dir = os.path.join(LYRICS_VOLUME_PATH, "stems")
        vocals_path = os.path.join(stems_dir, f"{track_id}_vocals.wav")

        if os.path.exists(vocals_path):
            return {"track_id": track_id, "status": "cached"}

        audio_path = os.path.join(LYRICS_VOLUME_PATH, volume_path)
        if not os.path.exists(audio_path):
            return {
                "track_id": track_id,
                "status": "missing",
                "error": f"Not found: {audio_path}",
            }

        t0 = time.perf_counter()
        os.makedirs(stems_dir, exist_ok=True)

        wav, sr = torchaudio.load(audio_path)
        if wav.shape[0] == 1:
            wav = wav.repeat(2, 1)

        ref = wav.mean(0)
        wav_norm = (wav - ref.mean()) / ref.std()
        wav_norm = wav_norm.unsqueeze(0).to(self.device)

        self.logger.info(
            "Device: %s | model device: %s | tensor device: %s",
            self.device,
            next(self.model.parameters()).device,
            wav_norm.device,
        )

        with torch.no_grad():
            sources = apply_model(self.model, wav_norm, device=self.device)

        self.logger.info("Sources device: %s", sources.device)

        vocals = sources[0, 3]
        torchaudio.save(vocals_path, vocals.cpu(), sr)
        lyrics_volume.commit()

        del sources, wav_norm, vocals
        torch.cuda.empty_cache()

        elapsed = time.perf_counter() - t0
        self.logger.info("Separated %s in %.1fs", track_id, elapsed)
        return {
            "track_id": track_id,
            "status": "separated",
            "elapsed_s": round(elapsed, 1),
        }


@app.cls(
    image=image,
    gpu=GPU_TYPE,
    timeout=10 * MINUTES,
    volumes={
        "/root/.cache/vllm": vllm_cache_vol,
        LYRICS_VOLUME_PATH: lyrics_volume,
    },
    enable_memory_snapshot=True,
    experimental_options={"enable_gpu_snapshot": True},
    secrets=[modal.Secret.from_name("huggingface-secret")],
    scaledown_window=2,
)
@modal.concurrent(max_inputs=32)
class LyricsAligner:
    @modal.enter(snap=True)
    def start(self):
        import logging

        logging.basicConfig(
            level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
        )
        self.logger = logging.getLogger("lyrics-aligner")

        self.logger.info("Starting vLLM serve for %s...", VLLM_MODEL)

        cmd = [
            "vllm",
            "serve",
            VLLM_MODEL,
            "--dtype",
            "auto",
            "--host",
            "0.0.0.0",
            "--port",
            str(VLLM_PORT),
            "--gpu_memory_utilization",
            "0.95",
            "--enable-sleep-mode",
            "--max-model-len",
            "448",
            "--max-num-seqs",
            "32",
            "--uvicorn-log-level",
            "warning",
            "--disable-log-requests",
        ]

        self._vllm_log = open("/tmp/vllm-stderr.log", "w")
        self.vllm_proc = subprocess.Popen(
            cmd,
            stdout=self._vllm_log,
            stderr=subprocess.STDOUT,
        )

        try:
            _wait_ready(self.vllm_proc)
        except (RuntimeError, TimeoutError):
            self._vllm_log.flush()
            with open("/tmp/vllm-stderr.log") as f:
                self.logger.error("vLLM stderr:\n%s", f.read()[-3000:])
            raise
        self.logger.info("vLLM ready on port %d", VLLM_PORT)

        self.logger.info("Running warm-up (2 requests)...")
        _warmup()
        self.logger.info("Warm-up done")

        self.logger.info("Putting vLLM to sleep...")
        _sleep()
        self.logger.info("vLLM sleeping -- snapshot point")

    @modal.enter(snap=False)
    def restore(self):
        """Wake vLLM from sleep mode after restoring from a memory snapshot."""
        _wake_up()

    @modal.exit()
    def stop(self):
        if hasattr(self, "vllm_proc") and self.vllm_proc.poll() is None:
            self.vllm_proc.terminate()
            try:
                self.vllm_proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.vllm_proc.kill()
        if hasattr(self, "_vllm_log"):
            self._vllm_log.close()

    @modal.method()
    def transcribe(
        self, audio_bytes: bytes, language: str = "pt", volume_path: str = ""
    ) -> dict:
        """Transcribe audio via gRPC. Auto-chunks >30s."""
        if volume_path:
            full_path = os.path.join(LYRICS_VOLUME_PATH, volume_path)
            self.logger.info("Reading audio from volume: %s", full_path)
            with open(full_path, "rb") as f:
                audio_bytes = f.read()

        result = self._do_transcribe(audio_bytes, language)
        result["source"] = "volume" if volume_path else "bytes"
        return result

    @modal.method()
    def health(self) -> dict:
        """Health check."""
        import torch

        vllm_alive = hasattr(self, "vllm_proc") and self.vllm_proc.poll() is None
        return {
            "status": "healthy" if vllm_alive else "degraded",
            "vllm_alive": vllm_alive,
            "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
            "model": VLLM_MODEL,
            "mode": "http-snapshot",
        }

    @modal.method()
    def check_done_batch(self, track_ids: list[str]) -> dict[str, bool]:
        """Check which track_ids already have v2 text results."""
        return {
            tid: os.path.exists(
                os.path.join(LYRICS_VOLUME_PATH, "output-v2", f"{tid}.txt")
            )
            for tid in track_ids
        }

    @modal.method()
    def get_result(self, track_id: str) -> str | None:
        """Retrieve LRC from volume. None if not exists."""
        path = os.path.join(LYRICS_VOLUME_PATH, "output", f"{track_id}.lrc")
        if not os.path.exists(path):
            return None
        with open(path, "r") as f:
            return f.read()

    @modal.method()
    def separate_vocals(self, track_id: str, volume_path: str) -> dict:
        """Check if stems exist. Demucs runs separately via DemucsWorker."""
        vocals_path = os.path.join(
            LYRICS_VOLUME_PATH, "stems", f"{track_id}_vocals.wav"
        )
        if os.path.exists(vocals_path):
            return {"track_id": track_id, "status": "cached"}
        return {
            "track_id": track_id,
            "status": "missing",
            "error": "Stems not found. Run DemucsWorker first.",
        }

    @modal.method()
    def transcribe_vocals(self, track_id: str, language: str = "pt") -> dict:
        """Whisper 2-pass transcription of BS-Roformer stems. Text only, no timestamps."""
        output_dir = os.path.join(LYRICS_VOLUME_PATH, "output-v2")
        out_path = os.path.join(output_dir, f"{track_id}.txt")

        if os.path.exists(out_path):
            with open(out_path, "r") as f:
                return {"track_id": track_id, "status": "cached", "text": f.read()}

        vocals_path = os.path.join(
            LYRICS_VOLUME_PATH, "stems-v2", f"{track_id}_vocals.wav"
        )
        if not os.path.exists(vocals_path):
            return {
                "track_id": track_id,
                "status": "no_stems",
                "error": "Vocals not separated yet",
            }

        t0 = time.perf_counter()
        os.makedirs(output_dir, exist_ok=True)

        self.logger.info("Transcribing vocals for %s...", track_id)
        with open(vocals_path, "rb") as f:
            vocals_bytes = f.read()

        result = self._do_transcribe(vocals_bytes, language)
        text = result.get("text", "")

        with open(out_path, "w", encoding="utf-8") as f:
            f.write(text)
        lyrics_volume.commit()

        elapsed = time.perf_counter() - t0
        self.logger.info("Transcribed %s in %.1fs", track_id, elapsed)

        return {
            "track_id": track_id,
            "status": "transcribed",
            "elapsed_s": round(elapsed, 1),
            "text": text,
        }

    @modal.method()
    def process_track(
        self,
        track_id: str,
        volume_path: str,
        lyrics_text: str | None = None,
        language: str = "pt",
    ) -> dict:
        """Combined pipeline: separate + transcribe in one call. Kill-safe via volume checkpoints."""
        # Phase 1: separate (skips if already done)
        sep_result = self.separate_vocals.local(track_id, volume_path)
        if sep_result["status"] == "missing":
            return sep_result

        # Phase 2: transcribe (skips if already done)
        return self.transcribe_vocals.local(track_id, language)

    def _do_transcribe(self, audio_bytes: bytes, language: str = "pt") -> dict:
        """Shared transcription logic."""
        t0 = time.perf_counter()

        if self.vllm_proc.poll() is not None:
            stderr_tail = ""
            try:
                with open("/tmp/vllm-stderr.log") as f:
                    stderr_tail = f.read()[-2000:]
            except Exception:
                pass
            raise RuntimeError(
                f"vLLM process died (exit {self.vllm_proc.returncode}). "
                f"Last stderr:\n{stderr_tail}"
            )

        chunks_wav, audio_duration = _chunk_audio_bytes(audio_bytes)
        num_chunks = len(chunks_wav)
        self.logger.info("Audio: %.1fs, %d chunk(s)", audio_duration, num_chunks)

        texts = []
        prev_text = ""
        t_infer = time.perf_counter()

        for i, chunk_wav in enumerate(chunks_wav):
            data = {
                "model": VLLM_MODEL,
                "language": language,
                "temperature": "0",
            }
            if prev_text:
                data["prompt"] = prev_text[-224:]

            resp = requests.post(
                f"http://localhost:{VLLM_PORT}/v1/audio/transcriptions",
                files={"file": (f"chunk_{i}.wav", chunk_wav, "audio/wav")},
                data=data,
                timeout=300,
            )
            resp.raise_for_status()
            result = resp.json()
            text = result.get("text", "").strip()
            if text:
                texts.append(text)
                prev_text = text

        infer_time = time.perf_counter() - t_infer
        full_text = "\n\n".join(texts)
        elapsed = time.perf_counter() - t0

        self.logger.info(
            "Transcribed %.1fs audio in %.1fs (infer %.1fs, RTF %.3f)",
            audio_duration,
            elapsed,
            infer_time,
            elapsed / audio_duration if audio_duration > 0 else 0,
        )

        return {
            "text": full_text,
            "language": language,
            "duration_audio_s": round(audio_duration, 1),
            "inference_s": round(infer_time, 2),
            "total_s": round(elapsed, 2),
            "rtf": round(elapsed / audio_duration, 3) if audio_duration > 0 else 0,
            "chunks": num_chunks,
            "mode": "http-snapshot",
        }


# ---------------------------------------------------------------------------
# Client mode
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse
    import csv
    import hashlib
    import re

    def has_timestamps(lrc_path: str) -> bool:
        with open(lrc_path, "r", encoding="utf-8") as f:
            for line in f:
                if re.match(r"^\[\d{2}:\d{2}", line):
                    return True
        return False

    def detect_language(text: str) -> str:
        pt_markers = {
            "não",
            "são",
            "você",
            "então",
            "já",
            "também",
            "aqui",
            "mais",
            "porque",
            "está",
        }
        words = set(text.lower().split())
        if len(words & pt_markers) >= 2:
            return "pt"
        return "en"

    parser = argparse.ArgumentParser(description="Rustify Lyrics Aligner (Modal)")
    parser.add_argument("--audio", help="Path to single audio file")
    parser.add_argument("--language", default="pt", help="Language code")
    parser.add_argument(
        "--all-pending", dest="csv", help="CSV with all tracks for batch processing"
    )
    parser.add_argument(
        "--lyrics-dir", default="/tmp/lyrics", help="Dir with plain .lrc files"
    )
    parser.add_argument(
        "--demucs-only",
        dest="demucs_csv",
        help="Run only demucs separation (no Whisper)",
    )
    parser.add_argument(
        "--transcribe",
        dest="transcribe_csv",
        help="Whisper-only on pre-separated stems (CSV: id,path,title,artist,...)",
    )
    parser.add_argument(
        "--download", action="store_true", help="Download results from volume"
    )
    parser.add_argument("--download-csv", help="CSV for download mode")
    parser.add_argument(
        "--output", "-o", default="/tmp/lyrics-synced", help="Output dir for download"
    )
    parser.add_argument("--debug", action="store_true", help="Show raw container logs")
    args = parser.parse_args()

    if args.debug:
        modal.enable_output()

    ServiceCls = modal.Cls.from_name(APP_NAME, "LyricsAligner")

    if args.transcribe_csv:
        tracks = []
        with open(args.transcribe_csv, newline="", encoding="utf-8") as f:
            for row in csv.reader(f):
                tracks.append(
                    {"id": row[0], "path": row[1], "title": row[2], "artist": row[3]}
                )

        print(f"CSV: {len(tracks)} tracks")
        service = ServiceCls()

        all_ids = [t["id"] for t in tracks]
        done_map = {}
        for i in range(0, len(all_ids), 200):
            done_map.update(service.check_done_batch.remote(all_ids[i : i + 200]))

        already_done = sum(1 for v in done_map.values() if v)
        pending = [t for t in tracks if not done_map.get(t["id"], False)]
        print(f"Already transcribed: {already_done} | Pending: {len(pending)}")

        if not pending:
            print("Nothing to do.")
            raise SystemExit(0)

        transcribed = 0
        skipped = 0
        failed = 0
        total = len(pending)

        for i, t in enumerate(pending):
            try:
                lang = detect_language(t.get("lyrics_text", "")) if t.get("lyrics_text") else "pt"
                result = service.transcribe_vocals.remote(
                    track_id=t["id"], language=lang
                )
                status = result["status"]
                pct = (i + 1) / total * 100
                if status == "no_stems":
                    skipped += 1
                    print(
                        f"[{i + 1}/{total} {pct:.0f}%] NO_STEMS  "
                        f"{t['artist']} - {t['title']}"
                    )
                elif status == "cached":
                    transcribed += 1
                    print(
                        f"[{i + 1}/{total} {pct:.0f}%] CACHED    "
                        f"{t['artist']} - {t['title']}"
                    )
                else:
                    transcribed += 1
                    elapsed = result.get("elapsed_s", 0)
                    print(
                        f"[{i + 1}/{total} {pct:.0f}%] TRANSCRIBED "
                        f"{t['artist']} - {t['title']}  ({elapsed}s)"
                    )
            except Exception as e:
                failed += 1
                pct = (i + 1) / total * 100
                print(f"[{i + 1}/{total} {pct:.0f}%] FAIL      {e}")

        print(f"\nDone. transcribed={transcribed} skipped={skipped} failed={failed} total={total}")

    elif args.demucs_csv:
        # Demucs-only: separate vocals, no Whisper
        tracks = []
        with open(args.demucs_csv, newline="", encoding="utf-8") as f:
            for row in csv.reader(f):
                tracks.append(
                    {"id": row[0], "path": row[1], "title": row[2], "artist": row[3]}
                )

        print(f"CSV: {len(tracks)} tracks")
        DemucsClass = modal.Cls.from_name(APP_NAME, "DemucsWorker")
        demucs = DemucsClass()

        all_ids = [t["id"] for t in tracks]
        done_map = {}
        for i in range(0, len(all_ids), 200):
            done_map.update(demucs.check_done_batch.remote(all_ids[i : i + 200]))

        already_done = sum(1 for v in done_map.values() if v)
        pending = [t for t in tracks if not done_map.get(t["id"], False)]
        print(f"Already separated: {already_done} | Pending: {len(pending)}")

        separated = 0
        failed = 0
        for i, t in enumerate(pending):
            raw_path = t["path"]
            music_idx = raw_path.find("/Music/")
            rel_path = (
                raw_path[music_idx + len("/Music/") :]
                if music_idx >= 0
                else os.path.basename(raw_path)
            )
            volume_path = f"mnt/lyrics/input/{rel_path}"

            try:
                result = demucs.separate.remote(
                    track_id=t["id"], volume_path=volume_path
                )
                status = result["status"]
                elapsed = result.get("elapsed_s", 0)
                pct = (i + 1) / len(pending) * 100
                if status == "missing":
                    failed += 1
                    print(
                        f"[{i + 1}/{len(pending)} {pct:.0f}%] MISSING   {t['artist']} - {t['title']}"
                    )
                else:
                    separated += 1
                    print(
                        f"[{i + 1}/{len(pending)} {pct:.0f}%] {status.upper():10s} {t['artist']} - {t['title']}  ({elapsed}s)"
                    )
            except Exception as e:
                failed += 1
                pct = (i + 1) / len(pending) * 100
                print(
                    f"[{i + 1}/{len(pending)} {pct:.0f}%] FAIL      {t['artist']} - {t['title']}: {e}"
                )

        print(f"\nDone. separated={separated} failed={failed} total={len(pending)}")

    elif args.download:
        # Download results from volume
        if not args.download_csv:
            print("--download-csv required with --download")
            raise SystemExit(1)
        service = ServiceCls()
        os.makedirs(args.output, exist_ok=True)
        with open(args.download_csv, newline="", encoding="utf-8") as f:
            tracks = list(csv.reader(f))
        downloaded = 0
        for row in tracks:
            tid = row[0]
            lrc = service.get_result.remote(tid)
            if lrc:
                with open(
                    os.path.join(args.output, f"{tid}.lrc"), "w", encoding="utf-8"
                ) as f:
                    f.write(lrc)
                downloaded += 1
        print(f"Downloaded: {downloaded} .lrc files to {args.output}")

    elif args.csv:
        # Batch: process all pending tracks
        lyrics_dir = args.lyrics_dir

        tracks = []
        with open(args.csv, newline="", encoding="utf-8") as f:
            for row in csv.reader(f):
                tracks.append(
                    {
                        "id": row[0],
                        "path": row[1],
                        "title": row[2],
                        "artist": row[3],
                        "album": row[4],
                        "duration_ms": row[5],
                    }
                )

        print(f"CSV: {len(tracks)} tracks totais")

        service = ServiceCls()

        # Check which are already done
        all_ids = [t["id"] for t in tracks]
        done_map = {}
        batch_size = 200
        for i in range(0, len(all_ids), batch_size):
            chunk = all_ids[i : i + batch_size]
            done_map.update(service.check_done_batch.remote(chunk))

        already_done = sum(1 for v in done_map.values() if v)
        print(f"Volume: {already_done} já processadas")

        # Build pending list
        pending = []
        for t in tracks:
            if done_map.get(t["id"], False):
                continue

            # Check for plain lyrics locally
            lyrics_text = None
            if os.path.isdir(lyrics_dir):
                for fname in os.listdir(lyrics_dir):
                    if fname.startswith(f"{t['id']}__") and fname.endswith(".lrc"):
                        fpath = os.path.join(lyrics_dir, fname)
                        if not has_timestamps(fpath):
                            with open(fpath, "r", encoding="utf-8") as f:
                                lyrics_text = f.read().strip()
                        break

            pending.append({**t, "lyrics_text": lyrics_text})

        with_text = [p for p in pending if p["lyrics_text"]]
        without_text = [p for p in pending if not p["lyrics_text"]]
        print(
            f"Pendentes: {len(pending)} ({len(with_text)} com texto, {len(without_text)} sem texto)"
        )

        if not pending:
            print("Nada a fazer.")
            raise SystemExit(0)

        synced = 0
        failed = 0
        total = len(pending)
        CONCURRENCY = 32

        # Build call args
        calls = []
        for t in pending:
            raw_path = t["path"]
            music_idx = raw_path.find("/Music/")
            rel_path = (
                raw_path[music_idx + len("/Music/") :]
                if music_idx >= 0
                else os.path.basename(raw_path)
            )
            volume_path = f"mnt/lyrics/input/{rel_path}"
            lang = detect_language(t["lyrics_text"]) if t["lyrics_text"] else "pt"
            calls.append((t, volume_path, lang))

        from concurrent.futures import ThreadPoolExecutor, as_completed

        def _process_one(idx, t, volume_path, lang):
            result = service.process_track.remote(
                track_id=t["id"],
                volume_path=volume_path,
                lyrics_text=t["lyrics_text"],
                language=lang,
            )
            return idx, t, result

        completed = 0
        with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
            futures = {
                pool.submit(_process_one, i, t, vp, lg): i
                for i, (t, vp, lg) in enumerate(calls)
            }
            for future in as_completed(futures):
                completed += 1
                try:
                    idx, t, result = future.result()
                    status = result["status"]
                    pct = completed / total * 100
                    if status == "missing":
                        failed += 1
                        print(
                            f"[{completed}/{total} {pct:.0f}%] MISSING   {t['artist']} - {t['title']}: {result.get('error', '')}"
                        )
                    else:
                        synced += 1
                        elapsed = result.get("elapsed_s", 0)
                        lines = result.get("lines", 0)
                        print(
                            f"[{completed}/{total} {pct:.0f}%] {status.upper():12s} {t['artist']} - {t['title']}  ({lines}L, {elapsed}s)"
                        )
                except Exception as e:
                    failed += 1
                    pct = completed / total * 100
                    print(f"[{completed}/{total} {pct:.0f}%] FAIL      {e}")

        print(f"\nDone. synced={synced} failed={failed} total={total}")

    elif args.audio:
        # Single file mode
        t0 = time.time()
        print(f"Reading {args.audio}...")
        with open(args.audio, "rb") as f:
            audio_bytes = f.read()
        print(f"  {len(audio_bytes) / 1e6:.1f}MB")

        service = ServiceCls()
        print("Transcribing...")
        result = service.transcribe.remote(audio_bytes, args.language)
        wall = time.time() - t0

        print(f"RESULT:" + json.dumps(result), flush=True)
        print(f"\nWall time:      {wall:.1f}s")
        print(f"Audio duration: {result['duration_audio_s']}s")
        print(f"RTF:            {result['rtf']}")
        print(f"\nTexto:\n{result['text']}")

    else:
        parser.print_help()
