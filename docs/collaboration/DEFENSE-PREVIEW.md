# Frugal SDD · комплект для показа прототипа

[Скачать готовый архив для команды](defense-preview.zip). SHA-256 сборки `55baab62ff11652b4ffc3af4fc8a36f26236ac47d4f177a5f0908a0c44cfe36b`. Внутри запись длительностью 1 минута 57 секунд, отчёт, дашборд, журналы и контрольные суммы.

Откройте `prototype.mp4` для показа без звука. В `dashboard.html` можно перейти к манифестам обоих плеч, а в `REPORT.md` — сверить их модель, статус и учтённые вызовы. Все файлы открываются локально. При переносе сохраните каталог `runs/` рядом с дашбордом.

В записи показана реализация двух открытых задач. Вторая получает результат первой через handoff. После исправления замечания ревьюер проверяет изменившийся участок, затем ещё раз весь снимок. Этап verify проверяет этот же Git tree. Исходные промпты и решения каждого раунда лежат в `runs/prototype-1-opt-a1/opt/`.

В парной репетиции `mock/replay` выдаёт синтетический usage. `replay.jsonl` содержит результат его независимого пересчёта по сохранённым событиям. Для оценки экономии на полной фиче нужны принятые живые пары. Отдельно `compression.json` показывает, сколько символов вывода Git передали в следующий запрос нативные OpenCode V1 и V2. Поле `recovered` и совпадающие SHA-256 подтверждают чтение полного вывода инструментом.

## Воспроизведение из чистого клона

Для этой сборки используйте Node из `.node-version`, Git, Python 3.11+, jq, sqlite3, FFmpeg с libx264 и ffprobe. Рендер использует системные шрифты с кириллицей. На Linux подходят DejaVu Sans и DejaVu Sans Mono, на macOS — Helvetica Neue и Menlo. Исходная версия показа зафиксирована коммитом `b0ae6e100356277f9ec13248a1db2f0f5062a63c`.

```sh
git clone --branch codex/frugal-friend https://github.com/samsonov-ivan/token-efficient-sdd.git frugal-preview
cd frugal-preview
git checkout --detach b0ae6e100356277f9ec13248a1db2f0f5062a63c
node --version  # v24.15.0
npm ci
npm run setup:v2
npm run build
```

Команды ниже рассчитаны на POSIX-оболочку. Для создания окружения подставьте доступный Python 3.11+ вместо `python3.12`. Установка зависимостей требует пакетных реестров. Оплачиваемые модели и ключи для показа не нужны.

```sh
set -eu
preview=$(mktemp -d "${TMPDIR:-/tmp}/frugal-preview.XXXXXX")
video_env=$(mktemp -d "${TMPDIR:-/tmp}/frugal-video-env.XXXXXX")
python3.12 -m venv "$video_env"
"$video_env/bin/python" -m pip install 'pillow==12.2.0'
export PATH="$video_env/bin:$PATH"

source_runs=$(node scripts/run-prototype.mjs)
mkdir "$preview/runs"
for arm in prototype-1-base-a1 prototype-1-opt-a1; do
  mkdir "$preview/runs/$arm"
  # Для пересчёта достаточно архива без локальной записи о процессе.
  (cd "$source_runs/$arm" && tar --exclude=owner.json -cf - .) |
    (cd "$preview/runs/$arm" && tar -xf -)
done
node scripts/replay.mjs "$preview/runs" > "$preview/replay.jsonl"
node scripts/probe-compression.mjs "$preview/compression.json"
python analysis/record_demo.py "$preview/runs" --prototype prototype-1 \
  --h03 "$preview/compression.json" --out "$preview/prototype.mp4"
node_modules/.bin/frugal report "$preview/runs" --out "$preview"
ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name,width,height,pix_fmt,avg_frame_rate,nb_frames,duration:format=size \
  -of json "$preview/prototype.mp4" > "$preview/video-check.json"
ffmpeg -v error -xerror -nostdin -i "$preview/prototype.mp4" -f null -
printf '%s\n' "$preview"
```

В готовом ZIP есть файл `SHA256SUMS`. Из распакованного каталога команда `shasum -a 256 -c SHA256SUMS` проверяет целостность комплекта.

Новая сборка создаёт собственные временные пути, идентификаторы сессий и метки времени. Чтобы проверить именно сохранённый комплект, укажите его распакованный каталог в переменной `preview`. Из корня собранного клона запустите команды ниже. Они проверяют все исходные хеши учёта, сверяют `calls.jsonl`, `stages.csv`, `meter.json` и заново генерируют отчёт с относительными ссылками.

```sh
node scripts/replay.mjs "$preview/runs" > "$video_env/replay-check.jsonl"
cmp "$preview/replay.jsonl" "$video_env/replay-check.jsonl"
node_modules/.bin/frugal report "$preview/runs" --out "$preview"
ffmpeg -v error -xerror -nostdin -i "$preview/prototype.mp4" -f null -
```
