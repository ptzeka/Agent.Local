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

npm run start -- --run "create hello_world.txt as background task" --session 6538c999-82f1-467f-8378-f30528d3f40c
npm run start -- --run "read me hello_world.txt content" --session 9e13514c-4828-46ea-9878-adb18635a276
npm run start -- --run "remove hello_world.txt as background task" --session 9e13514c-4828-46ea-9878-adb18635a276