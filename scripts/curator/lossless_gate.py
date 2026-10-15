#!/usr/bin/env python3
"""Portão de qualidade das portas de aquisição por script (Bandcamp/SoundCloud e Tidal).

Decisão do CEO (15/10/2026): só entra no acervo lossless de verdade, medido pelo CONTEÚDO
(corte espectral), não pela etiqueta. FLAC/WAV/AIFF com corte de lossy é recusado.

A medição é do quality_audit.py (`analyze`); aqui fica só a decisão, separada em função pura
para os dois baixadores usarem a mesma regra:

    refusal_reason(r)  -> "lossy por dentro, corte 16,0 kHz" ou None   (pura, recebe o dict do analyze)
    check_file(path)   -> Verdict (mede e decide; falha da ferramenta NÃO bloqueia a faixa)

Recusa = classe espectral `lossy` ou `provavel_lossy`; `sem_corte` e `hires_de_cd` entram.
A classe ignora o COMMENT (declared_lossy=False): a etiqueta não conta, só o conteúdo.
O quality_audit importa numpy, então o import é tardio: quem só usa as funções puras de
formatação não paga por isso.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

REFUSED_CLASSES = ("lossy", "provavel_lossy")


def spectral_class(r: dict) -> str:
    """Classe espectral do dict do `analyze`, ignorando o COMMENT."""
    import quality_audit

    return quality_audit.classify(r["sr"], r["cutoff_hz"], False)


def format_khz(hz: float) -> str:
    """16000 -> '16,0' (vírgula decimal, uma casa)."""
    return f"{hz / 1000:.1f}".replace(".", ",")


def format_rate(sr: int) -> str:
    """22050 -> '22,05'; 32000 -> '32'."""
    return f"{sr / 1000:.3f}".rstrip("0").rstrip(".").replace(".", ",")


def refusal_reason(r: dict) -> str | None:
    """Pura. Motivo de recusa (sem o prefixo RECUSADA) ou None se a faixa pode entrar.
    Primeiro o piso do CEO (16 bit/44,1 kHz, pelo cabeçalho: com Nyquist baixo o
    detector não tem o que julgar), depois o corte espectral."""
    if r.get("sr") and r["sr"] < 44100:
        return f"abaixo de CD ({format_rate(r['sr'])} kHz)"
    if r.get("bits") and r["bits"] < 16:
        return f"abaixo de CD ({r['bits']} bit)"
    if spectral_class(r) not in REFUSED_CLASSES:
        return None
    return f"lossy por dentro, corte {format_khz(r['cutoff_hz'])} kHz"


@dataclass
class Verdict:
    reason: str | None = None      # motivo da recusa; None = entra
    cutoff_hz: int | None = None
    error: str | None = None       # análise falhou: a faixa entra e o motivo é impresso

    @property
    def refused(self) -> bool:
        return self.reason is not None


def require() -> None:
    """Falha cedo (ImportError) se a medição não puder rodar. Os baixadores chamam
    no início: sem numpy, cada faixa seria baixada e marcada como falha."""
    import quality_audit  # noqa: F401


def check_file(path: Path) -> Verdict:
    """Mede o arquivo e decide. Falha da medição nesta faixa (ffmpeg, faixa curta) vira
    Verdict.error: a faixa entra, quem chama imprime o aviso. Sem numpy, ImportError sobe."""
    # Dependência faltando (numpy) não é falha de uma faixa: derruba a execução, senão o
    # portão deixaria tudo entrar em silêncio (ex.: fila reiniciada sem --with numpy).
    import quality_audit

    try:
        r = quality_audit.analyze(Path(path))
        return Verdict(reason=refusal_reason(r), cutoff_hz=r.get("cutoff_hz"))
    except Exception as e:  # noqa: BLE001 — falha da ferramenta não bloqueia a faixa
        return Verdict(error=f"{type(e).__name__}: {e}"[:200])
