"""LTX-2 batch generation for sprite-rustify variants (img2vid).

Gera N variantes da wordmark RUSTIFY em chamas usando img2vid: o frame
estatico em ~/Downloads/rustify-flames.jpeg (carregado pra Modal Volume
ltx2-inputs) e usado como conditioning, mantendo o pixel-art lettering
intacto. Cada prompt varia paleta + comportamento das chamas.

Custo estimado: ~5-8min/gen warm + ~3-5min cold start. 1 gen ~= $1.50.
6 gens ~= $9, 45min total.

Prerequisitos (rodar 1 vez):

    1. HF secret no Modal:
       https://huggingface.co/google/gemma-3-12b-it-qat-q4_0-unquantized
       -> aceitar license. Modal Secret `huggingface-secret` com HF_TOKEN.

    2. Subir conditioning image:
       modal volume create ltx2-inputs   # se ainda nao existir
       scp cmr-auto@100.102.249.9:~/Downloads/rustify-flames.jpeg /tmp/
       modal volume put ltx2-inputs /tmp/rustify-flames.jpeg

    3. Deploy da app modificada:
       modal deploy ~/modal-examples/06_gpu_and_ml/text-to-video/ltx2_two_stage.py

Uso:
    python3 scripts/run_ltx_batch.py --test       # 1 gen (classic burn) pra validar
    python3 scripts/run_ltx_batch.py              # batch dos 6 prompts

Notas:
    - LTX-2 hardcoda 1536x1024 (landscape). Imagem source 2752x1536 e
      letterboxada pra 1536x857 + black padding (32px top/bottom).
    - Conditioning preserva wordmark; prompts descrevem variacao da
      paleta + temporal arc (calmo -> intenso -> sparks).
    - 121 frames @ 24fps = ~5s. build_shape_anim.mjs depois extrai 96
      frames pingpong-able.
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
INPUT_VOLUME = "ltx2-inputs"
OUTPUT_VOLUME = "ltx2-outputs"
CONDITIONING_IMAGE = "rustify-flames.jpeg"

# Cada entry roda em sequencia no mesmo container warm (1 cold start).
# `seed` distinto por gen evita degenerescencia se 2 prompts forem proximos.
PROMPTS = [
    {
        "name": "rustify-classic-burn",
        "seed": 42,
        "prompt": (
            "An 8-bit pixel-art wordmark 'RUSTIFY' rendered in dark rust-red "
            "block letters on absolute black background. Bright orange and "
            "yellow flames lick upward from the top edge of every letter, "
            "white-hot at the tips, with small ember sparks rising into the "
            "void above. Over 5 seconds the flames slowly intensify: low "
            "calm flicker at first, then medium swirling tongues of fire, "
            "finally peaking with bright sparks ejecting upward and the "
            "letters glowing red-hot. Static camera, centered composition, "
            "no letter morphing, no text changes. Restricted palette: rust "
            "red, deep crimson, orange, yellow, white-hot, absolute black "
            "background. High contrast, retro arcade aesthetic."
        ),
    },
    {
        "name": "rustify-frost-blue",
        "seed": 137,
        "prompt": (
            "An 8-bit pixel-art wordmark 'RUSTIFY' rendered in deep cobalt-blue "
            "block letters on absolute black background. Cold electric cyan and "
            "ice-white flames lick upward from the top of each letter like frost "
            "fire, with pale-blue crystalline sparks rising into the void. Over "
            "5 seconds the cold flames intensify: low calm flicker first, then "
            "medium serpentine cyan tongues, finally peaking with bright "
            "ice-white sparks scattering upward and letters glowing electric "
            "blue. Static camera, centered composition, no letter morphing, "
            "no text changes. Restricted palette: cobalt blue, electric cyan, "
            "silver, ice white, absolute black background. High contrast, "
            "frozen luminous retro aesthetic."
        ),
    },
    {
        "name": "rustify-toxic-green",
        "seed": 271,
        "prompt": (
            "An 8-bit pixel-art wordmark 'RUSTIFY' rendered in dark forest-green "
            "block letters on absolute black background. Radioactive acid-green "
            "and lime-yellow flames lick upward from the top of each letter, "
            "with toxic green sparks and smoke wisps rising into the void. Over "
            "5 seconds the flames intensify: low calm flicker, then medium "
            "swirling acid tongues, finally peaking with bright lime sparks and "
            "letters glowing radioactive green. Static camera, centered "
            "composition, no letter morphing, no text changes. Restricted "
            "palette: dark forest green, radioactive lime, acid yellow, "
            "white-green core, absolute black background. High contrast, "
            "biohazard retro aesthetic."
        ),
    },
    {
        "name": "rustify-magenta-cyber",
        "seed": 314,
        "prompt": (
            "An 8-bit pixel-art wordmark 'RUSTIFY' rendered in deep magenta "
            "block letters on absolute black background. Hot magenta and "
            "electric cyan synthwave flames lick upward from the top of each "
            "letter, with violet and pink sparks rising into the void above. "
            "Over 5 seconds the neon flames intensify: low calm flicker first, "
            "then medium twisting magenta-cyan tongues, finally peaking with "
            "bright pink-white sparks scattering upward and letters glowing "
            "hot pink. Static camera, centered composition, no letter morphing, "
            "no text changes. Restricted palette: deep magenta, hot pink, "
            "electric cyan, violet, white core, absolute black background. "
            "High contrast, synthwave retro aesthetic."
        ),
    },
    {
        "name": "rustify-solar-gold",
        "seed": 528,
        "prompt": (
            "An 8-bit pixel-art wordmark 'RUSTIFY' rendered in deep amber-gold "
            "block letters on absolute black background. Bright gold and "
            "white-hot solar flames lick upward from the top of each letter "
            "like coronal loops, with golden ember sparks rising into the void. "
            "Over 5 seconds the solar flames intensify: low calm flicker first, "
            "then medium swirling gold tongues, finally peaking with bright "
            "white-hot sparks ejecting upward and letters glowing molten gold. "
            "Static camera, centered composition, no letter morphing, no text "
            "changes. Restricted palette: deep amber, bright gold, white-hot "
            "core, sunlight yellow, absolute black background. High contrast, "
            "solar incandescent retro aesthetic."
        ),
    },
    {
        "name": "rustify-prism",
        "seed": 707,
        "prompt": (
            "An 8-bit pixel-art wordmark 'RUSTIFY' rendered in deep iridescent "
            "block letters on absolute black background. Prismatic full-spectrum "
            "flames lick upward from the top of each letter, swirling through "
            "red, orange, yellow, green, cyan, blue and violet in fractal "
            "patterns, with multicolored sparks rising into the void. Over 5 "
            "seconds the rainbow flames intensify: low calm flicker first, then "
            "medium twisting spectrum tongues, finally peaking with bright "
            "white-rainbow sparks scattering upward and letters glowing "
            "iridescent. Static camera, centered composition, no letter "
            "morphing, no text changes. Restricted palette: full visible "
            "spectrum on absolute black background. High contrast, prismatic "
            "retro aesthetic."
        ),
    },
]


def list_volume_files(vol):
    """Lista todos os mp4 na volume (client-side iterdir le fresh)."""
    return {e.path for e in vol.iterdir("/") if e.path.endswith(".mp4")}


def fmt_secs(s: float) -> str:
    if s < 60:
        return f"{s:.0f}s"
    return f"{s / 60:.1f}min ({s:.0f}s)"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--test",
        action="store_true",
        help="Roda apenas o primeiro prompt (rustify-classic-burn) pra validar img conditioning antes do batch.",
    )
    ap.add_argument(
        "--no-conditioning",
        action="store_true",
        help="Desabilita img conditioning (txt2vid puro). Fallback se img2vid falhar.",
    )
    ap.add_argument(
        "--strength",
        type=float,
        default=1.0,
        help="Conditioning strength (0.5-1.0). 1.0=wordmark fixa, 0.7=mais respiracao nas chamas. Default 1.0.",
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

    prompts = PROMPTS[:1] if args.test else PROMPTS
    conditioning = None if args.no_conditioning else CONDITIONING_IMAGE

    print(f"=== LTX-2 batch: {len(prompts)} variant(s) ===")
    print(f"App:          {APP_NAME}")
    print(f"Conditioning: {conditioning or '(none, txt2vid)'}")
    print(f"Strength:     {args.strength}")
    print(f"Output:       {OUTPUT_DIR}\n")

    results = []
    failures = []
    total_start = time.time()

    for i, p in enumerate(prompts, 1):
        print(f"[{i}/{len(prompts)}] {p['name']} (seed={p['seed']})")
        gen_start = time.time()

        try:
            before = list_volume_files(outputs)
            suffix = p["name"]
            if args.strength != 1.0:
                suffix = f"{p['name']}-s{args.strength:.2f}".replace(".", "")
            ltx.generate.remote(
                prompt=p["prompt"],
                conditioning_image_filename=conditioning,
                name_suffix=suffix,
                seed=p["seed"],
                strength=args.strength,
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
