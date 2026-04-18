# CPU-only image. Builds ~2.5 GB due to PyTorch; acceptable since it stays
# on the VM (not shipped to users).

FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models \
    TRANSFORMERS_CACHE=/models

# System deps: libsndfile for torchaudio side effects (not directly used
# by us, but transformers/torchaudio pulls it at import time).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        libsndfile1 \
        ca-certificates \
        curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .

# Install torch CPU-only from the pytorch.org wheel index, then everything
# else from PyPI. Two-step so pip doesn't try to resolve torch from the
# default index first.
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir \
        --index-url https://download.pytorch.org/whl/cpu \
        torch==2.4.1 torchaudio==2.4.1 \
 && pip install --no-cache-dir \
        fastapi==0.115.0 \
        "uvicorn[standard]==0.30.6" \
        pydantic==2.9.2 \
        zstandard==0.23.0 \
        numpy==1.26.4 \
        transformers==4.44.2 \
        accelerate==0.34.2

COPY app.py .

# Pre-download the model at build time so the first request doesn't wait
# on an uncached HF download. The model weights are ~400 MB on disk.
RUN python -c "from transformers import AutoModel, Wav2Vec2FeatureExtractor; \
    AutoModel.from_pretrained('m-a-p/MERT-v1-95M', trust_remote_code=True); \
    Wav2Vec2FeatureExtractor.from_pretrained('m-a-p/MERT-v1-95M', trust_remote_code=True)"

EXPOSE 8448

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:8448/health || exit 1

CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8448"]
