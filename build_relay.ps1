$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

python -m PyInstaller --noconfirm --clean --onefile --windowed --name OBS-Multistream-Relay .\relay_app.py
