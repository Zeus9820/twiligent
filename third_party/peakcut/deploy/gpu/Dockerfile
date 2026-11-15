# The speech-to-text machine: the same code, built for a graphics card (NVIDIA, CUDA 12).
# Build from the project root:  docker build -f deploy/gpu/Dockerfile -t peakcut-asr .
FROM python:3.11-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates bzip2 libasound2 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
# everything the app needs, with the graphics-card build of the speech library and the NVIDIA libraries it loads
RUN grep -v '^sherpa-onnx' requirements.txt > r.txt \
 && pip install --no-cache-dir -r r.txt \
 && pip install --no-cache-dir "sherpa-onnx==2.0.1+cuda12.cudnn9.onnxruntime1.28.2" -f https://k2-fsa.github.io/sherpa/onnx/cuda.html \
 && pip install --no-cache-dir nvidia-cublas-cu12 "nvidia-cudnn-cu12>=9,<10" nvidia-cufft-cu12 nvidia-curand-cu12 \
      nvidia-cuda-runtime-cu12 nvidia-cuda-nvrtc-cu12 nvidia-nvjitlink-cu12
COPY studio studio

ENV N=/usr/local/lib/python3.11/site-packages/nvidia
ENV LD_LIBRARY_PATH=$N/cublas/lib:$N/cudnn/lib:$N/cufft/lib:$N/curand/lib:$N/cuda_runtime/lib:$N/cuda_nvrtc/lib:$N/nvjitlink/lib \
    PEAKCUT_DATA=/data \
    PEAKCUT_ASR_PROVIDER=cuda \
    PEAKCUT_ASR_MODEL=sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-fp16 \
    PYTHONUNBUFFERED=1
VOLUME /data
EXPOSE 9000
HEALTHCHECK --interval=30s --timeout=5s --start-period=600s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:9000/healthz', timeout=4)"
# the first start downloads the speech model into /data/models (about 1.1 GB)
CMD ["sh", "-c", "python -m studio.fetch_model && python -m studio.asr_worker"]
