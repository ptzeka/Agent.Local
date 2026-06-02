# ollama pull qwen2.5-coder:14b
# ollama pull deepseek-r1:14b
# ollama pull llama3.2:3b
# ollama pull qwen2.5:7b
# npm run build
# npm start

# Unblock-File .\scripts\publish-codeindex.ps1

powershell -ExecutionPolicy Bypass -File .\scripts\publish-codeindex.ps1 -Repository C:/www/rxo/platform/Rxo.Platform.Web.Sandbox
# .\scripts\publish-codeindex.ps1  -Repository C:/www/rxo/platform/Rxo.Platform.Web.Sandbox