# Изолированный запуск Frugal

Из корня рабочего checkout подготовьте локальные инструменты и образ. Для Python демостенда образ устанавливает зависимости из его зафиксированного uv.lock. Для другого репозитория можно передать собственный образ через `--image`. В манифест записывается неизменяемый Docker image ID.

```sh
npm ci
npm run build
docker build -f tools/runner/Dockerfile -t frugal-runner:local .
node packages/cli/bin/frugal.js run --feature add-transfer-limits --mode paired --dry-run --series replay-01
```

`--runs N --mode paired` создаёт N пар в порядке base, opt, base, opt. Одинарные режимы — `baseline`, `optimized`, `ablation --flag <имя>`. Имена флагов объявляет frugal.yaml стенда. До реализации оптимизатора live-доступен B0. Локальный replay проверяет ветвление, четыре вызова штатного B0 (включая общее создание четырёх OpenSpec-артефактов), сырой журнал, сохранение снимка и сверку измерителя. Ключ `--image frugal-runner:local` в replay дополнительно проверяет контейнер, версии и проектную установку skills. Все replay отмечаются dry_run и accepted=false.

Для одного живого B0 укажите одну и ту же модель, endpoint, параметры и QA-входы в пробном и рабочем запуске. В рабочем режиме opencode исполняется только в отдельном контейнере. Из домашнего окружения в него передаётся лишь переменная авторизации выбранного провайдера. Для OpenAI-совместимого локального сервера задайте `--endpoint http://host.docker.internal:PORT/v1 --model local/MODEL --context-limit N --output-limit N`. Для удалённого совместимого endpoint используется HTTPS, его ключ при наличии передаётся из FRUGAL_PROVIDER_API_KEY. Значения ключей исключены из манифестов. Ключ `--timeout N` задаёт общий для обоих плеч предел времени модельной стадии в секундах, по умолчанию 1800. При исчерпании времени сохраняются потоки и известный расход. Пользовательский профиль, проект Frugal, другие плечи и эталон в контейнер исполнителя не монтируются. Временный каталог, отдельные XDG, OPENCODE_CONFIG_DIR и кеш каждого плеча сохраняются для разбора сбоя.

```sh
node packages/cli/bin/frugal.js run --feature add-transfer-limits --mode baseline --model PROVIDER/MODEL --oracle-root /absolute/qa/bench/features --dry-run --series check-m
node packages/cli/bin/frugal.js run --feature add-transfer-limits --mode baseline --model PROVIDER/MODEL --oracle-root /absolute/qa/bench/features --calibration --series b0-m1
```

При первом калибровочном B0 хеши агентов и команд фиксируются в каталоге запусков. Для серии более чем из двух живых плеч подготовьте запись в docs/EXPERIMENTS.md и bench/plans/ID.json с полями mode, runs, feature, model, estimated_cost_per_arm, maximum_cost и quota_available в одной валюте. `--experiment ID` проверяет, что оценка с запасом 30% укладывается в зарегистрированные пределы. Квоту поставщика проверяют отдельно до утверждения плана.

`--resume --series ID` пропускает завершённые слоты и проверяет отпечатки входов. Прерванное плечо остаётся со своим расходом, новое получает следующий номер попытки и prior_run_id. Завершившаяся модельная неудача расходует зарегистрированный слот; `--resume` продолжает остальные слоты серии. Рабочие процессы другого координатора учитываются по owner.json. После завершения модельной части последующая проверка восстанавливается без новых вызовов модели.

Исходный стенд задаётся файлами bench/repos/NAME.bundle, bench/repos/NAME.sha и полем repo в expected.yaml. Закрытый набор ищется в bench/features/ID/hidden_tests или под `--oracle-root /absolute/qa/bench/features`. После конвейера проверяющий получает отдельную копию исходного и конечного снимка, неизменившийся эталон и результаты обоих запусков тестов. Если агент изменил прежний тест или его настройки, дополнительно исполняются исходные тесты против итоговой реализации. Обе версии и результат записываются в evaluation/frozen-regression.json. Первый адаптер исполняет JUnit-совместимую команду pytest, записанную в frugal.yaml. Файл evaluation/evidence.json фиксирует независимые инвентари тестов, результаты и ревью. Независимый проверяющий заполняет оценку по quality/evaluator-request.json.

```sh
node packages/cli/bin/frugal.js run --evaluate-only bench/runs/RUN_ID
node packages/cli/bin/frugal.js run --evaluate-only bench/runs/RUN_ID --evidence /absolute/qa/assessment.json
```

Если сбор тестовых отчётов прервался, передайте прежний `--oracle-root` при первом вызове. Дополнительно можно передать `--signature FILE --reviewer-key PEM`. Засчитываются только проверенные результаты для сохранённого SHA и полная сверка meter. Проверка сохраняет собственное решение и отметку времени в evaluation/assessments. Модельное время, события и финальный Git bundle исходного плеча доступны отдельно.
