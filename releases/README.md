# 📦 releases — готовые сборки AVC-Anime (portable EXE для Windows)

**Важно:** сам `.exe` в git не коммитится — GitHub жёстко ограничивает файлы в
репозитории 100 МБ (сборка весит ~385 МБ). Поэтому EXE публикуется в
**GitHub Releases** — оттуда он скачивается одним кликом, без авторизации.

## ⬇️ Скачать последнюю сборку

**Постоянная ссылка (всегда последний релиз):**

> https://github.com/HellShaftSam/AVC-AnimeVoiceCommand/releases/latest

Или вручную: вкладка **Releases** → последний релиз → **Assets** →
`AVC-Anime-Portable-<версия>.exe`.

Альтернативно — PowerShell-скрипт в этой папке: `.\download-exe.ps1`
(сам найдёт последний релиз через GitHub API и скачает EXE).

## 🗂 Что здесь лежит

| Файл | Назначение |
|---|---|
| `README.md` | этот файл |
| `VERSION.txt` | манифест последней собранной версии: имя файла, размер, SHA-256, дата, коммит |
| `download-exe.ps1` | PowerShell-скрипт скачивания последнего EXE без авторизации |

## ✅ Проверка подлинности (SHA-256)

SHA-256 каждой сборки записан в `VERSION.txt`. Проверка на Windows:

```powershell
Get-FileHash AVC-Anime-Portable-1.1.0.exe -Algorithm SHA256
```

Совпадение хэша = файл не повреждён и подлинно собран из этого репозитория.

## 🚀 Как запускать

1. Скачать `AVC-Anime-Portable-<версия>.exe` из Releases.
2. Запустить — установка не требуется (portable, один файл).
3. Данные (настройки, сессия сайта, история команд) хранятся в профиле
   пользователя (`%APPDATA%/avc-anime`), в папке рядом с EXE ничего не создаётся.

Сборка делается автоматически при каждом обновлении `main` — workflow
`.github/workflows/build-exe.yml` (Build Windows EXE) публикует новый релиз.

## 🔨 Как собрать локально (без CI)

```bash
npm install                      # корень (Next.js UI)
npx prisma generate              # binaryTargets: native + windows
npm run build                    # → .next/standalone
cd electron-app
npm install
node ../scripts/validate-ai-assets.mjs   # проверка URL моделей
# Node-рантайм для AI-воркера (win):
#   скачать https://nodejs.org/dist/v22.11.0/node-v22.11.0-win-x64.zip
#   → electron-app/runtime-node/node.exe
node ../scripts/assemble-ai-pack.mjs     # → ai-pack/ (на Windows сам возьмёт win-бинарники)
npx electron-builder --win portable --config electron-builder.json --publish never
# → dist/AVC-Anime-Portable-1.1.0.exe
```

На Linux wine не нужен: `electron-app/build/afterpack.cjs` прописывает иконку и
VERSIONINFO в EXE через pure-JS `resedit` (см. комментарии в файле).
