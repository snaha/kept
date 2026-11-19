"""Export an OpenL3 audio backbone (mel128 or mel256, music, 512-d) to ONNX.

Weights: torchopenl3 port of the official OpenL3 weights
https://github.com/torchopenl3/torchopenl3-models (Apache-2.0 repository; the
weights derive from marl/openl3, CC BY 4.0, Cramer et al. 2019).

The graph takes the decibel mel spectrogram [N, 1, mels, 199]; the mel frontend is
reimplemented in src/openl3.js from the mel basis written next to the model.
The mel count is read from the weight file.
Usage: python export-openl3.py <weights.pth.tar> <out-dir> [reference-models.py]
"""
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

CHANNELS = [1, 64, 64, 128, 128, 256, 256, 512]
POOL_AFTER = {2, 4, 6}
EMBEDDING_POOL = {128: (16, 24), 256: (32, 24)}
BN_EPS = 0.001


class Backbone(nn.Module):
    def __init__(self, mels):
        super().__init__()
        self.pool = EMBEDDING_POOL[mels]
        self.batch_normalization_1 = nn.BatchNorm2d(1, eps=BN_EPS)
        for i in range(1, 8):
            setattr(self, f"conv2d_{i}", nn.Conv2d(CHANNELS[i - 1], CHANNELS[i], 3, padding=1))
            setattr(self, f"batch_normalization_{i + 1}", nn.BatchNorm2d(CHANNELS[i], eps=BN_EPS))
        self.audio_embedding_layer = nn.Conv2d(512, 512, 3, padding=1)

    def forward(self, x):
        x = self.batch_normalization_1(x)
        for i in range(1, 8):
            x = F.relu(getattr(self, f"batch_normalization_{i + 1}")(getattr(self, f"conv2d_{i}")(x)))
            if i in POOL_AFTER:
                x = F.max_pool2d(x, 2)
        x = F.max_pool2d(self.audio_embedding_layer(x), self.pool)
        return x.flatten(1)


def main():
    weights, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    state = torch.load(weights, map_location="cpu", weights_only=True)
    mel_basis = state["speclayer.mel_basis"].numpy().astype("<f4")
    mels = mel_basis.shape[0]
    model = Backbone(mels)
    model.load_state_dict({k: v for k, v in state.items() if not k.startswith("speclayer.")})
    model.eval()
    torch.onnx.export(
        model, torch.zeros(1, 1, mels, 199), str(out_dir / f"openl3-mel{mels}-music-512.onnx"),
        input_names=["melspectrogram"], output_names=["embedding"],
        dynamic_axes={"melspectrogram": {0: "batch"}, "embedding": {0: "batch"}},
        opset_version=17, dynamo=False,
    )
    mel_basis.tofile(out_dir / f"openl3-mel{mels}-basis.f32")
    print("mel basis", mel_basis.shape, "written")

    if len(sys.argv) > 3:
        # Parity fixture: run the reference torchopenl3 model (frontend included) on a fixed signal.
        import importlib.util
        import types
        sys.modules["torchopenl3"] = types.ModuleType("torchopenl3")
        sys.modules["torchopenl3.core"] = types.ModuleType("torchopenl3.core")
        spec = importlib.util.spec_from_file_location("reference_models", sys.argv[3])
        reference = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(reference)
        full = reference.PytorchOpenl3("music", f"mel{mels}", 512)
        full.load_state_dict(state)
        full.eval()
        rng = np.random.default_rng(7)
        t = np.arange(48000) / 48000
        audio = (0.4 * np.sin(2 * np.pi * 220 * t) + 0.2 * np.sin(2 * np.pi * 1760 * t * (1 + 0.1 * t))
                 + 0.05 * rng.standard_normal(48000)).astype("<f4")
        with torch.no_grad():
            x = torch.from_numpy(audio).reshape(1, 1, -1)
            mel = full.speclayer(x).squeeze(-1).unsqueeze(1)
            embedding = full(x)
            assert torch.allclose(model(mel), embedding, atol=1e-4)
        audio.tofile(out_dir / f"parity-mel{mels}-audio.f32")
        mel.numpy().astype("<f4").tofile(out_dir / f"parity-mel{mels}-mel.f32")
        embedding.numpy().astype("<f4").tofile(out_dir / f"parity-mel{mels}-embedding.f32")
        print("parity fixture written")


main()
