#!/usr/bin/env python3
"""ACE-Step Transcriber no Modal (GPU).

Music-focused transcription via ACE-Step/acestep-transcriber (Qwen2.5-Omni-7B fine-tune).
Outputs structured lyrics with section tags ([Verse], [Chorus], [Bridge], etc.).

Deploy:   modal deploy scripts/modal_acestep_transcriber.py
Test:     python3 scripts/modal_acestep_transcriber.py --volume-path stems/187_vocals_roformer.wav
Batch:    python3 scripts/modal_acestep_transcriber.py --batch stems/
"""

import os
import time

import modal

APP_NAME = "rustify-acestep-transcriber"
MODEL_NAME = "ACE-Step/acestep-transcriber"
GPU_TYPE = "A100-40GB"
VOLUME_PATH = "/data"
MINUTES = 60

app = modal.App(
    APP_NAME, tags={"project": "rustify-player", "model": "acestep-transcriber"}
)
hf_secret = modal.Secret.from_name("huggingface-secret")
lyrics_vol = modal.Volume.from_name("rustify-lyrics-data", create_if_missing=True)


def download_model():
    from huggingface_hub import snapshot_download

    snapshot_download(MODEL_NAME)


FLASH_ATTN_WHEEL = (
    "https://github.com/Dao-AILab/flash-attention/releases/download/v2.8.3/"
    "flash_attn-2.8.3+cu12torch2.8cxx11abiTRUE-cp312-cp312-linux_x86_64.whl"
)

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg", "libsndfile1")
    .pip_install(
        "torch==2.8.0",
        "torchaudio==2.8.0",
        "torchvision==0.23.0",
        "transformers>=4.52.0",
        "accelerate",
        "qwen-omni-utils[decord]",
        "soundfile",
        "numpy",
        FLASH_ATTN_WHEEL,
    )
    .run_function(download_model, secrets=[hf_secret])
)


@app.cls(
    image=image,
    gpu=GPU_TYPE,
    memory=16384,
    timeout=10 * MINUTES,
    secrets=[hf_secret],
    volumes={VOLUME_PATH: lyrics_vol},
    scaledown_window=5,
)
class Transcriber:
    @modal.enter()
    def load(self):
        import logging

        import torch
        from transformers import Qwen2_5OmniForConditionalGeneration, Qwen2_5OmniProcessor

        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s - %(levelname)s - %(message)s",
        )
        self.logger = logging.getLogger("acestep")
        self.logger.info("Loading ACE-Step transcriber with FA2...")

        self.model = Qwen2_5OmniForConditionalGeneration.from_pretrained(
            MODEL_NAME,
            torch_dtype=torch.bfloat16,
            device_map="auto",
            attn_implementation="flash_attention_2",
        )
        self.processor = Qwen2_5OmniProcessor.from_pretrained(MODEL_NAME)
        self.logger.info("Model loaded on GPU with FA2 — ready.")

    @modal.method()
    def transcribe(self, volume_path: str = "", audio_bytes: bytes = b"") -> dict:
        """Transcribe audio to structured lyrics.

        Provide either volume_path (reads from Modal volume) or audio_bytes.
        Returns dict with structured lyrics, section tags, and metadata.
        """
        import tempfile

        import soundfile as sf
        from qwen_omni_utils import process_mm_info

        t0 = time.perf_counter()

        if volume_path:
            audio_path = os.path.join(VOLUME_PATH, volume_path)
            if not os.path.exists(audio_path):
                return {"error": f"Not found in volume: {volume_path}"}
            self.logger.info("Reading from volume: %s", volume_path)
        elif audio_bytes:
            tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            tmp.write(audio_bytes)
            tmp.close()
            audio_path = tmp.name
            self.logger.info("Reading from uploaded bytes (%d)", len(audio_bytes))
        else:
            return {"error": "Provide volume_path or audio_bytes"}

        try:
            info = sf.info(audio_path)
            duration = info.duration
        except Exception:
            duration = 0.0

        self.logger.info("Audio: %.1fs", duration)

        conversation = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "*Task* Transcribe this audio in detail"},
                    {"type": "audio", "audio": audio_path},
                ],
            },
        ]

        text_prompt = self.processor.apply_chat_template(
            conversation,
            add_generation_prompt=True,
            tokenize=False,
        )
        audios, _, _ = process_mm_info(conversation, use_audio_in_video=False)
        inputs = self.processor(
            text=text_prompt,
            audio=audios,
            return_tensors="pt",
            padding=True,
            use_audio_in_video=False,
        )
        inputs = inputs.to(self.model.device).to(self.model.dtype)

        t_infer = time.perf_counter()
        output_ids = self.model.generate(
            **inputs,
            max_new_tokens=4096,
            do_sample=False,
            use_audio_in_video=False,
            return_audio=False,
        )

        if isinstance(output_ids, tuple):
            output_ids = output_ids[0]

        transcript = self.processor.batch_decode(
            output_ids[:, inputs["input_ids"].shape[1]:],
            skip_special_tokens=True,
            clean_up_tokenization_spaces=False,
        )[0]

        infer_time = time.perf_counter() - t_infer
        elapsed = time.perf_counter() - t0

        if audio_bytes and not volume_path:
            os.unlink(audio_path)

        self.logger.info(
            "Transcribed %.1fs audio in %.1fs (infer %.1fs)",
            duration, elapsed, infer_time,
        )

        return {
            "transcript": transcript,
            "duration_audio_s": round(duration, 1),
            "inference_s": round(infer_time, 2),
            "total_s": round(elapsed, 2),
            "rtf": round(elapsed / duration, 3) if duration > 0 else 0,
            "model": MODEL_NAME,
            "source": "volume" if volume_path else "upload",
        }


if __name__ == "__main__":
    import argparse
    import json

    parser = argparse.ArgumentParser(description="ACE-Step transcriber client")
    parser.add_argument("--volume-path", help="Path inside Modal volume (e.g. stems/187_vocals_roformer.wav)")
    parser.add_argument("--audio", help="Local audio file to upload")
    parser.add_argument("--batch", help="Volume directory to transcribe all files from")
    parser.add_argument("-o", "--output", help="Output file (default: stdout)")
    args = parser.parse_args()

    service = modal.Cls.from_name(APP_NAME, "Transcriber")()

    if args.batch:
        import modal as m

        vol = m.Volume.from_name("rustify-lyrics-data")
        entries = list(vol.listdir(args.batch))
        audio_exts = {".wav", ".flac", ".mp3", ".m4a", ".ogg"}

        results = []
        for entry in entries:
            path = f"{args.batch}/{entry.path}" if not entry.path.startswith(args.batch) else entry.path
            ext = os.path.splitext(entry.path)[1].lower()
            if ext not in audio_exts:
                continue
            print(f"Transcribing: {path}", flush=True)
            r = service.transcribe.remote(volume_path=path)
            r["file"] = path
            results.append(r)
            print(json.dumps(r, indent=2, ensure_ascii=False), flush=True)

        if args.output:
            with open(args.output, "w") as f:
                json.dump(results, f, indent=2, ensure_ascii=False)
            print(f"Saved {len(results)} results to {args.output}")
    else:
        audio_bytes = b""
        volume_path = ""

        if args.audio:
            with open(args.audio, "rb") as f:
                audio_bytes = f.read()
        elif args.volume_path:
            volume_path = args.volume_path
        else:
            parser.error("Provide --volume-path, --audio, or --batch")

        result = service.transcribe.remote(
            volume_path=volume_path,
            audio_bytes=audio_bytes,
        )

        output = json.dumps(result, indent=2, ensure_ascii=False)
        if args.output:
            with open(args.output, "w") as f:
                f.write(output)
            print(f"Saved to {args.output}")
        else:
            print(output)
