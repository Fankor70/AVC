# download-exe.ps1 — скачивание последней сборки AVC-Anime из GitHub Releases.
# Работает без авторизации (репозиторий публичный; GitHub API rate limit: 60 запросов/час).
# Запуск:  powershell -ExecutionPolicy Bypass -File .\download-exe.ps1

$ErrorActionPreference = 'Stop'
$repo = 'HellShaftSam/AVC-AnimeVoiceCommand'

Write-Host "AVC-Anime: поиск последнего релиза..." -ForegroundColor Cyan
$rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" `
    -Headers @{ 'User-Agent' = 'AVC-Anime-downloader' }

$asset = $rel.assets | Where-Object { $_.name -like '*.exe' } | Select-Object -First 1
if (-not $asset) { throw "В релизе $($rel.tag_name) нет .exe файла" }

Write-Host ("Релиз: {0}  |  Файл: {1}  |  {2:N1} МБ" -f $rel.tag_name, $asset.name, ($asset.size/1MB))
$out = Join-Path (Get-Location) $asset.name
Write-Host "Скачиваю в $out ..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $out -UserAgent 'AVC-Anime-downloader'

# Проверка SHA-256, если в релизе приложен SHA256SUMS.txt
$sums = $rel.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' } | Select-Object -First 1
if ($sums) {
    $tmp = Join-Path $env:TEMP 'AVC-SHA256SUMS.txt'
    Invoke-WebRequest -Uri $sums.browser_download_url -OutFile $tmp -UserAgent 'AVC-Anime-downloader'
    $expected = ((Get-Content $tmp) | Where-Object { $_ -match $asset.name }) -replace '\s.*$', ''
    if ($expected) {
        $actual = (Get-FileHash $out -Algorithm SHA256).Hash.ToLower()
        if ($actual -eq $expected.ToLower()) {
            Write-Host "SHA-256 совпадает: $actual" -ForegroundColor Green
        } else {
            Write-Warning "SHA-256 НЕ совпадает! Ожидалось $expected, получено $actual"
        }
    }
}

Write-Host "Готово: $out" -ForegroundColor Green
