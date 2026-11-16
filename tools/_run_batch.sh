#!/bin/bash
cd "$(dirname "$0")/.."
for i in $(seq 1 60); do
  n=$(ls tools/_sbaudio/*.mp3 2>/dev/null | wc -l)
  if [ "$n" -ge 56 ]; then break; fi
  sleep 20
done
node -e "
const fs=require('fs');
const ids=fs.readdirSync('tools/_sbaudio').filter(f=>f.endsWith('.mp3')).map(f=>f.replace('.mp3',''))
 .filter(id=>fs.existsSync('tools/_sbmaps/'+id+'.json'));
fs.writeFileSync('tools/_ids.json', JSON.stringify(ids)); console.log('ids', ids.length);"
node tools/cdp.mjs eval "http://127.0.0.1:8777/tools/selftest.html" tools/batch-eval.js 2>/dev/null | grep '^{"rows' > tools/_batch.json
node tools/batch-report.mjs > tools/_batch_report.txt 2>&1
echo "BATCH_DONE $(wc -c < tools/_batch.json) bytes"
