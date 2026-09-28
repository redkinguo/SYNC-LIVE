@echo off
cd /d "%~dp0"
python relay_app.py
if errorlevel 1 pause
