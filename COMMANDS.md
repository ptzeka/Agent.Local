# ollama serve
# ollama serve &>/tmp/ollama.log &
# ollama pull qwen3-coder:30b-a3b-q4_K_M
# pkill -f "ollama serve"
# ollama pull qwen2.5-coder:14b
# ollama pull deepseek-r1:14b
# ollama pull llama3.2:3b
# ollama pull gemma3:4b
# npm run build
# npm start

# Unblock-File .\scripts\publish-codeindex.ps1

powershell -ExecutionPolicy Bypass -File .\scripts\publish-codeindex.ps1 -Repository C:/www/rxo/platform/Rxo.Platform.Web.Sandbox
# .\scripts\publish-codeindex.ps1  -Repository C:/www/rxo/platform/Rxo.Platform.Web.Sandbox

npm run start -- --run "create hello world txt as background task" --session 57c64770-8208-4a4b-9cda-111b723b3f22
