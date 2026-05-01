#!/usr/bin/env python3
"""Modal DEPLOYED worker for BS-Roformer vocal separation.

Replaces Demucs in the lyrics pipeline v2. Better vocal isolation,
especially for rap and multi-artist tracks.

Model: model_bs_roformer_ep_317_sdr_12.9755 (610MB checkpoint)
GPU snapshot: model downloaded + loaded on first deploy, restored from snapshot after.

Setup:
    1. Deploy:  modal deploy scripts/modal_bs_roformer.py
    2. Batch:   python3 scripts/modal_bs_roformer.py --csv data/tracks_pending_v2.csv

GPU: L4 (24GB). Model ~1-2GB VRAM.
"""

import os
import time

import modal

APP_NAME = "rustify-bs-roformer"
app = modal.App(
    APP_NAME,
    tags={"project": "rustify-player", "model": "bs-roformer"},
)

MINUTES = 60
MODEL_FILENAME = "model_bs_roformer_ep_317_sdr_12.9755.ckpt"
STEMS_SUBDIR = "stems-v2"
NUM_WORKERS = 4

image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.9.0-devel-ubuntu22.04", add_python="3.12"
    )
    .entrypoint([])
    .apt_install(["ffmpeg", "libsndfile1", "clang"])
    .run_commands(
        "pip install uv",
        "uv pip install --system --compile-bytecode "
        "torch torchaudio --index-url https://download.pytorch.org/whl/cu124",
        "uv pip install --system --compile-bytecode audio-separator onnxruntime-gpu",
    )
)

lyrics_volume = modal.Volume.from_name("rustify-lyrics-data", create_if_missing=True)
VOL = "/lyrics-data"


@app.cls(
    image=image,
    gpu="A100",
    timeout=10 * MINUTES,
    volumes={VOL: lyrics_volume},
    scaledown_window=2,
)
@modal.concurrent(max_inputs=NUM_WORKERS)
class BSRoformerWorker:
    @modal.enter()
    def load_model(self):
        import logging
        import queue

        logging.basicConfig(
            level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
        )
        self.logger = logging.getLogger("bs-roformer")

        from audio_separator.separator import Separator

        self.pool = queue.Queue()
        for i in range(NUM_WORKERS):
            sep = Separator(
                model_file_dir="/root/models",
                output_dir=f"/tmp/sep-output-{i}",
                output_single_stem="vocals",
                output_format="WAV",
                use_autocast=True,
            )
            sep.load_model(MODEL_FILENAME)
            os.makedirs(f"/tmp/sep-output-{i}", exist_ok=True)
            self.pool.put(sep)
            self.logger.info("Loaded BS-Roformer instance %d/%d", i + 1, NUM_WORKERS)

        import torch

        if torch.cuda.is_available():
            free, total = torch.cuda.mem_get_info()
            self.logger.info(
                "VRAM: %.1fGB used / %.1fGB total (%d workers)",
                (total - free) / 1e9,
                total / 1e9,
                NUM_WORKERS,
            )

    @modal.method()
    def check_done_batch(self, track_ids: list[str]) -> dict[str, bool]:
        stems_dir = os.path.join(VOL, STEMS_SUBDIR)
        return {
            tid: os.path.exists(os.path.join(stems_dir, f"{tid}_vocals.wav"))
            for tid in track_ids
        }

    @modal.method()
    def separate(self, track_id: str, volume_path: str) -> dict:
        stems_dir = os.path.join(VOL, STEMS_SUBDIR)
        final_path = os.path.join(stems_dir, f"{track_id}_vocals.wav")

        if os.path.exists(final_path):
            return {"track_id": track_id, "status": "cached"}

        audio_path = os.path.join(VOL, volume_path)
        if not os.path.exists(audio_path):
            return {
                "track_id": track_id,
                "status": "missing",
                "error": f"Not found: {audio_path}",
            }

        t0 = time.perf_counter()
        os.makedirs(stems_dir, exist_ok=True)

        import shutil

        import torch

        sep = self.pool.get()
        try:
            sep_dir = sep.output_dir
            for f in os.listdir(sep_dir):
                os.unlink(os.path.join(sep_dir, f))

            with torch.amp.autocast("cuda", dtype=torch.float16):
                output_files = sep.separate(audio_path)

            src = None
            if output_files:
                candidate = os.path.join(sep_dir, os.path.basename(output_files[0]))
                if os.path.exists(candidate):
                    src = candidate
                elif os.path.exists(output_files[0]):
                    src = output_files[0]

            if not src:
                return {
                    "track_id": track_id,
                    "status": "error",
                    "error": "No vocals output found",
                }

            shutil.copy2(src, final_path)
            os.unlink(src)
        finally:
            self.pool.put(sep)

        lyrics_volume.commit()
        elapsed = time.perf_counter() - t0
        self.logger.info("Separated %s in %.1fs", track_id, elapsed)
        return {
            "track_id": track_id,
            "status": "separated",
            "elapsed_s": round(elapsed, 1),
        }


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse
    import csv
    from concurrent.futures import ThreadPoolExecutor, as_completed

    parser = argparse.ArgumentParser(
        description="BS-Roformer vocal separation (Modal)"
    )
    parser.add_argument("--csv", required=True, help="CSV: id,path,title,artist,...")
    parser.add_argument(
        "--concurrency", type=int, default=NUM_WORKERS, help="Parallel remote calls"
    )
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    if args.debug:
        modal.enable_output()

    tracks = []
    with open(args.csv, newline="", encoding="utf-8") as f:
        for row in csv.reader(f):
            tracks.append(
                {"id": row[0], "path": row[1], "title": row[2], "artist": row[3]}
            )

    print(f"CSV: {len(tracks)} tracks")

    worker = modal.Cls.from_name(APP_NAME, "BSRoformerWorker")()

    all_ids = [t["id"] for t in tracks]
    done_map = {}
    for i in range(0, len(all_ids), 200):
        done_map.update(worker.check_done_batch.remote(all_ids[i : i + 200]))

    already_done = sum(1 for v in done_map.values() if v)
    pending = [t for t in tracks if not done_map.get(t["id"], False)]
    print(f"Already done: {already_done} | Pending: {len(pending)}")

    if not pending:
        print("Nothing to do.")
        raise SystemExit(0)

    def _do_one(idx, t):
        raw_path = t["path"]
        music_idx = raw_path.find("/Music/")
        rel_path = (
            raw_path[music_idx + len("/Music/") :]
            if music_idx >= 0
            else os.path.basename(raw_path)
        )
        volume_path = f"mnt/lyrics/input/{rel_path}"
        result = worker.separate.remote(track_id=t["id"], volume_path=volume_path)
        return idx, t, result

    completed = 0
    separated = 0
    failed = 0
    total = len(pending)

    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = {pool.submit(_do_one, i, t): i for i, t in enumerate(pending)}
        for future in as_completed(futures):
            completed += 1
            try:
                idx, t, result = future.result()
                status = result["status"]
                elapsed = result.get("elapsed_s", 0)
                pct = completed / total * 100
                if status in ("missing", "error"):
                    failed += 1
                    print(
                        f"[{completed}/{total} {pct:.0f}%] {status.upper():10s} "
                        f"{t['artist']} - {t['title']}: {result.get('error', '')}"
                    )
                else:
                    separated += 1
                    print(
                        f"[{completed}/{total} {pct:.0f}%] {status.upper():10s} "
                        f"{t['artist']} - {t['title']}  ({elapsed}s)"
                    )
            except Exception as e:
                failed += 1
                pct = completed / total * 100
                print(f"[{completed}/{total} {pct:.0f}%] FAIL      {e}")

    print(f"\nDone. separated={separated} failed={failed} total={total}")
