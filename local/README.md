# Local engine (TRELLIS)

Flatform's free engine runs Microsoft TRELLIS (MIT license, open weights) on your NVIDIA card.

One-time setup on the PC:

1. Install Python 3.10 or newer and PyTorch with CUDA.
2. Install TRELLIS from https://github.com/microsoft/TRELLIS (follow its setup script).
3. In Flatform, open Settings and click **Download local engine**. The weights (about 3.3 GB) go to the folder shown
   there. A stopped download picks up where it left off.

Flatform starts `trellis_service.py` when you generate with **Local (free)** and stops it when the app closes.
Local generations are logged in the spend ledger at $0.

## Detail Boost (free, local)

Turned on by the "Max detail" preset, the Detail Boost toggle, and always by the base path that Generate Spin Set uses.
After TRELLIS makes the model, `detail_boost.py` upscales the texture with Real-ESRGAN x4plus (BSD-3-Clause, downloaded
with the engine, 64 MB), builds a height and normal map from the photo-baked texture, and projects the height onto the
mesh. Extra Python packages: `pip install trimesh realesrgan basicsr`. Without `realesrgan` it falls back to a Lanczos
resize. No step calls Tripo or 3D AI Studio.
