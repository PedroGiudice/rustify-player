#!/usr/bin/env python3
"""Converte imagens para fundo preto + conteúdo branco puro."""

import argparse
import sys
from pathlib import Path

import cv2
import numpy as np


def binarize(src: Path, dst: Path, threshold: int, invert: bool) -> None:
    img = cv2.imread(str(src), cv2.IMREAD_GRAYSCALE)
    if img is None:
        print(f"SKIP  {src} (não consegui ler)")
        return

    _, binary = cv2.threshold(img, threshold, 255, cv2.THRESH_BINARY)

    if invert:
        binary = cv2.bitwise_not(binary)

    cv2.imwrite(str(dst), binary)
    print(f"OK    {src.name} -> {dst.name}")


def main() -> None:
    p = argparse.ArgumentParser(description="Binariza imagens: fundo preto, conteúdo branco.")
    p.add_argument("inputs", nargs="+", help="Arquivos ou diretório de input")
    p.add_argument("-o", "--output", default="./binarized", help="Diretório de output (default: ./binarized)")
    p.add_argument("-t", "--threshold", type=int, default=128, help="Threshold 0-255 (default: 128)")
    p.add_argument("--invert", action="store_true", help="Inverte resultado (se o objeto é escuro no original)")
    p.add_argument("--format", default=None, help="Formato de saída (png, jpg). Default: mesmo do input")
    args = p.parse_args()

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)

    files: list[Path] = []
    for inp in args.inputs:
        path = Path(inp)
        if path.is_dir():
            files.extend(sorted(path.glob("*")))
        else:
            files.append(path)

    exts = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff"}
    files = [f for f in files if f.suffix.lower() in exts]

    if not files:
        print("Nenhuma imagem encontrada.")
        sys.exit(1)

    print(f"{len(files)} imagem(ns), threshold={args.threshold}, invert={args.invert}\n")

    for f in files:
        suffix = f".{args.format}" if args.format else f.suffix
        dst = out / f"{f.stem}{suffix}"
        binarize(f, dst, args.threshold, args.invert)


if __name__ == "__main__":
    main()
