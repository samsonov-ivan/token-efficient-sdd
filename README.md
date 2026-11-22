# Frugal SDD

Frugal сравнивает обычный и оптимизированный процессы OpenSpec + OpenCode для одной и той же задачи. Прототип и его артефакты опубликованы в ветке `codex/frugal-integration`.

## Быстрый запуск

Подготовьте Git, Node.js 24.15.0, npm и Python 3.11+. После установки зависимостей демонстрация работает локально, без Docker и API-ключей.

```bash
git clone --depth 1 --branch codex/frugal-integration https://github.com/samsonov-ivan/token-efficient-sdd.git frugal
cd frugal
npm ci
npm run build
demo_dir=$(mktemp -d "${TMPDIR:-/tmp}/frugal-demo.XXXXXX")
node_modules/.bin/frugal run --mode paired --feature add-transfer-limits \
  --flag session_per_task --dry-run --series prototype --out "$demo_dir/runs"
node scripts/replay.mjs "$demo_dir/runs"
node_modules/.bin/frugal report "$demo_dir/runs" --out "$demo_dir/report"
printf '%s\n' "$demo_dir/report/REPORT.md" "$demo_dir/report/dashboard.html"
```

Откройте `REPORT.md` или `dashboard.html` по напечатанному пути. В `$demo_dir/runs` сохраняются манифесты и журналы обоих прогонов с моделью `mock/replay`. [Полная инструкция по запуску](https://github.com/samsonov-ivan/token-efficient-sdd/blob/codex/frugal-integration/README.md#запуск-прототипа) · [Запуск с реальной моделью](https://github.com/samsonov-ivan/token-efficient-sdd/blob/codex/frugal-integration/tools/runner/README.md)
