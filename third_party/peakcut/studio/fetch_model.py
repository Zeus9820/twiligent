"""Download the speech-to-text model once, if it is not already in the models folder.
Run with:  python -m studio.fetch_model"""
import tarfile
import urllib.request

from . import config

URL = f"https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/{config.ASR_MODEL_NAME}.tar.bz2"


def main():
    if (config.ASR_MODEL_DIR / "tokens.txt").exists():
        print("Speech model already present.")
        return
    config.MODELS_DIR.mkdir(parents=True, exist_ok=True)
    tmp = config.MODELS_DIR / "parakeet.tar.bz2"
    print("Downloading the speech model (480 MB to 1.1 GB)...")
    urllib.request.urlretrieve(URL, tmp)
    with tarfile.open(tmp, "r:bz2") as t:
        for m in t.getmembers():  # only plain files and folders that stay inside the models folder
            if (m.isfile() or m.isdir()) and not m.name.startswith(("/", "..")) and ".." not in m.name.split("/"):
                t.extract(m, config.MODELS_DIR)
    tmp.unlink()
    print("Speech model ready.")


if __name__ == "__main__":
    main()
