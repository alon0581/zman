@echo off
REM ─── Zman Deploy Script ───────────────────────────────────────────────────
REM Run this once to push to GitHub.
REM Replace GITHUB_USERNAME with your actual GitHub username.

set GITHUB_USERNAME=REPLACE_ME

echo.
echo [1/3] Setting remote...
git remote add origin https://github.com/%GITHUB_USERNAME%/zman.git 2>nul || git remote set-url origin https://github.com/%GITHUB_USERNAME%/zman.git

echo [2/3] Pushing to GitHub...
git push -u origin main

echo.
echo Done! Now go to railway.app and follow the setup.
pause
