"""LTX-2 batch: 3 elemental rustify sprites (flames2, ice, plant).

Cada sprite usa uma imagem-base distinta como conditioning (img2vid). Os
prompts descrevem o MOVIMENTO do elemento, nao a composicao (que ja vem
do anchor visual). Strength 1.0 para preservar wordmark + paleta da
imagem-base.

Frames: 241 (~10s @ 24fps). Default LTX e 121 (5s); duplicamos pra dar
mais variacao temporal pro pipeline de shape (96 frames extraidos
uniformemente). Se OOM no H200, fallback automatico pra 161 frames.

Custo: ~5-10min/gen warm + ~5min cold start. 3 gens warm = ~25min, ~$5.

Prerequisitos (rodar 1x cada):

    1. Subir as 3 conditioning images pro Volume:
       modal volume put ltx2-inputs docs/elements/rustify-flames2.jpeg
       modal volume put ltx2-inputs docs/elements/rusitfy-ice.jpeg
       modal volume put ltx2-inputs docs/elements/rustify-plant.jpeg

    2. Redeploy app (precisa do param num_frames novo):
       modal app stop example-ltx2-two-stage
       modal deploy ~/modal-examples/06_gpu_and_ml/text-to-video/ltx2_two_stage.py

Uso:
    python3 scripts/run_ltx_elements.py                # batch 3 gens 10s
    python3 scripts/run_ltx_elements.py --frames 161   # 6.7s (fallback OOM)
    python3 scripts/run_ltx_elements.py --frames 121   # 5s (LTX nativo)
    python3 scripts/run_ltx_elements.py --only ice     # roda so o ice
"""

import argparse
import sys
import time
import traceback
from pathlib import Path

import modal

OUTPUT_DIR = Path.home() / "video-gen"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

APP_NAME = "example-ltx2-two-stage"
CLASS_NAME = "LTX2TwoStage"
OUTPUT_VOLUME = "ltx2-outputs"

PROMPTS = [
    {
        "name": "rustify-flames2",
        "seed": 42,
        "conditioning": "rustify-flames2.jpeg",
        "prompt": (
            "Bright orange and yellow flames lick upward from the top of "
            "every pixel-art letter, gently pulsing and intensifying over "
            "10 seconds. White-hot flame tips flicker rapidly. Embers and "
            "amber sparks drift upward into the void above the wordmark. "
            "Letters glow red-hot rhythmically. The wordmark itself stays "
            "static — only the flames and sparks move. Static camera, "
            "centered composition, no letter morphing, no text changes, "
            "absolute black background preserved. Retro 8-bit arcade "
            "aesthetic, sharp pixel edges."
        ),
    },
    {
        "name": "rustify-ice",
        "seed": 137,
        "conditioning": "rusitfy-ice.jpeg",
        "prompt": (
            "Pale cyan and ice-white frozen flames slowly grow upward from "
            "the top of every pixel-art letter, with sharp ice crystals and "
            "frost shards rising. Icicles drip slowly from the bottom edges "
            "of the letters, occasionally a frost particle breaks off and "
            "falls. Letters breathe with a faint cyan glow. Frost particles "
            "drift gently upward into the void. The wordmark itself stays "
            "static — only the ice formations and particles move. No "
            "melting, no thawing. Static camera, centered composition, no "
            "letter morphing, absolute black background preserved. Retro "
            "8-bit arcade aesthetic, sharp pixel edges."
        ),
    },
    {
        "name": "rustify-plant",
        "seed": 271,
        "conditioning": "rustify-plant.jpeg",
        "prompt": (
            "Lush green vines and ivy slowly sway and grow around the "
            "pixel-art letters. New leaves unfurl gently, small pink and "
            "white flowers bloom and pulse softly. Tendrils extend "
            "organically beyond the letter outlines, reaching outward. "
            "Occasional petals drift downward. Letters remain rigidly "
            "static — only the foliage moves with a natural breeze rhythm. "
            "Static camera, centered composition, no letter morphing, "
            "absolute black background preserved. Retro 8-bit arcade "
            "aesthetic, sharp pixel edges."
        ),
    },
]


def list_volume_files(vol):
    return {e.path for e in vol.iterdir("/") if e.path.endswith(".mp4")}


def fmt_secs(s: float) -> str:
    if s < 60:
        return f"{s:.0f}s"
    return f"{s / 60:.1f}min ({s:.0f}s)"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--frames",
        type=int,
        default=241,
        help="num_frames pro LTX. 121=5s, 161=6.7s, 241=10s. Default 241.",
    )
    ap.add_argument(
        "--strength",
        type=float,
        default=1.0,
        help="Conditioning strength. 1.0 anchor forte, 0.7 mais respiracao.",
    )
    ap.add_argument(
        "--only",
        choices=[p["name"].replace("rustify-", "") for p in PROMPTS],
        help="Roda so um elemento (flames2, ice, ou plant).",
    )
    args = ap.parse_args()

    try:
        cls_handle = modal.Cls.from_name(APP_NAME, CLASS_NAME)
        outputs = modal.Volume.from_name(OUTPUT_VOLUME)
    except Exception as e:
        print(f"ERRO: nao consegui conectar ao app deployed.\n  {e}\n")
        print("Faltou rodar:")
        print("  modal deploy ~/modal-examples/06_gpu_and_ml/text-to-video/ltx2_two_stage.py")
        sys.exit(1)

    ltx = cls_handle()

    if args.only:
        prompts = [p for p in PROMPTS if p["name"] == f"rustify-{args.only}"]
    else:
        prompts = PROMPTS

    print(f"=== LTX-2 elementals: {len(prompts)} variant(s) ===")
    print(f"App:      {APP_NAME}")
    print(f"Frames:   {args.frames} (~{args.frames/24:.1f}s @ 24fps)")
    print(f"Strength: {args.strength}")
    print(f"Output:   {OUTPUT_DIR}\n")

    results = []
    failures = []
    total_start = time.time()

    for i, p in enumerate(prompts, 1):
        print(f"[{i}/{len(prompts)}] {p['name']} (seed={p['seed']}, anchor={p['conditioning']})")
        gen_start = time.time()

        try:
            before = list_volume_files(outputs)
            ltx.generate.remote(
                prompt=p["prompt"],
                conditioning_image_filename=p["conditioning"],
                name_suffix=p["name"],
                seed=p["seed"],
                strength=args.strength,
                num_frames=args.frames,
            )
            after = list_volume_files(outputs)
        except Exception as e:
            elapsed = time.time() - gen_start
            print(f"   FALHOU apos {fmt_secs(elapsed)}: {e}")
            traceback.print_exc()
            failures.append((p["name"], str(e)))
            continue

        new_files = sorted(after - before)
        elapsed = time.time() - gen_start

        if not new_files:
            print(f"   WARN: nenhum mp4 novo na volume apos {fmt_secs(elapsed)}")
            failures.append((p["name"], "no new file in volume"))
            continue

        for mp4_name in new_files:
            print(f"   gen ok em {fmt_secs(elapsed)} -> volume: {mp4_name}")
            local_path = OUTPUT_DIR / f"{p['name']}__{Path(mp4_name).name}"
            try:
                local_path.write_bytes(b"".join(outputs.read_file(mp4_name)))
                size_mb = local_path.stat().st_size / (1024 * 1024)
                print(f"   saved: {local_path} ({size_mb:.1f} MB)\n")
                results.append(local_path)
            except Exception as e:
                print(f"   ERRO ao baixar {mp4_name}: {e}\n")
                failures.append((p["name"], f"download failed: {e}"))

    total = time.time() - total_start

    print(f"=== Concluido em {fmt_secs(total)} ===")
    print(f"Sucesso: {len(results)}/{len(prompts)}")
    if results:
        print("\nArquivos:")
        for r in results:
            print(f"  {r}")
    if failures:
        print(f"\nFalhas ({len(failures)}):")
        for name, err in failures:
            print(f"  {name}: {err}")


if __name__ == "__main__":
    main()
