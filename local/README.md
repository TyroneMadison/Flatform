# Local engine (TRELLIS)

Flatform's free engine runs Microsoft TRELLIS (MIT license, open weights) on your NVIDIA card.

One-time setup on the PC:

1. Install Python 3.10 or newer and PyTorch with CUDA.
2. Install TRELLIS from https://github.com/microsoft/TRELLIS (follow its setup script).
3. In Flatform, open Settings and click **Download local engine**. The weights (about 3.3 GB) go to the folder shown
   there. A stopped download picks up where it left off.

Flatform starts `trellis_service.py` when you generate with **Local (free)** and stops it when the app closes.
Local generations are logged in the spend ledger at $0.
