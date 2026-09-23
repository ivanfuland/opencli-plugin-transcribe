"""faster-whisper runner for opencli-plugin-transcribe.

Writes <output_dir>/<audio stem>.json in the same shape as the openai-whisper CLI
(`{"text", "segments": [{"id", "start", "end", "text"}], "language"}`), so _whisper.ts
parses both backends the same way.

Decoding matches the openai-whisper CLI defaults the plugin relied on: beam size 5,
no VAD, language auto-detected unless --language is given.
"""
import argparse
import ctypes
import glob
import importlib.util
import json
import os
import sys


def preload_cuda_libs():
    """Load cuBLAS / cuDNN from the nvidia-* pip wheels, if installed.

    CTranslate2 dlopens libcublas.so.12 and libcudnn*.so.9 by soname. The wheels put them in
    site-packages, which is not on the loader path, and LD_LIBRARY_PATH cannot be changed from
    inside a running process. Loading them here with RTLD_GLOBAL makes the later dlopen succeed.
    """
    for pkg in ("nvidia.cublas", "nvidia.cudnn"):
        try:
            spec = importlib.util.find_spec(pkg)
        except ModuleNotFoundError:
            continue
        if spec is None or not spec.submodule_search_locations:
            continue
        lib_dir = os.path.join(list(spec.submodule_search_locations)[0], "lib")
        for so in sorted(glob.glob(os.path.join(lib_dir, "lib*.so*"))):
            try:
                ctypes.CDLL(so, mode=ctypes.RTLD_GLOBAL)
            except OSError as err:
                print(f"[faster-whisper] could not preload {so}: {err}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("--model", required=True)
    parser.add_argument("--output_dir", required=True)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--compute_type", default="int8_float16")
    parser.add_argument("--language", default=None)
    args = parser.parse_args()

    compute_type = args.compute_type
    if args.device == "cpu" and "float16" in compute_type:
        # float16 kernels are GPU-only in CTranslate2
        compute_type = "int8"

    if args.device == "cuda":
        preload_cuda_libs()
    from faster_whisper import WhisperModel

    model = WhisperModel(args.model, device=args.device, compute_type=compute_type)
    segments, info = model.transcribe(args.audio, beam_size=5, vad_filter=False, language=args.language)
    rows = [
        {"id": i, "start": s.start, "end": s.end, "text": s.text}
        for i, s in enumerate(segments)
    ]

    stem = os.path.splitext(os.path.basename(args.audio))[0]
    out_path = os.path.join(args.output_dir, f"{stem}.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(
            {"text": "".join(r["text"] for r in rows), "segments": rows, "language": info.language},
            f,
            ensure_ascii=False,
        )


if __name__ == "__main__":
    main()
