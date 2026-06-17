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

# clear all
scripts/clear-codeindex.sh

# Unblock-File .\scripts\publish-codeindex.ps1

powershell -ExecutionPolicy Bypass -File .\scripts\publish-codeindex.ps1 -Repository C:/www/rxo/platform/Rxo.Platform.Web.Sandbox
powershell -ExecutionPolicy Bypass -File .\scripts\publish-codeindex.ps1 -Repository C:/www/Agent.Local
powershell Remove-Item -Recurse -Force .\src\codeindex\data; Remove-Item -Recurse -Force .\src\codemcp\data;
    scripts/publish-codeindex.sh -Repository /Applications/www/Agent.Local
    
    scripts/publish-codeindex.sh -Repository /Applications/www/rxoinc/platform/Rxo.Platform.Web.Sandbox
# .\scripts\publish-codeindex.ps1  -Repository C:/www/rxo/platform/Rxo.Platform.Web.Sandbox

npm run start --session 3bd1817e-d563-43b2-a6db-771811411913

npm run start -- --run "create hello_world.txt as background task"
npm run start -- --run "any files in workspace" --session 3bd1817e-d563-43b2-a6db-771811411913
npm run start -- --run "list me files in workspace" --session 3bd1817e-d563-43b2-a6db-771811411913
npm run start -- --run "remove hello_world.txt file as background task" 3bd1817e-d563-43b2-a6db-771811411913
npm run start -- --run "delay as background task for 2 min poll until done" 3bd1817e-d563-43b2-a6db-771811411913

# integ test
powershell -ExecutionPolicy Bypass -File .\scripts\e2e-headless.ps1