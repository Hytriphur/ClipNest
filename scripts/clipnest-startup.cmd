@echo off
cd /d "G:\projects\x-image-collector"
set XIC_LOG_LEVEL=info && set PORT=5174 && set XIC_PROXY=http://127.0.0.1:7890
start "ClipNest Server" /min "D:\Program Files\nodejs\node.exe" "G:\projects\x-image-collector\apps\\server\\dist\\index.js"
start "ClipNest Web" /min "D:\Program Files\nodejs\node.exe" "G:\projects\x-image-collector\node_modules\\vite\\bin\\vite.js" preview -w apps/web --host 127.0.0.1 --port 5173
exit /b 0
