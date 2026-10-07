#!/usr/bin/env bash
# Копирует веб-приложение внутрь APK (apk/www). Запускается из папки apk/.
# Использование: scripts/build-web.sh <номер_сборки>
set -euo pipefail
BUILD="${1:-0}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WWW="$(cd "$(dirname "$0")/.." && pwd)/www"
mkdir -p "$WWW"
find "$WWW" -mindepth 1 -delete
cp "$ROOT"/index.html "$ROOT"/styles.css "$ROOT"/manifest.webmanifest "$ROOT"/*.js "$WWW"/
cp -r "$ROOT"/icons "$ROOT"/vendor "$WWW"/
# Версия сборки — для проверки обновлений внутри приложения.
printf '{"build": %s}\n' "$BUILD" > "$WWW"/version.json
echo "www: $(du -sh "$WWW" | cut -f1), build $BUILD"
