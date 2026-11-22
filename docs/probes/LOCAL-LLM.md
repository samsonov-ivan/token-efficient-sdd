# Пилоты H-01 на локальных моделях

**На публичном `yocto-queue` отдельная сессия второй задачи сократила расход стадии реализации на 16,2% и 17,8% в двух парах Qwen3.** Во всех четырёх плечах прошли 2 исходных и 8 новых проверок. Оба режима получали одинаковый абсолютный путь и одинаковую инструкцию передачи контекста. Результат относится к двум задачам на одном репозитории и одном профиле модели. Для конкурсной серии остаются открыты Ф0 и независимая приёмка. [Протокол и критерии допуска](../EXPERIMENTS.md#local-q3-path-20261122--точный-путь-в-публичном-задании)

## Qwen3 · реализация с точным путём к файлу

Единственное изменение текста исходной серии — указание пути к файлу для нативных инструментов чтения и редактирования. Тесты и права доступа совпадают с исходной серией. OpenCode 1.19.6 и модель сделали 34 запроса, каждый учтён по потоку сервера и событиям OpenCode. Каждая пара начинается с того же исходного дерева. Первая задача реализует `dequeueIf`. Вторая получает handoff и реализует `drainWhile`. В режиме shared сохраняется история первой задачи. В режиме fresh новая сессия читает записанный код из той же рабочей копии. В обоих режимах второй задаче потребовалось по три запроса в каждой паре. [События, задания, результаты десяти проверок и итоговые файлы](local-h01-qwen3-path.zip)

| Пара | Порядок | RPT shared | RPT fresh | Разница | Снижение за обе задачи | Публичные проверки |
|---|---|---:|---:|---:|---:|---|
| A | shared → fresh | 45 549 | 38 186 | 7 363 | 16,2% | 10/10 в обоих плечах |
| B | fresh → shared | 54 909 | 45 136 | 9 773 | 17,8% | 10/10 в обоих плечах |

Расчёт для каждой пары: `(shared − fresh) / shared`. Пара B потребовала по шесть обращений для первой задачи, пара A — по пять. Наблюдения зависят от хода работы модели даже при фиксированных настройках. Для повтора примените контроллер `9ad03db5ab43712445ee70197fc8881b6625c9dd`, добавьте к приведённой ниже команде apply параметр `--target-file queue.mjs` и используйте профиль Qwen3 на порту 18082. [Профиль и исходная серия](#qwen3--одинаковое-задание-два-порядка-исполнения)

## Qwen2.5 · две задачи и передача контекста

Входом служила MIT-реализация `yocto-queue` на снимке `72a8fa96a9d389765cdf2bb9c6daba8302fc375d`. Задача 1 добавляет условное снятие головы через `dequeueIf`. Задача 2 реализует `drainWhile` через результат первой. Обе стороны получают одинаковую инструкцию передачи. В режиме `shared` следующая задача продолжает сессию, в `fresh` получает новую. Порядок строк соответствует порядку исполнения внутри пары. RPT — сумма входных и выходных токенов. [Исходник и проверка поведения](../../scripts/fixtures/local-context-pilot/fixture.mjs) · [Оригинал проекта](https://github.com/sindresorhus/yocto-queue/tree/72a8fa96a9d389765cdf2bb9c6daba8302fc375d)

| Пара | Сессия | RPT задачи 1 | RPT задачи 2 | RPT всего | Исходные проверки | Новые проверки |
|---|---|---:|---:|---:|---:|---:|
| A | shared | 3474 | 3777 | 7251 | 2/2 | 0/8 |
| A | fresh | 3474 | 3502 | 6976 | 2/2 | 0/8 |
| B | fresh | 3472 | 3500 | 6972 | 2/2 | 0/8 |
| B | shared | 3472 | 3774 | 7246 | 2/2 | 0/8 |

Все восемь запросов дали завершённые ответы. В каждом модель вывела описание команды чтения текстом. OpenCode не получил структурированного вызова инструмента, и код очереди остался исходным. Независимый аудитор сверяет usage сервера с каждым событием `step_finish`, хешами запросов и идентификаторами сессий. [Запросы, ответы, тесты и манифесты пар](local-h01-qwen25.zip)

В полном запросе задачи 2 нашлись два сообщения из задачи 1, всего 1159 байт в представлении JSON. Если удалить ровно эти сообщения и сохранить остальные поля, байты запроса совпадут с фактически отправленным запросом свежей сессии. Повторное применение шаблона модели и токенизация дали 3708 → 3433 в A и 3706 → 3432 в B. Это объясняет разницу в размере конкретного входа. [Сводка с хешами](../../bench/runs/summary/local-h01-qwen-history/summary.json) · [Код пересчёта](../../scripts/attribute-pilot-history.mjs)

## Qwen2.5 · запуск полного конвейера

По отдельному брифу запустили штатные B0 и H-01. Оба завершились на первой стадии. После ответа модели отсутствовал обязательный `openspec/changes/queue-conditional-drain/proposal.md`. Реализация, ревью и финальная проверка модели не начались. На итоговом дереве независимый проверяющий процесс получил 2/2 исходных и 0/8 новых проверок в каждом плече. Полный цикл остаётся неподтверждённым. [Манифесты, события стадий, тесты и снимки](local-sdd-qwen25.zip)

| Плечо | Последняя стадия | Вход | Выход | Наблюдаемый RPT |
|---|---|---:|---:|---:|
| baseline | spec-0 | 10297 | 19 | 10316 |
| optimized | spec-0 | 10287 | 19 | 10306 |

## Qwen3 · одинаковое задание, два порядка исполнения

На контроллере `73e1758` модель Qwen3-4B-Instruct-2507 смогла выполнить нативный вызов OpenCode. В первой задаче все четыре плеча запросили `/queue.mjs` вне проекта. В свежих сессиях второй задачи модель успешно читала файл по относительному пути и затем получала ошибки при редактировании. В общей сессии модель отвечала на вторую задачу на основании предыдущего отказа. Проверки на четырёх финальных снимках дали 2/2 исходных и 0/8 новых. Расход ниже относится ко всем фактически сделанным запросам. [Протокол модели](../EXPERIMENTS.md#local-q3-20261122--повтор-на-другом-профиле-после-отказа-инструментов) · [Исходные события и снимки](local-h01-qwen3.zip)

| Пара | Порядок | RPT shared | RPT fresh | Запросов shared / fresh |
|---|---|---:|---:|---:|
| A | shared → fresh | 11 162 | 25 653 | 3 / 6 |
| B | fresh → shared | 11 171 | 46 128 | 3 / 10 |

Для повтора используйте те же флаги сервера, порт `18082`, ID `qwen3-4b-instruct-2507-q4-k-m`, файл `Qwen3-4B-Instruct-2507-Q4_K_M.gguf` (SHA-256 `3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597`) и поле `chat_template` из исходного токенизатора (SHA-256 извлечённого текста `64f85b198065d0fba2a81f37e10ed68161ce2c19a754c7100e67e0ca2ee9c326`). [Веса Unsloth](https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/tree/a06e946bb6b655725eafa393f4a9745d460374c9) · [Токенизатор Qwen](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507/blob/cdbee75f17c01a7cc42f958dc650907174af0554/tokenizer_config.json)

## Qwen3 · полный конвейер

Полную пару Qwen3 запустили по зарегистрированному условию после успешной реализации, на том же контроллере `1d9d86e`, что и Qwen2.5. В обоих плечах нативная стадия `spec` запросила установленный навык `openspec-propose`, инструмент вернул `ripgrep execution failed`. Модель завершила сессию до создания `proposal.md`. На обеих сторонах итог публичной проверки — API 2/2, новая функциональность 0/8. Для baseline подтверждены 2 обращения и 20 663 RPT, для optimized — 2 обращения и 20 720 RPT. Измерения стадии реализации выше не включают эти стадии полного цикла. [Оба исходных прогона, ответ инструмента и снимки](local-sdd-qwen3.zip)

После исправления контроллера в `270c3e9` OpenCode получил локальный ripgrep 15.2.0, SHA-256 `c9a2697f2b817d0a80e2b35f9c5ca1f58fa2c903418120f42fed60dcd9b0988e`. Нативное открытие навыка подтвердилось в обоих живых плечах. В каждом модель создала proposal, design и одну спецификацию. К концу десяти шагов файл `tasks.md` отсутствовал. Стадии реализации, ревью и verify не начались. Расход baseline — 169 464 RPT, optimized — 170 409 RPT, по десять запросов. Обе финальные копии прошли 2/2 исходных и 0/8 новых проверок. Следующая проверяемая гипотеза — отдельный увеличенный лимит шагов стадии spec с сохранением общего бюджета, требований и тестов. [Протокол](../EXPERIMENTS.md#local-q3-skill-20261122--повтор-после-восстановления-зависимости) · [События и файлы обеих попыток](local-sdd-qwen3-skill.zip)

## Офлайн-проверка с чистого клона

Из корня репозитория на macOS под Bash или zsh. Для пересчёта нужны Node ≥22.20 и Python ≥3.11. Архивы разложены в разные каталоги, у каждого свой `SHA256SUMS`.

```sh
proof_dir=$(mktemp -d)
for archive in local-h01-qwen25 local-sdd-qwen25 local-h01-qwen3 local-h01-qwen3-path local-sdd-qwen3 local-sdd-qwen3-skill; do
  unzip -q "docs/probes/$archive.zip" -d "$proof_dir/$archive" || exit 1
  (cd "$proof_dir/$archive" && shasum -a 256 --check --quiet SHA256SUMS) || exit 1
done
apply_root="$proof_dir/local-h01-qwen25"
python3 analysis/local_context_audit.py "$apply_root"/local-h01-qwen-20261122-{a,b}
node scripts/attribute-pilot-history.mjs --verify bench/runs/summary/local-h01-qwen-history \
  "$apply_root"/local-h01-qwen-20261122-{a,b}
python3 analysis/local_context_audit.py "$proof_dir/local-sdd-qwen25"/local-sdd-qwen25-20261122-{baseline,optimized}
python3 analysis/local_context_audit.py "$proof_dir/local-h01-qwen3"/local-h01-qwen3-20261122-{a,b}
python3 analysis/local_context_audit.py "$proof_dir/local-h01-qwen3-path"/local-h01-qwen3-path-20261122-{a,b}
python3 analysis/local_context_audit.py "$proof_dir/local-sdd-qwen3"/local-sdd-qwen3-20261122-{baseline,optimized}
python3 analysis/local_context_audit.py "$proof_dir/local-sdd-qwen3-skill"/local-sdd-qwen3-skill-20261122-{baseline,optimized}
# Для проверки поведения архивного кода на macOS нужны npm ci и npm run build.
node scripts/replay-local-quality.mjs "$proof_dir/local-h01-qwen3-path"/local-h01-qwen3-path-20261122-{a,b}
```

| ZIP | SHA-256 файла |
|---|---|
| `local-h01-qwen25.zip` | `123c217b992ee40208752b8ee945e2b274d9203825fb28b27985dd830f7693e4` |
| `local-sdd-qwen25.zip` | `3ca8e27f29e9db5f11e6dc828ad9a9912d73c99bfad8f14115925b93a70deeb8` |
| `local-h01-qwen3.zip` | `e255b6c0ca292494a7931815b98c4f52e9dac928b61ee24f375ad6030403124e` |
| `local-h01-qwen3-path.zip` | `3d69c87ac18bdcb79d547b3f911c5d3090d3df9600daf405d8d70d35cf501216` |
| `local-sdd-qwen3.zip` | `3f38b3f34e64f1c8a0e7be21b6e3df540e5dac3710a89fc83af59b9de5b442e1` |
| `local-sdd-qwen3-skill.zip` | `afb98e4c1a7af78b142683847c06bc56c62479081959f43ffa7aba109f81bff3` |

## Повтор с локальным инференсом на macOS

Использовали Apple M5 с 16 ГиБ, OpenCode V1 1.19.6, OpenSpec 2.1.1 и llama.cpp build 12359 (`b1b770d90d94cad9e9ea5b993bdbc383a522fb28`). Вызовы выполняются на loopback, дополнительные API-списания — $0. Скачайте `qwen2.5-coder-7b-instruct-q4_k_m.gguf` как `weights.gguf` и исходный `tokenizer_config.json` из указанных ревизий. [Веса Qwen](https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/tree/13fb94bfda8c8cf22497dc57b78f391a9acb426a) · [Шаблон из tokenizer_config.json](https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct/blob/c03e6d358207e414f1eca0bb1891e29f1db0e242/tokenizer_config.json) · [Версия сервера](https://github.com/ggml-org/llama.cpp/tree/b1b770d90d94cad9e9ea5b993bdbc383a522fb28)

```sh
python3 -c 'import json,pathlib; pathlib.Path("chat.jinja").write_bytes(json.loads(pathlib.Path("tokenizer_config.json").read_bytes())["chat_template"].encode())'
shasum -a 256 --check <<'SUMS'
509287f78cb4d4cf6b3843734733b914b2c158e43e22a7f4bf5e963800894d3c  weights.gguf
cd8e9439f0570856fd70470bf8889ebd8b5d1107207f67a5efb46e342330527f  chat.jinja
SUMS
llama-server --offline --model ./weights.gguf --alias qwen2.5-coder-7b-instruct-q4-k-m \
  --host 127.0.0.1 --port 18081 --ctx-size 24576 --parallel 1 --temp 0 --seed 42 \
  --cache-type-k q8_0 --cache-type-v q8_0 --flash-attn on --cache-ram 0 \
  --no-ui --jinja --chat-template-file ./chat.jinja --log-timestamps
```

В другом терминале, из корня проекта, создайте отдельную копию контроллера. Каждая попытка получает новый каталог. Процесс пилота может завершиться с кодом 1 при провале проверок, причина и известный расход сохраняются в `run.json`. Код 0 в офлайн-аудите подтверждает полноту учёта. Результат проверки поведения указан отдельно в `public_checks_passed`.

```sh
repeat_dir=$(mktemp -d)
git clone -q --no-local . "$repeat_dir/controller" && cd "$repeat_dir/controller"
git switch --detach 73e1758ac5e23907a064e5a3ca4e949af8fc8e9c
npm ci && npm run build
model_id=qwen2.5-coder-7b-instruct-q4-k-m
for order in shared,fresh fresh,shared; do
  node scripts/pilot-task-context.mjs --fixture scripts/fixtures/local-context-pilot \
    --endpoint http://127.0.0.1:18081/v1 --model "$model_id" --arms "$order" \
    --context 24576 --max-output 2048 --steps 8 --timeout-ms 420000 --out "$repeat_dir/$order"
done
git switch --detach 1d9d86e5973fa9106b46e7bd3606b319bd38be1b
npm run build
for arm in baseline optimized; do
  node scripts/pilot-full-sdd.mjs --arm "$arm" --endpoint http://127.0.0.1:18081/v1 \
    --model "$model_id" --context 24576 --max-output 2048 --steps 10 \
    --timeout-ms 1500000 --out "$repeat_dir/full-$arm"
done
```
