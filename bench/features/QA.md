# Независимая приёмка WP-01

В рабочей ветке координатора хранятся публичные контракты, автономный снимок minibank и сводки. Скрытые сценарии хранятся в локальной ветке `codex/frugal-oracle`. Служебные версии независимых эталонов и контрольных дефектов находятся в отдельном пространстве ссылок `refs/frugal-qa/`. В измеряемом checkout используется только `bench/repos/minibank.bundle`.

Проверяющий открывает отдельный checkout **вне** проекта. У каталогов QA и результатов должны быть отдельные права доступа от исполнителя SDD. Создание worktree само по себе не ограничивает чтение по абсолютным путям. Файлы `hidden_tests/`, QA-ссылки, отчёты pytest и их XML доступны только проверяющему. Они подключаются проверяющей средой после остановки исполнителя на зафиксированном коммите.

```sh
umask 077
qa_parent=$(mktemp -d)
git worktree add --detach "$qa_parent/oracle" codex/frugal-oracle
```

Для переноса между машинами владелец исходного служебного репозитория отдельно создаёт закрытый QA-bundle. Передавать его можно только оценщику. На машине оценщика первый блок выполняется **до** создания его worktree.

```sh
# Экспорт из локального репозитория, содержащего закрытые ссылки, в каталог оценщика.
git for-each-ref --format='%(refname)' refs/frugal-qa refs/heads/codex/frugal-oracle \
  | git bundle create "$qa_parent/private-qa.bundle" --stdin
# Импорт из полученного закрытого файла в служебный репозиторий оценщика.
git fetch --no-tags "$qa_parent/private-qa.bundle" \
  'refs/frugal-qa/*:refs/frugal-qa/*' \
  refs/heads/codex/frugal-oracle:refs/heads/codex/frugal-oracle
```

Публичные исходники содержат `uv.lock`. Выполните в рабочей ветке координатора `uv sync --frozen --project bench/repos/minibank` и используйте её интерпретатор для автономной QA. Каждая проверка создаёт новую рабочую копию ровно одного коммита, выполняет штатную регрессию и только после этого подключает скрытые тесты.

```sh
python_bin="$PWD/bench/repos/minibank/.venv/bin/python"
output=$(mktemp -d)
ref_root=refs/frugal-qa/wp01-release
for size in small medium large; do
  case "$size" in
    small) feature=export-history-csv ;;
    medium) feature=add-transfer-limits ;;
    large) feature=multicurrency-accounts ;;
  esac
  set -- red green mutant
  if [ "$size" = medium ]; then set -- "$@" mutant-stale-rules; fi
  for control in "$@"; do
    case "$control" in
      red) ref=reference-base; verdict=red ;;
      green) ref=reference-$size; verdict=green ;;
      mutant) ref=mutant-$size; verdict=mutant ;;
      mutant-stale-rules) ref=mutant-medium-stale-rules; verdict=mutant ;;
    esac
    "$python_bin" "$qa_parent/oracle/analysis/replay_oracle.py" --feature "$feature" \
      --repo . --rev "$ref_root/$ref" --expect "$verdict" \
      --out "$output/$size-$control" || exit 1
  done
done
"$python_bin" analysis/summarize_oracle.py "$output" "$output/summary.json"
```

В каталоге оценщика остаются исходные XML, полные логи pytest, идентификаторы тестов и хеш файлов приёмки. `red` требует падения каждого теста на базе. `green` требует прохождения всех тестов на эталоне. `mutant` требует хотя бы одного падения при подстановке преднамеренного дефекта. Для каждого варианта проверяется полная зелёная регрессия, а также отсутствие пропусков и ошибок исполнения тестов. Сводка сверяет списки идентификаторов, хеш оракула и общий снимок базы. Координатор получает только агрегаты, хеши и ссылки на закрытый архив оценщика.


Разрешённые к передаче агрегаты финальной версии расположены в [контрольной сводке](../runs/summary/qa-wp01-release.json). Для полного закрытого архива используется локальная ссылка `refs/frugal-qa/wp01-release/evidence`. Проверяющий может извлечь из неё `qa-wp01-release/<вариант>/result.json` и сверить его SHA-256 со сводкой.
