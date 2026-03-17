@echo off
REM ─── Zman Deploy — push to GitHub ────────────────────────────────────────

echo [1/2] Setting remote...
git remote add origin https://github.com/alon0581/zman.git 2>nul || git remote set-url origin https://github.com/alon0581/zman.git

echo [2/2] Pushing to GitHub...
git push -u origin main

echo.
echo Done! Now go to: https://railway.app
echo and follow the steps in RAILWAY_ENV.txt
pause
