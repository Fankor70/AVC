#!/bin/bash
# Готовая цепочка релиза v1.0.20: пуш → ожидание CI → верификация релиза → закрытие issues.
# Использование: GH_TOKEN=<токен с Contents:Write + Issues:Write> bash release-chain.sh
set -e
REPO="HellShaftSam/AVC-AnimeVoiceCommand"
: "${GH_TOKEN:?Нужен GH_TOKEN с правами Contents:Write + Issues:Write}"
cd /home/z/my-project

echo "=== 1. PUSH ==="
git push "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git" main 2>&1 | tail -2

echo "=== 2. Ожидание CI run #20 (~15 мин) ==="
for i in $(seq 1 60); do
  sleep 30
  STATUS=$(curl -s -H "Authorization: Bearer $GH_TOKEN" \
    "https://api.github.com/repos/${REPO}/actions/runs?per_page=1" | jq -r '.workflow_runs[0].status + ":" + (.workflow_runs[0].conclusion // "pending")')
  echo "  [$i] $STATUS"
  case "$STATUS" in
    "completed:success") echo "CI SUCCESS"; break ;;
    "completed:"*) echo "CI FAILED — смотреть логи"; exit 1 ;;
  esac
done

echo "=== 3. Верификация релиза v1.0.20 ==="
curl -s -H "Authorization: Bearer $GH_TOKEN" "https://api.github.com/repos/${REPO}/releases/latest" | \
  jq -r '"tag: \(.tag_name)\nassets: \([.assets[] | "\(.name) (\(.size)B)"] | join(", "))"'

echo "=== 4. Комментарий и закрытие issues #1, #2 ==="
for N in 1 2; do
  curl -s -X POST -H "Authorization: Bearer $GH_TOKEN" -H "Content-Type: application/json" \
    -d "{\"body\": $(jq -Rs . < /tmp/issue-comments/issue${N}.md)}" \
    "https://api.github.com/repos/${REPO}/issues/${N}/comments" | jq -r '.html_url // "COMMENT FAILED"'
  curl -s -X PATCH -H "Authorization: Bearer $GH_TOKEN" -H "Content-Type: application/json" \
    -d '{"state":"closed","state_reason":"completed"}' \
    "https://api.github.com/repos/${REPO}/issues/${N}" | jq -r '"issue #'\''$N'\'' state: \(.state)"'
done
echo "=== ГОТОВО ==="
