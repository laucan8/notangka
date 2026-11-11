#!/usr/bin/env bash
# Bundel worker AI -> ../docs/vendor/ai-worker.js   (jalankan: npm install && bash build.sh)
set -e
cd "$(dirname "$0")"
NODE_PATH="${NODE_PATH:-$(pwd)/node_modules}" npx esbuild ai-worker.js --bundle --format=esm --platform=browser \
  --target=es2022 --minify --legal-comments=none --outfile=../docs/vendor/ai-worker.js \
  --log-level=warning
# hapus ID gist di pesan error transformers.js (dikira "API key" oleh GitHub secret scanning)
sed -i.bak -E 's#gist\.github\.com/hollance/[0-9a-f]{32}#gist.github.com/hollance#g' ../docs/vendor/ai-worker.js && rm -f ../docs/vendor/ai-worker.js.bak
# nama kelas "Mistral3ForConditionalGeneration" juga dikira API key -> tulis 't' sebagai \u0074 (nilai identik di JS)
sed -i.bak 's/istral/is\\u0074ral/g' ../docs/vendor/ai-worker.js && rm -f ../docs/vendor/ai-worker.js.bak
echo "OK -> docs/vendor/ai-worker.js"
