> **RESEARCH.md** — сводка исследования для [`TZ.md`](TZ.md). Разделы соответствуют пометкам `[R:§…]` в ТЗ. Сырые заметки по темам: [`docs/research/`](docs/research/). Собрано 21.11.2026 из первоисточников (репозитории OpenSpec и opencode, документация, arXiv, страница хакатона).

# Режем токены SDD-конвейера, сохраняя качество

**Коротко.** Больше всего баллов принесёт не очередной компрессор, а обвязка (harness) вокруг OpenSpec + opencode, которая убирает повторное чтение. По замерам в похожих системах деньги уходят на input, а не на генерацию кода. В ChatDev с GPT-5 итеративное ревью заняло **59,4% токенов** ([Tokenomics, arXiv 2601.14470](https://arxiv.org/html/2601.14470)). В OpenHands на SWE-bench чтения из кэша дают основную часть стоимости в каждой фазе, даже с включённым кэшем ([Bai et al., arXiv 2604.22750](https://arxiv.org/pdf/2604.22750)). В OpenSpec 2.1.1 главный множитель расхода встроен в сам скилл apply. Он велит прочитать **все** `contextFiles` (proposal, все delta specs, design, tasks) и перезапускать `openspec instructions apply --json` после **каждой** задачи ([apply SKILL.md](https://github.com/Fission-AI/OpenSpec/blob/main/skills/openspec-apply-change/SKILL.md)). opencode V1 на каждом шаге заново отправляет базовый промпт на 7–15 KB и около 15 KB описаний инструментов ([V1 session/prompt](https://github.com/anomalyco/opencode/tree/v1.19.6/packages/opencode/src/session/prompt)).

Отсюда ядро решения:

- **срезы спеки** на каждую задачу через `openspec show --json`;
- **детерминированное ведение состояния** через CLI вместо циклов внутри скиллов;
- **короткие** `prompt`/`system` у агентов и **запрет** ненужных tools;
- **сжатие логов тестов** в `tool.execute.after`;
- **маскирование** старых наблюдений: −50% стоимости без значимой потери solve rate ([Complexity Trap, arXiv 2508.21433](https://arxiv.org/html/2508.21433v3));
- **ревью по дельте** с детерминированными гейтами и матрицей трассируемости;
- **стабильный префикс** под кэш. У GigaChat это `X-Session-ID`, а `precached_prompt_tokens` не тарифицируются ([GigaChat: подсчёт токенов](https://developers.sber.ru/docs/ru/gigachat/guides/counting-tokens)).

Экономию доказывает двойной учёт: прокси плюс `opencode run --format json`, с нормализацией input/cache. Нужно ≥8–10 прогонов на плечо, bootstrap-CI, тест Mann-Whitney и скрытый acceptance-suite. Два предупреждения. Первое: в независимых парных тестах заявленные «60–90%» утилиты RTK в итоговом счёте превратились в ~0% и даже в рост расходов ([Quesma](https://quesma.com/blog/does-rtk-make-ai-coding-cheaper/); [JetBrains](https://blog.jetbrains.com/ai/2026/07/rtk-claude-code-token-savings/)). Поэтому судить надо по счёту провайдера, а не по счётчику утилиты. Второе: первый практический риск — выбор линии opencode. У V1 `opencode-ai` 1.19.6 и V2 `@opencode/cli` 2.3.2 несовместимые API плагинов ([migrate-v1](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/migrate-v1.mdx)).

**Карта разделов для ссылок из TZ.md**

| Маркер | Раздел |
|---|---|
| [R:§хакатон] | 1. Контекст хакатона и заказчика |
| [R:§openspec] | 2. OpenSpec |
| [R:§opencode] | 3. opencode |
| [R:§куда уходят токены] | 4. Куда уходят токены |
| [R:§техники] | 5. Техники экономии |
| [R:§инструменты] | 6. Готовые инструменты и лицензии |
| [R:§методика] | 7. Методика замеров и доказательство качества |
| [R:§учёт токенов] | 7.1. Нормализация учёта токенов |
| [R:§модели] | 8. Модели разного размера |
| — | 9. Практические выводы, 9.3 — стартовые проверки |
| — | 10. Источники |

Метки достоверности по всему тексту: **[незав.]** — замер третьей стороны или исследование, сравнивающее чужие стратегии; **[авторы метода]** — статья или препринт, где авторы оценивают собственный метод; **[самоотчёт]** — цифры из README, блога или маркетинга автора или вендора о собственном инструменте; **[оценка]** — арифметика или замер по эвристике chars/4, сделанные исследователями команды; **[не проверено]** — пункт требует ручной проверки.

---

## 1. Контекст хакатона и заказчика (§хакатон): Сбер уже «идёт в сторону SDD» и тратит триллионы токенов в месяц

Хакатон Студсовета ФПМИ проходит **21–22 ноября 2026** в Физтех-клубе (ТЦ «Дирижабль», 2 этаж). Решение кейсов заканчивается **22 ноября в 16:00 МСК**, презентации начинаются в 17:00, подсчёт результатов и награждение — в 19:00. Призовой фонд **100 000 ₽**, VK и СберТех награждают лучшую команду в каждом кейсе ([hackathon.fpmi.tech](https://hackathon.fpmi.tech)). Единственное опубликованное правило — «пользуйтесь чем угодно». Положения, рубрики сверх PDF кейса, формата сдачи и списка жюри на сайте нет. В команде от 4 до 6 человек, хотя Telegram-анонс зовёт «собирать шестёрку» ([t.me/stfpmi](https://t.me/s/stfpmi?q=хакатон)). Очного времени на решение около 10 часов: 12:00–18:00 в первый день и 12:00–16:00 во второй. Отсюда практический вывод: стенд A/B надо автоматизировать в первый день и гонять прогоны ночью. Это вывод из расписания, организаторы такого правила не формулировали. Регламент может оказаться только в кабинете команды `/team/` или быть объявлен на открытии.

СберТех дал три из четырёх кейсов, и два из них про OpenSpec/SDD. Первый — наш «Экономия токенов в SDD-разработке» с формулировкой «при разработке по спецификациям кодинг-агент многократно перечитывает требования, код и результаты проверок». Второй — «IDE для spec-driven разработки с OpenSpec». Третий кейс СберТеха — LLM-помощник внутри psql, который должен работать «в закрытом контуре» ([hackathon.fpmi.tech/cases](https://hackathon.fpmi.tech/cases)). Из этого следуют два вывода. Жюри знает артефакты OpenSpec (proposal/specs/design/tasks) и оценит решение, которое опирается на их структуру: дельты, задачи, сценарии. Демонстрация на локальной модели совпадает с приоритетом закрытого контура. В материалах команды базовый конвейер кейса выглядит так: артефакты → реализация 8–12 задач → 3–5 итераций ревью → верификация. Менять модель или провайдера и урезать требования или стадии запрещено. Требуются 100% покрытие требований, зелёные тесты и работа на малых и крупных LLM. Критерии: подтверждённый замером % экономии (35%), сохранённое качество (25%), универсальность (15%), портативность (10%), обоснование самых дорогих стадий (15%).

Публичная позиция Сбера прямо поддерживает такую постановку. Кирилл Меньшов (старший вице-президент, «Технологии») на GigaConf 2026 сказал: «Мы идём в сторону SDD», «у нас 100% инженеров используют это в разработке», «модели мы меняем примерно раз в один-два месяца», «мы меряем инциденты». Интервью вышло 19.10.2026 и помечено как реклама ПАО Сбербанк ([kod.ru](https://kod.ru/gigakonf-2026-kirill-menshov/amp)). На инженерном дне GigaConf 16.10.2026 прозвучали две цифры. Расход токенов в генеративной разработке в августе достиг **9 трлн в месяц**. В «Cowork Bench» девять харнессов на одной и той же модели решили от **62% до 80%** задач, GigaCowork — 75,2%; модель там сравнили с «двигателем в автомобиле» ([kod.ru](https://kod.ru/kak-ii-agenty-menyayut-razrabotku-gigaconf-2026/amp)). В июне CNews писал, что вычисления на генерацию кода за пять месяцев выросли в 30× и дошли до 1,5 трлн токенов ([CNews](https://zoom.cnews.ru/soft/news/line/2026-06-19_ot_assistentov_k_agentam/print)). Блог Сбера на Habr сообщал о ~14 000 разработчиков в GigaCode и о росте доли принятого ИИ-кода с 45% до 69% за 2025 год ([Habr](https://habr.com/ru/articles/1009838)).

Для баллов это значит три вещи. Во-первых, решение должно быть модель-независимым на уровне обвязки: модели в Сбере меняют раз в 1–2 месяца, и критерий универсальности на 15% проверяет именно это. Во-вторых, замер важнее идеи. Русскоязычные статьи про SDD и экономию токенов почти не содержат измерений; автор дорожной карты Spec Kit прямо пишет: «пока это гипотеза без единого замера» ([Habr 1063940](https://habr.com/ru/articles/1063940/)). Воспроизводимая постадийная книга токенов закрывает 35% и 15% критериев одновременно. В-третьих, масштаб для питча считается в одну строку. 30% от 9 трлн токенов в месяц по прайсу GigaChat 2 Max (650 ₽ за 1M) — около **1,76 млрд ₽ в месяц** **[оценка]**. Это иллюстрация по публичному прайсу, а не внутренняя себестоимость Сбера ([прайс Max](https://developers.sber.ru/docs/ru/gigachat/models/gigachat-2-max)). Не стоит утверждать, что GigaCode построен на opencode: ни один источник этого не подтверждает. Решение лучше подавать как независимое от харнесса.

---

## 2. OpenSpec (§openspec): CLI детерминирован и отдаёт JSON, а дорого обходятся его скиллы

### 2.1. Версии: в 2.x команды `/opsx:*` стали скиллами, поэтому версию надо закрепить

Актуальная версия — **`@fission-ai/openspec` 2.1.1 от 19.11.2026**. Она требует Node `>=22.20.0`; с 1.15.0 есть standalone-бинарники и `brew install openspec` ([npm](https://www.npmjs.com/package/@fission-ai/openspec?activeTab=versions); [package.json](https://unpkg.com/@fission-ai/openspec@2.1.1/package.json)). Линия 1.x началась с 1.0.0 от 26.01.2026 («The OPSX Release»). Она ввела action-based команды `/opsx:*` и динамические инструкции из трёх слоёв: `context` из `config.yaml`, `rules` для каждого артефакта и шаблон. Агент получает состояние, обращаясь к CLI. Версия 1.0 же перестала генерировать `AGENTS.md`/`project.md` ([CHANGELOG](https://github.com/Fission-AI/OpenSpec/blob/main/CHANGELOG.md)).

Дальше изменения шли так ([CHANGELOG](https://github.com/Fission-AI/OpenSpec/blob/main/CHANGELOG.md); [cli.md](https://github.com/Fission-AI/OpenSpec/blob/main/docs-lab/reference/cli.md)):

- **2.0.0 (11.11.2026)** удалила файлы команд. Каждый workflow стал skill `openspec-*` в общей папке `.agents/skills/`.
- **2.1.0** по умолчанию ставит скиллы глобально в `~/.agents/skills/`. Для установки в проект нужен `--scope project`, его же задают `OPENSPEC_SKILLS_SCOPE` или `skillsScope: project` в `openspec/config.yaml`.
- **2.1.1** снова ставит скиллы из npm-пакета, офлайн и без Git.

В репозитории два дерева документации: `docs/` описывает 1.x, `docs-lab/` описывает 2.x. Ориентироваться нужно на `docs-lab/`.

Для opencode версия 2.x пишет `.agents/skills/openspec-*/SKILL.md`, вызов выглядит как `/openspec-apply-change`. Отдельной папки-ссылки нет, потому что, по матрице поддержки OpenSpec, opencode сам читает общую папку ([supported-tools](https://github.com/Fission-AI/OpenSpec/blob/main/docs-lab/reference/supported-tools.md); [skill-paths.ts](https://github.com/Fission-AI/OpenSpec/blob/main/src/core/shared/skill-paths.ts)). Версия 1.x создавала `.opencode/skills/openspec-*/SKILL.md` и `.opencode/commands/opsx-<id>.md` с плейсхолдером `$ARGUMENTS`: opencode передаёт аргументы только через явные плейсхолдеры ([opencode adapter](https://github.com/Fission-AI/OpenSpec/blob/main/src/core/command-generation/adapters/opencode.ts)). **1.17.0 (09.11.2026) — последний релиз с командными файлами.** Если материалы кейса говорят «/opsx:propose, /opsx:apply», это словарь 1.x, и версию нужно выбрать сознательно. Что opencode действительно подхватывает `.agents/skills/`, подтверждает только документация OpenSpec; на стороне opencode это **[не проверено]**. Для воспроизводимого A/B ставьте зафиксированную версию в проект: `npm i -g @fission-ai/openspec@2.1.1 && openspec init --scope project --tools opencode`. Тогда скиллы окажутся в репозитории под версионным контролем, и их можно будет измерить.

| 1.x команда | 2.x скилл (вызов `/имя`) | В профиле `core` |
|---|---|---|
| `/opsx:propose` | `openspec-propose` | да |
| `/opsx:explore` | `openspec-explore` | да |
| `/opsx:apply` | `openspec-apply-change` | да |
| `/opsx:update` | `openspec-update-change` | да |
| `/opsx:sync` | `openspec-sync-specs` | да |
| `/opsx:archive` | `openspec-archive-change` | да |
| `/opsx:new`, `:continue`, `:ff` | `openspec-new-change`, `-continue-change`, `-ff-change` | нет |
| `/opsx:verify` | `openspec-verify-change` | **нет** — включать через `openspec config profile` + `openspec update` |
| `/opsx:bulk-archive`, `:onboard` | `openspec-bulk-archive-change`, `openspec-onboard` | нет |

Источники: [upgrade-to-2.md](https://github.com/Fission-AI/OpenSpec/blob/main/docs-lab/help/upgrade-to-2.md); [profiles.md](https://github.com/Fission-AI/OpenSpec/blob/main/docs-lab/customize/profiles.md); [docs/commands.md](https://github.com/Fission-AI/OpenSpec/blob/main/docs/commands.md).

Главная ловушка: `openspec update` целиком заменяет папки встроенных скиллов в `.agents/skills/` и **без предупреждения удаляет ваши правки** ([upgrade-to-2.md](https://github.com/Fission-AI/OpenSpec/blob/main/docs-lab/help/upgrade-to-2.md)). Поэтому экономный слой нельзя строить на правке `openspec-*`. Ему нужны собственные скиллы под другими именами, своя schema или внешняя обёртка.

### 2.2. CLI с `--json` позволяет вести всё состояние без LLM

CLI не вызывает LLM и спроектирован так, чтобы его вызывали агенты. У noun-форм `openspec change …`/`openspec spec …` статус deprecated ([cli.md](https://github.com/Fission-AI/OpenSpec/blob/main/docs-lab/reference/cli.md)). Команды, полезные оркестратору:

| Команда | Что отдаёт |
|---|---|
| `openspec status --change <id> --json` (или `--all --json`) | `artifacts[]` со статусом `done/ready/blocked/skipped`, `requires`, `missingDeps`; `nextSteps`; `isComplete`; `actionContext.allowedEditRoots` |
| `openspec instructions apply --change <id> --json` | `contextFiles` (**пути, а не содержимое**), `tasks[]` = {`id`, `description`, `done`, `sourcePath`, `line`}, `progress`, `state` = `blocked/ready/all_done`, `instruction`, при наличии `context`, `operationGuidance` |
| `openspec instructions <artifact> --change <id> --json` | `instruction`, `template`, `outputPath`, `dependencies`, `unlocks`, плюс `context`/`rules` |
| `openspec show <change> --json [--diff]` | `deltas[]` = {`spec`, `operation`, `requirement`: {`name`, `text`, `scenarios[{name, rawText}]`}}; поля `name` появились в 1.14.0 |
| `openspec show <spec> --type spec --json [--no-scenarios] [-r N]` | `requirements[]` спеки; `-r` выбирает требование **по позиции** (1-based), а не по стабильному ID |
| `openspec validate [item] --strict --json [--report findings]` | ERROR/WARNING/INFO с line/column; при `--strict` warnings становятся ошибками; конфликты слияния — INFO, код выхода они не меняют; exit 1 при ошибке или битом `config.yaml` |
| `openspec archive <id> -y --json` | переносит изменение в `openspec/changes/archive/YYYY-MM-DD-<id>/` и детерминированно сливает дельты в `openspec/specs/<cap>/spec.md`; незакрытые задачи дают только предупреждение |
| `openspec list --json`, `context --json`, `new change <name>`, `templates/schemas --json`, `update --dry-run --json` | список изменений со счётчиками задач, рабочий контекст, создание `.openspec.yaml`, шаблоны, предпросмотр обновления |

Источники: [cli.md](https://github.com/Fission-AI/OpenSpec/blob/main/docs-lab/reference/cli.md); [CHANGELOG 1.11.0–2.0.0](https://github.com/Fission-AI/OpenSpec/blob/main/CHANGELOG.md). Телеметрия отключается через `OPENSPEC_TELEMETRY=0` или `DO_NOT_TRACK=1` ([faq.md](https://github.com/Fission-AI/OpenSpec/blob/main/docs/faq.md)).

Вывод для архитектуры: оркестратор может вести весь цикл сам, не тратя токенов. Это выбор изменения, определение следующего артефакта, поиск невыполненной задачи, проверка галочки, валидация, архив. Встроенные скиллы делают то же руками LLM: модель запускает эти команды и разбирает их JSON. Документация называет приведённые JSON-формы «Trimmed», поэтому полные формы и реальные байтовые размеры `status`/`instructions apply` на настоящем изменении нужно снять руками **[не проверено]**.

### 2.3. Форматы артефактов и жёсткие лимиты валидатора

Раскладка такая:

- `openspec/specs/<capability>/spec.md` — источник истины;
- `openspec/changes/<id>/{.openspec.yaml, proposal.md, design.md, tasks.md, specs/<capability>/spec.md}` — само изменение;
- `openspec/changes/archive/YYYY-MM-DD-<id>/` — архив.

Граф артефактов схемы `spec-driven` задан в `schema.yaml`. `proposal` ни от чего не зависит, `specs` и `design` требуют `proposal`, `tasks` требует `[specs, design]`. Блок `apply` выглядит как `{requires: [tasks], tracks: tasks.md}`. Инструкция design велит создавать design.md «только если нужно», но в графе `tasks` всё равно зависит от `design` ([schema.yaml](https://unpkg.com/@fission-ai/openspec@2.1.1/schemas/spec-driven/schema.yaml)).

Delta specs пишутся по таким правилам ([schema.yaml](https://unpkg.com/@fission-ai/openspec@2.1.1/schemas/spec-driven/schema.yaml); [requirement-blocks.ts](https://github.com/Fission-AI/OpenSpec/blob/main/src/core/parsers/requirement-blocks.ts)):

- Секции: `## ADDED|MODIFIED|REMOVED|RENAMED Requirements`.
- Требование открывается `### Requirement: <name>` и формулируется через SHALL/MUST.
- Сценарий открывается `#### Scenario: <name>`, **ровно четыре решётки**, с шагами `- **WHEN**`/`- **THEN**`.
- У каждого требования должен быть хотя бы один сценарий.
- MODIFIED требует **полной копии блока**, иначе детали потеряются при архиве.
- REMOVED требует **Reason** и **Migration**.
- RENAMED пишется как `- FROM: \`### Requirement: Old\`` / `- TO: \`### Requirement: New\``.

Лимиты валидатора ([constants.ts](https://github.com/Fission-AI/OpenSpec/blob/main/src/core/validation/constants.ts); [CHANGELOG 1.14.1–2.1.1](https://github.com/Fission-AI/OpenSpec/blob/main/CHANGELOG.md)):

| Правило | Значение и последствие |
|---|---|
| Длина текста требования (`MAX_REQUIREMENT_TEXT_LENGTH`) | 500 символов; сверх — WARNING, который валит `--strict` (с 1.14.1); с 2.1.1 то же для разросшегося MODIFIED |
| Дельт на изменение (`MAX_DELTAS_PER_CHANGE`) | 10, затем совет разбить изменение |
| `## Why` в proposal | от 50 до 1000 символов |
| `## Purpose` у новой capability | от 50 символов |
| Сценарий без шага WHEN/GIVEN или THEN | warning, который валит `--strict` (с 1.16.0) |
| Неизвестная секция `## … Requirements` | ошибка `validate`, archive её отклоняет (1.16.1) |
| Изменение без дельт | отклоняется, если в `.openspec.yaml` нет `skip_specs: true` |

Лимит в 500 символов полезен для экономии: он сам заставляет писать короткие требования.

В `tasks.md` задача — это чекбокс `- [ ] X.Y …` внутри группы `## N. …`. Каждая задача обязана указывать способ проверки: тест, команду или наблюдаемое поведение. Тесты и документацию нельзя сводить в финальную группу. Выполненной считается только задача с `x`/`X`; дублирующиеся ID дают warning ([schema.yaml](https://unpkg.com/@fission-ai/openspec@2.1.1/schemas/spec-driven/schema.yaml); [templates/tasks.md](https://unpkg.com/@fission-ai/openspec@2.1.1/schemas/spec-driven/templates/tasks.md)). Proposal состоит из `## Why`, `## What Changes`, `## Capabilities`, `## Impact`, инструкция просит «1–2 страницы». Design состоит из `## Context`, `## Goals / Non-Goals`, `## Decisions`, `## Risks / Trade-offs`, и инструкция велит ссылаться на proposal, а не пересказывать его ([templates](https://unpkg.com/@fission-ai/openspec@2.1.1/schemas/spec-driven/templates/proposal.md)).

У каждого изменения есть `.openspec.yaml` с полями `schema`, `created`, `goal`, `affected_areas`, `initiative`, `skip_specs`, `retire_capabilities`. Любой ключ верхнего уровня с префиксом **`x-`** (например, `x-tracker: SB-5497`) OpenSpec не читает. Такой ключ проходит `--strict` и переезжает в архив, так что это санкционированное место для метаданных оркестратора: бюджета токенов, дайджеста карты требование→задача. Неизвестные ключи без `x-` валят `--strict` ([change-metadata.md](https://github.com/Fission-AI/OpenSpec/blob/main/docs-lab/reference/configuration/change-metadata.md)).

В проектном `openspec/config.yaml` есть поля `schema`, `context`, `rules`, `operations`, `store`, `references` и `skillsScope`:

- `context` — строка до 50 KB, которая **вставляется в каждую инструкцию** artifact/apply/archive.
- `rules` — правила для каждого артефакта.
- `operations.apply|archive.guidance` — советы для операций.
- `references` — сюда добавляется только индекс спеки, а не её содержимое.

Известная ловушка: пункт `rules:` с некавыченным `": "` YAML читает как отображение, и весь набор правил артефакта молча отбрасывается, остаётся только предупреждение ([config-yaml.md](https://github.com/Fission-AI/OpenSpec/blob/main/docs-lab/reference/configuration/config-yaml.md); [CHANGELOG 1.14.0](https://github.com/Fission-AI/OpenSpec/blob/main/CHANGELOG.md)).

Собственные схемы ищутся в `openspec/schemas/<name>/`, затем в `~/.local/share/openspec/schemas/<name>/`, затем в пакете. Для работы с ними есть `openspec schema fork|init|validate`. В `apply.tracks` можно указать glob, например `"**/tasks.md"`, и задачи из нескольких файлов объединятся. Готовность артефакта определяется **только по наличию файла** ([schema-yaml.md](https://github.com/Fission-AI/OpenSpec/blob/main/docs-lab/reference/schemas/schema-yaml.md)). Открытый issue #1694: `context`/`rules` из `config.yaml` действуют на все схемы проекта сразу ([#1694](https://github.com/Fission-AI/OpenSpec/issues/1694)).

### 2.4. Сколько текста получает агент: скилл apply умножает расход на число задач

Каждый `SKILL.md` весит примерно **1,2–5,9 тыс. токенов**. Ниже размеры, которые исследователи команды сняли в каталоге `skills/` репозитория по эвристикам «words×1,33» и «chars/4» **[оценка]**. Русский текст токенизируется хуже английского, поэтому артефакты на русском обойдутся дороже.

| Скилл | Байт | ≈ токенов |
|---|---|---|
| `openspec-apply-change` | 11 242 | 2,2–2,8 тыс. |
| `openspec-propose` | 16 637 | 3,3–4,2 тыс. |
| `openspec-verify-change` | 20 462 | 3,9–5,1 тыс. |
| `openspec-archive-change` | 17 989 | 3,6–4,5 тыс. |
| `openspec-sync-specs` | 15 761 | 3,2–3,9 тыс. |
| `openspec-explore` | 23 408 | 4,5–5,9 тыс. |
| `openspec-ff-change` / `-continue-change` / `-update-change` | 11 606 / 10 669 / 11 249 | 2,2–2,9 тыс. |
| `openspec-new-change` | 5 877 | 1,2–1,5 тыс. |
| `openspec-onboard` / `-bulk-archive-change` | 16 809 / 23 017 | 3,4–5,7 тыс. |

Источник: [skills/](https://github.com/Fission-AI/OpenSpec/tree/main/skills).

Поверх скилла идут инструкции артефактов из `schema.yaml`: proposal около 750 токенов, **specs около 1,7 тыс.**, design около 430, tasks около 700. К ним добавляются `context`, `rules` и шаблон ([schema.yaml](https://unpkg.com/@fission-ai/openspec@2.1.1/schemas/spec-driven/schema.yaml)). Каждый скилл начинается с общей преамбулы: выбор store, проверка проекта через `openspec list --json`, ветки автовыбора.

Механика расхода на стадии apply такая ([apply SKILL.md](https://github.com/Fission-AI/OpenSpec/blob/main/skills/openspec-apply-change/SKILL.md)):

1. Скилл запускает `status --json`, затем `instructions apply --json`.
2. Затем идёт шаг «Read every file path listed under `contextFiles`», то есть proposal, specs, design и tasks целиком.
3. После каждой задачи агент отмечает её по `sourcePath`/`line` и **перезапускает apply-инструкции**, чтобы убедиться, что прогресс изменился.
4. Ограничитель «Always read context files before starting» закрепляет полное чтение.

Propose после каждого артефакта перезапускает `status --json`, а с 1.12.0 ещё и обязан «изучить код, тесты и документацию» до написания артефактов ([propose SKILL.md](https://github.com/Fission-AI/OpenSpec/blob/main/skills/openspec-propose/SKILL.md)). Мейнтейнеры сами советуют начинать новую сессию на каждой фазе ([#1013](https://github.com/Fission-AI/OpenSpec/issues/1013); [faq.md](https://github.com/Fission-AI/OpenSpec/blob/main/docs/faq.md)). Это экономит историю, но каждая сессия заново оплачивает скилл и полное перечитывание артефактов.

Грубая оценка исследователей: только скиллы и перечитывание артефактов могут давать **десятки тысяч токенов на задачу** ещё до чтения кода. Это не замер **[оценка]**. Официальных измерений токенов OpenSpec нет. Заметим, что инструкция proposal уже содержит экономный приём: `openspec show "<spec-id>" --type spec --json --no-scenarios` отдаёт назначение capability и тексты требований без целых файлов ([schema.yaml](https://unpkg.com/@fission-ai/openspec@2.1.1/schemas/spec-driven/schema.yaml)).

### 2.5. Трассируемости и стабильных ID нет, их придётся добавить самим

В OpenSpec **нет контекста на задачу, стабильных ID требований и связи требование→задача→тест**. Требование опознаётся по тексту заголовка `### Requirement: <name>`, и по этому же имени archive сопоставляет MODIFIED/REMOVED/RENAMED. Задачи имеют позиционные ID вида `1.2` и `sourcePath`/`line` ([cli.md](https://github.com/Fission-AI/OpenSpec/blob/main/docs-lab/reference/cli.md)).

`openspec-verify-change` — эвристическое LLM-ревью по трём осям: Completeness, Correctness, Coherence. Оно читает все артефакты и ищет реализацию по ключевым словам. Инструкция сама поощряет мягкость: «When uncertain, prefer SUGGESTION over WARNING». Archive verify не блокирует ([verify SKILL.md](https://github.com/Fission-AI/OpenSpec/blob/main/skills/openspec-verify-change/SKILL.md); [commands.md](https://github.com/Fission-AI/OpenSpec/blob/main/docs/commands.md)). Детерминированно проверяются только `validate` и подсчёт галочек. Archive при незакрытых задачах лишь предупреждает; issue #1652 предлагает требовать доказательств ([issues](https://github.com/Fission-AI/OpenSpec/issues?q=is%3Aissue+stable+ids)).

Стабильные ID пока только предложены в открытом issue **#2167** от 29.10.2026. Формат: `### Requirement: [AUTH-3] Users sign in`, `#### Scenario: [AUTH-3.1] …`, решения `### D1`. Автор сообщает, что агенты сохраняли ID в **264 из 265** прогонов **[самоотчёт]**. Реализация разбита на #1979 и #2134, в changelog 2.1.1 их нет. Есть ещё community-схема `spec-driven-ids` (#2157) ([#2167](https://github.com/Fission-AI/OpenSpec/issues/2167)). Имена требований — свободный текст, поэтому сегодняшний парсер, скорее всего, примет `[REQ-1]` как часть имени. Это надо проверить прогоном `validate --strict` и `archive` **[не проверено]**.

### 2.6. Куда встроиться, не форкая OpenSpec

Механизма хуков в OpenSpec нет: #1910 о хуках sync/archive открыт. Нет и автоматического сквозного прогона с выбором модели на шаг (#1771) ([issues](https://github.com/Fission-AI/OpenSpec/issues?q=is%3Aissue+context)). Значит, экономный слой живёт снаружи OpenSpec, и у него пять законных точек входа:

1. **Оркестратор**, который вызывает CLI с `--json` и сам решает, что дать модели.
2. **Собственные скиллы** в `.agents/skills/<своё-имя>/SKILL.md`. Скиллы OpenSpec — обычный Markdown без привязки к модели, их можно заменить своими.
3. **Форк схемы** командой `openspec schema fork` в `openspec/schemas/spec-driven-lean/`. В форке можно укоротить `instruction`, разбить задачи на файлы через `apply.tracks: "tasks/*.md"` и добавить артефакт `trace.md`. `openspec update` проектные схемы не перезаписывает.
4. **`config.yaml`**: короткий `context` и, например, `rules.tasks` с требованием писать «`(covers: REQ-3, REQ-4.1)`» в каждой задаче.
5. **Ключи `x-`** в `.openspec.yaml`.

Из соседних SDD-фреймворков стоит перенести три приёма. Taskmaster хранит задачи отдельными JSON-записями и советует `task-master show <id>`, чтобы «подтянуть только нужную задачу» ([task-master AGENTS.md](https://app.unpkg.com/task-master-ai@0.17.1/files/assets/AGENTS.md)). BMAD режет большой документ по заголовкам `##` на `index.md` и отдельные файлы ([BMAD sharding](https://docs.bmad-method.org/how-to/shard-large-documents/)). Kiro строит граф зависимостей задач и запускает их волнами ([kiro.dev](https://kiro.dev/docs/specs/)). Свою сильную сторону OpenSpec уже даёт: дельты. Ревьюеру можно передавать только `changes/<id>/specs/`, а не всю живую спеку.

---

## 3. opencode (§opencode): две несовместимые линии, точный учёт в NDJSON и хуки, которые могут переписать контекст

### 3.1. V1 1.19.6 и V2 2.3.2: линию надо выбрать до первой строки плагина

На ноябрь 2026 поддерживаются две линии с несовместимыми API плагинов и сервера:

- **OpenCode 1**: npm `opencode-ai` **1.19.6** (17.11.2026), `@opencode-ai/plugin`, `@opencode-ai/sdk`, ветка `v1`.
- **OpenCode 2**: npm `@opencode/cli` **2.3.2**, `@opencode/plugin`, `@opencode/sdk`, `@opencode/client`, ветка `dev`. Именно её ставит README: `curl -fsSL https://opencode.ai/v2/install | bash` или `npm i -g @opencode/cli@latest` ([npm opencode-ai](https://www.npmjs.com/package/opencode-ai); [npm @opencode/cli](https://www.npmjs.com/package/@opencode/cli); [README](https://github.com/anomalyco/opencode/blob/dev/README.md)).

Документация миграции говорит прямо: «V1 plugin implementations do not run in V2». Обе линии используют команду `opencode` и общие места конфигурации, но параллельно по умолчанию не ставятся ([migrate-v1](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/migrate-v1.mdx)). Большинство сторонних токен-плагинов работают только с V1: у DCP peerDependency `@opencode-ai/plugin >=1.18.29`, tokenscope требует `>=1.1.48` ([npm DCP](https://www.npmjs.com/package/@tarquinen/opencode-dcp); [tokenscope](https://github.com/ramtinJ95/opencode-tokenscope)).

Один пакет плагина может поддерживать обе линии. Для этого экспортируется по умолчанию объект с V1-функцией `server()` и V2-функцией `setup()` через `Plugin.define(...)`; объектная форма V1 поддерживается с 1.18.29 ([build/plugins/server](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/build/plugins/server.mdx)). Если окружение жюри ставится из npm `opencode-ai`, команда на V1; проверка — `opencode --version`.

В V2 переименованы ключи конфигурации ([migrate-v1](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/migrate-v1.mdx)):

| V1 | V2 |
|---|---|
| `agent`/`mode` | `agents` |
| `prompt` | `system` |
| `maxSteps` | `steps` |
| `permission` (map) | `permissions` (упорядоченный массив) |
| `command` | `commands` |
| `subtask` | `subagent` |
| `provider` | `providers` |
| `npm` | `package` (префикс `aisdk:`) |
| `options.setCacheKey` | `compatibility.supportsPromptCacheKey` |
| `plugin` | `plugins` |
| `compaction.reserved` | `compaction.buffer` |
| `compaction.preserve_recent_tokens` | `compaction.keep.tokens` |

Ещё изменения V2:

- `compaction.tail_turns` и `compaction.prune` игнорируются с предупреждением.
- Действия в правах переименованы: `bash`→`shell`, `task`→`subagent`, `write`/`patch`→`edit`.
- Todo по умолчанию выключены (`experimental.todo: true`).
- V2 **не запускает LSP**.

Файлы `.opencode/agents|commands`, `AGENTS.md` и `instructions` в основном переносимы между линиями, плагины и HTTP-клиенты — нет. Поэтому для портативности экономию лучше реализовать через файлы, а плагин держать тонким.

### 3.2. Headless-прогоны и где лежат точные токены

Для A/B нужен `opencode run --format json`. Он печатает NDJSON, где каждая строка имеет вид `{type, timestamp, sessionID, ...}`. Возможные типы: `step_start`, `step_finish`, `text`, `reasoning`, `tool_use` и ошибки. Каждый **`step_finish`** — это один вызов LLM с полями `cost` и `tokens: {total?, input, output, reasoning, cache: {read, write}}`. Форма одинакова в V1 и V2 ([V1 run.ts](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/cli/cmd/run.ts); [V2 noninteractive.ts](https://github.com/anomalyco/opencode/blob/dev/packages/cli/src/run/noninteractive.ts)).

Флаги V1: `--command`, `--agent`, `--model/-m provider/model`, `--title`, `--file/-f`, `--session/-s`, `--continue/-c`, `--fork`, `--dir`, `--variant`, `--thinking`, `--auto` (автоодобрение прав, которые явно не запрещены) и `--attach http://localhost:4096`. Последний флаг подключает прогон к поднятому `opencode serve` и избавляет от холодного старта MCP ([V1 cli](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/v1/content/cli.mdx)). В V2 добавлены `--standalone` (приватный сервер, рекомендован для CI), `--server <url>` и `--archived` (скриптовые прогоны не попадают в список сессий) ([V2 cli/commands](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/cli/commands.mdx)).

Две ловушки учёта.

Первая: V1 фильтрует события по `part.sessionID !== sessionID`, поэтому **токены субагентов в JSON-поток родителя не попадают** ([V1 run.ts](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/cli/cmd/run.ts)). В V2 есть отдельные события `session.usage.recorded` с `source: "title"|"compaction"|"generate"` и итоговые `session.usage.updated`. Испускает ли V2 строки `step_finish` дочерних сессий, **[не проверено]** ([V2 client types](https://github.com/anomalyco/opencode/blob/dev/packages/client/src/promise/generated/types.ts)).

Вторая: `tokens.input` — **только некэшированный input**. V1 считает `input = inputTokens − cacheReadInputTokens − cacheWriteInputTokens` и `output = outputTokens − reasoningTokens`. Стоимость он берёт из каталога цен моделей ([V1 session.ts](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/session/session.ts)). V2 предпочитает стоимость, которую сообщил сам endpoint, а иначе тоже берёт каталог ([V2 usage.ts](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/usage.ts)). Нормализация подробно разобрана в §7.1.

Данные V1 хранятся в `~/.local/share/opencode/opencode.db` (SQLite; путь меняется через `OPENCODE_DB`) ([V1 troubleshooting](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/v1/content/troubleshooting.mdx)). В строке сессии есть колонки `cost`, `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`, а `parent_id` связывает субагентов с родителем ([V1 session.ts](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/session/session.ts)). Точное имя таблицы **[не проверено]**. Для чтения есть `opencode db "<SQL>" --format json`, `opencode export <id> [--sanitize]`, `opencode session list --format json` и `opencode stats --days N --models`. HTTP API `opencode serve` (OpenAPI на `/doc`) даёт `GET /session/:id/children` и `GET /session/:id/message` ([V1 server](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/v1/content/server.mdx)).

В V2 полезнее всего встроенный хост `@opencode/sdk` (`OpenCode.create({plugins})`, «no HTTP listener») с `events.subscribe()`. Ещё там есть маршруты:

- `/api/session/{id}/context` — сообщения, которые реально видит модель;
- `/api/experimental/session/stats` — `{sessions, subagents, steps, tokens, cost, models[]}`;
- `/api/experimental/session/{id}/export`.

Источники: [V2 build/sdk](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/build/sdk/index.mdx); [V2 client](https://github.com/anomalyco/opencode/blob/dev/packages/client/src/promise/generated/client.ts).

Рецепт постадийного замера для V1 **[оценка]**:

1. Каждую стадию запускать отдельным `opencode run --format json --agent <stage> --model <m> --title <run-id>/<stage> "…"`.
2. Суммировать `step_finish.part.tokens`.
3. Добавить дочерние сессии по `parent_id`.
4. Сверить итог с прокси.

### 3.3. Хуки плагинов, которые могут переписать контекст

Плагин V1 — функция `(input: {client, project, directory, worktree, serverUrl, $}) => Promise<Hooks>` ([V1 plugin/src/index.ts](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/plugin/src/index.ts)). Для экономии важны хуки из таблицы:

| Хук V1 | Что меняет | Сохраняется? Влияние на кэш | Применение в SDD |
|---|---|---|---|
| `tool.execute.after` (вход `{tool, sessionID, callID, args}`, выход `{title, output, metadata}`) | результат инструмента, который **сохраняется и уходит модели** ([tools.ts](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/session/tools.ts)) | постоянно; кэш стабилен | сжать вывод `pytest`/`npm test`/`git diff` до упавших тестов и хвоста, полный лог сохранить в файл |
| `experimental.chat.messages.transform` (выход `{messages: {info, parts}[]}`) | список сообщений перед **каждым** шагом цикла, без сохранения ([prompt.ts](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/session/prompt.ts)) | эфемерно; ломает кэш с первого изменённого сообщения | маскировать старые наблюдения, убирать дубли чтения файлов спеки |
| `experimental.chat.system.transform` (выход `{system: string[]}`) | системные строки; больше двух записей сворачиваются в `[header, rest]` по двум точкам кэша ([request.ts](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/session/llm/request.ts)) | ломает кэш при любом изменении | только стабильные вставки |
| `tool.definition` (выход `{description, parameters}`) | описания и схемы инструментов | фиксировано на всю сессию | укоротить описания для малых моделей |
| `experimental.session.compacting` (выход `{context[], prompt?}`) | `prompt` **целиком заменяет** промпт компакции | — | сводка «состояние SDD»: ID задачи, сделано/осталось, открытые замечания, ID требований |
| `chat.params` / `chat.headers` | `maxOutputTokens`, температура / HTTP-заголовки | — | `maxOutputTokens` по агентам; заголовки `X-Session-ID` (GigaChat) и `x-litellm-tags` (стадия) **[не проверено]** |
| `tool.execute.before`, `command.execute.before`, `shell.env` | аргументы инструмента и команды | — | подменить `pytest` на обёртку, подставить срез задачи |

Плагин V2 строится как `Plugin.define({id, setup(ctx)})` и подключается через `"plugins": [...]`; локальные плагины лежат в `.opencode/plugins/<name>/index.ts`. Хуки V2 ([V2 plugins/server](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/build/plugins/server.mdx)):

- `ctx.session.hook("context")` правит `system`, `messages`, `tools` и `options` только исходящего вызова: «Changes affect only the outgoing model call, not persisted history». Регистрировать его нужно для каждого вида запроса.
- `ctx.session.hook("compaction")` позволяет вернуть `result` без вызова модели.
- Есть хуки `prompt`, `generate`, `title`, `experimental.model.resolve`, `http.request`/`http.response`.
- `ctx.tool.hook("execute.before"|"execute.after")`: сохраняется ли заменённый `event.result` в истории, **[не проверено]**.

Для внедрения среза спеки в V2 лучше всего подходит **`ctx.session.instructions.entry.put/list/remove`** из V2.2.0. Изменение добавляется маленьким обновлением на следующем шаге, «вместо правки системного промпта, ломающей кэш», и переживает компакцию ([CHANGELOG](https://github.com/anomalyco/opencode/blob/dev/CHANGELOG.md)).

### 3.4. Фиксированный префикс: системный промпт, инструкции, инструменты

V1 выбирает базовый промпт по id модели ([V1 system.ts](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/session/system.ts)). `claude` получает `anthropic.txt` (8 212 B), `gpt-4`/`o1`/`o3` — `beast.txt` (11 080 B), `gemini-` — `gemini.txt` (15 372 B), прочие `gpt` — `gpt.txt` (9 284 B), `codex` — `codex.txt` (7 390 B). Всё остальное получает **`default.txt` (8 528 B)**; судя по правилу выбора, туда попадут и модели GigaChat **[оценка]**. Системный промпт собирается как `[agent.prompt ? agent.prompt : SystemPrompt.provider(model), ...input.system, user.system]` ([request.ts](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/session/llm/request.ts)). Значит, **непустой `prompt` агента заменяет базовые 7–15 KB**: это самая крупная статическая экономия, и работает она с любой моделью. В V2 базовый `system.txt` весит всего 1 035 B, к нему добавляются небольшие провайдерские добавки (`gpt.txt` 2 851 B, `kimi.txt` 8 978 B). Непустой `system` у агента в V2 тоже заменяет базу ([V2 system-prompt.ts](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/system-prompt.ts); [V2 agents](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/agents.mdx)).

К базе добавляются ещё несколько слоёв:

- **env-блок** с рабочим каталогом, платформой и **`Today's date`** ([system.ts](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/session/system.ts));
- **инструкции**: глобальные `~/.config/opencode/AGENTS.md` и `~/.claude/CLAUDE.md`, отключаемые через `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT`, и проектные `AGENTS.md`/`CLAUDE.md`. В V1 из проектных побеждает первый найденный файл, а V2 загружает все `AGENTS.md` вверх по дереву ([V1 instruction.ts](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/session/instruction.ts); [V2 instructions](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/instructions.mdx));
- **список скиллов и MCP-инструкции**;
- **описания инструментов**: в V1 одни текстовые описания весят 14 460 B (`task.txt` 2 305, `todowrite.txt` 2 012, `edit.txt` 1 369, `lsp.txt` 1 303…), JSON-схемы сверху ([V1 tool/](https://github.com/anomalyco/opencode/tree/v1.19.6/packages/opencode/src/tool)).

Инструменты убираются правами: в V1 через `permission` (поле `tools` устарело), в V2 через deny-правила `permissions`. Запрещённые субагенты исчезают из описания `task` ([V1 agents](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/v1/content/agents.mdx)). Цену такого префикса показывает issue #22236: список скиллов попадал в запрос дважды и тратил **~5–7 тыс. токенов**, а «hi» в Build-режиме, по словам комментатора, вырос с ~20 до ~70 тыс. токенов между 1.3.7 и 1.4.3 ([#22236](https://github.com/anomalyco/opencode/issues/22236)). Сторонний замер утверждает, что Claude Code отправляет 33 тыс. токенов до чтения промпта, а OpenCode — 7 тыс. Методику в обсуждении оспаривают, версии не указаны ([HN](https://hn.svelte.dev/item/48883275)). Реальный префикс каждой конфигурации надо мерить самим: `input + cache.read + cache.write` первого `step_finish` на тривиальном промпте.

### 3.5. Компакция, лимиты вывода, субагенты

**Компакция V1.** Автокомпакция срабатывает, когда сумма токенов последнего шага достигает полезного окна: `limit.input − reserved` или `context − maxOutputTokens`. `reserved` по умолчанию равен min(20 000, max output), `OUTPUT_TOKEN_MAX = 32 000`. Конфиг: `"compaction": {"auto": true, "prune": false, "reserved": 10000}`. Подрезка старых tool outputs (**`prune`**) **выключена по умолчанию**. Если её включить, она хранит свежие 40 тыс. токенов вывода (`PRUNE_PROTECT`), срабатывает от 20 тыс. (`PRUNE_MINIMUM`) и заменяет старое на «[Old tool result content cleared]». Переменные окружения: `OPENCODE_DISABLE_AUTOCOMPACT`, `OPENCODE_DISABLE_PRUNE` ([overflow.ts](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/session/overflow.ts); [compaction.ts](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/session/compaction.ts); [V1 config](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/v1/content/config.mdx)).

**Компакция V2.** Ключи: `compaction.keep.tokens` (15 000 токенов остаются дословно), `buffer` («15%», не меньше 16 тыс.), `background: true`, нативная компакция OpenAI Responses и ручной вызов `opencode api post /api/session/<id>/compact --data '{}'`. Документация честно оговаривает: компакция «cannot create room when a request is mostly fixed instructions and tool schemas», а неиспользованная фоновая сводка всё равно оплачена ([V2 compaction](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/compaction.mdx)). На 8–12 коротких задачах автокомпакция почти не срабатывает. Основной расход дают фиксированный префикс и накопленные выводы инструментов внутри задачи **[оценка]**.

**Лимиты вывода** одинаковы в V1 и V2. `read` отдаёт до 2000 строк, 50 KB и 2000 символов в строке. Общая обрезка срабатывает на 2000 строках или 50 KB (`tool_output.max_lines`/`max_bytes`, направление `head`/`tail`). Полный вывод сохраняется в файл с подсказкой «Use Grep… or Read with offset/limit» ([truncate.ts](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/tool/truncate.ts); [read.ts](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/tool/read.ts)). 50 KB — это ~12 тыс. токенов **на один результат**. Понизить `tool_output.max_bytes`/`max_lines`, например до 8 KB / 200 строк, можно без единой строки кода, и полный лог останется доступен для grep **[оценка]**. В V1 `write`/`edit` дописывают к результату LSP-диагностику по файлу и ещё по 5 файлам проекта, и это скрытые токены ([write.ts](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/tool/write.ts)).

**Субагенты** работают в дочерних сессиях со свежим контекстом (`parentID` = вызывающая сессия). Родителю возвращается только финальный текст, а **токены записываются на дочернюю сессию** ([V1 task.ts](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/tool/task.ts)). В V2.3.0 субагенты всегда работают в фоне. Глубина вложенности по умолчанию 1, прогрев кэша на субагентов не распространяется ([V2 agents](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/agents.mdx); [warming](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/warming.mdx)).

**Команды** лежат в `.opencode/command(s)/*.md` и поддерживают `$ARGUMENTS`, `$1..$n`, `` !`git log --oneline -10` ``, `@file`. Флаг `subtask: true` (V1) или `subagent: true` (V2) нужен, «чтобы не засорять основной контекст» ([V1 commands](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/v1/content/commands.mdx)). Каждый субагент заново оплачивает фиксированный префикс, поэтому промпты и наборы инструментов у них должны быть минимальными.

### 3.6. Кэш промптов и что его ломает

V1 ставит `cacheControl: ephemeral` на первые 2 системных и последние 2 несистемных сообщения для Anthropic-подобных маршрутов. `promptCacheKey = sessionID` он задаёт для `@ai-sdk/openai`, `azure`, `xai`, `mistral` и для любых провайдеров с `setCacheKey: true` ([V1 transform.ts](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/provider/transform.ts)). В V2 есть `compatibility.cacheFormat: "anthropic"` для прокси, `settings.cache.ttl` (`"5m"`/`"1h"` у Anthropic, `"24h"` у OpenAI) и выключенный по умолчанию `warming`, причём прогревочные запросы оплачиваются ([V2 models](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/models.mdx); [warming](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/warming.mdx)).

Ломает кэш всё, что меняет ранний байт: правки system, строка даты (#5224), эфемерное маскирование, вырезанный reasoning при повторе на локальном llama.cpp (#19081: расхождение на ~18 тыс. токенов и повторный пересчёт ~19 тыс.), смена списка инструментов ([#5224](https://github.com/anomalyco/opencode/issues/5224); [#19081](https://github.com/anomalyco/opencode/issues/19081)). У DCP hit rate кэша ~85% против ~90% без плагина ([DCP](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)). Отдельно о GigaChat: opencode **не выставляет `X-Session-ID` сам**. Заголовок придётся добавить хуком `chat.headers` или на прокси **[оценка]**.

### 3.7. Провайдеры: OpenAI-compatible, локальные модели, GigaChat

В V1 провайдер задаётся через `provider.<id>.npm: "@ai-sdk/openai-compatible"` с `options.baseURL`, `options.headers` и `models.<id>.limit.{context, output}` ([V1 providers](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/v1/content/providers.mdx)). В V2 — через `providers.<id>.package: "@opencode/ai/providers/openai-compatible"` с `settings.baseURL`, `settings.apiKey: "{env:…}"` и `models.<id>.{modelID, capabilities.tools, limit}` ([V2 models](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/models.mdx)). Две ловушки V2 для малых моделей:

- неизвестная модель получает лимиты «200,000-token context» и «32,000-token output»;
- автообнаруженные модели vLLM стартуют **с выключенными tools**.

Для малых моделей `limit.context` нужно выставлять явно: от него зависит порог компакции ([V2 providers](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/providers.mdx)).

Специальной интеграции opencode с GigaChat нет. Готовый путь — прокси **gpt2giga**. В его репозитории лежит `opencode.json` с провайдерами `@ai-sdk/openai-compatible` на `http://localhost:8090` (`GigaChat-2`), `:8091` (`GigaChat-2-Pro`) и `:8092` (`GigaChat-2-Max`, `"limit": {"context": 128000, "output": 128000}`) ([opencode.json в gpt2giga](https://raw.githubusercontent.com/ai-forever/gpt2giga/main/opencode.json)). Прокси нужен ещё и потому, что токен доступа GigaChat живёт 30 минут ([Совместимость с OpenAI](https://developers.sber.ru/docs/ru/gigachat/guides/compatible-openai)). Подробности по GigaChat — в §8.

---

## 4. Куда уходят токены в агентных конвейерах (§куда уходят токены): в повторное чтение, а не в генерацию кода

Все доступные замеры говорят одно: деньги уходят на **input**, то есть на повторное чтение накопленной истории, выводов инструментов и файлов. На генерацию кода приходится меньшая часть. Самый близкий аналог многостадийного конвейера — исследование Tokenomics (MSR 2026; ChatDev + GPT-5, 30 задач). Там **итеративное Code Review заняло в среднем 59,4% токенов**, а соотношение input/output/reasoning составило 53,9/24,4/21,6, то есть примерно 2:1 в пользу input. Coding — единственная фаза, где доминирует output (58,0%) ([arXiv 2601.14470](https://arxiv.org/html/2601.14470)). Это предварительное исследование на одном фреймворке и одной модели **[незав.]**. Средние по фазам там посчитаны на разных подмножествах задач и в сумме дают ~127%, так что строгим разбиением их считать нельзя.

| Фаза (ChatDev + GPT-5) | Доля токенов | input / output / reasoning, % |
|---|---|---|
| Code Review (итеративное) | 59,4% | 51,4 / 24,7 / 23,9 |
| Code Completion (только 6 задач) | 26,8% | — |
| Documentation | 20,1% | 80,2 / 8,3 / 11,5 |
| Testing (12 задач) | 10,3% | 60,8 / 20,7 / 18,4 |
| Coding | 8,6% | 6,9 / 58,0 / 35,1 |
| Design | 2,4% | 60,4 / 3,6 / 36,0 |

Работа Bai et al. (NeurIPS 2026; OpenHands на SWE-bench Verified, 8 моделей, 4 прогона на задачу) показывает то же на одноагентных циклах. Стоимость определяет input, «even when token caching is enabled». Чтения из кэша доминируют и по объёму, и по деньгам в каждой фазе: output стоит ~80× дороже чтения из кэша для Sonnet 4.5, но контекст накапливается ([arXiv 2604.22750](https://arxiv.org/pdf/2604.22750)). Доли раундов по фазам: Setup 9,98%, **Explore 30,37%, Fix 33,53%**, Validate 16,59%, Closeout 9,53%. Скачки стоимости дают действия, которые добавляют в контекст новый материал: исследование репозитория, запуск тестов, итоговые сводки. У дорогих моделей около **50% файловых действий — повторы**. Точность растёт до средней стоимости прогона, а дальше насыщается или падает **[незав.]**. В статье есть внутренние расхождения. Разброс токенов на одной задаче в аннотации назван «до 30×», а в разделе 3 — ~2× по модели. Агентные задачи дороже чата «~1000×» в аннотации и 3500×/1200× в тексте. У Manus среднее отношение input:output «около 100:1», ~50 вызовов инструментов на задачу, а KV-cache hit rate назван «самой важной метрикой» продакшн-агента ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)) **[самоотчёт]**. Качество кода тоже влияет на расход: каждый пункт CodeHealth в пятиагентном ревью-конвейере дал на 3,5–6,1% меньшую стоимость, потому что на нездоровом коде агенты больше итерируют ([arXiv 2610.21914](https://arxiv.org/abs/2610.21914)).

Данные по самим SDD-фреймворкам подтверждают, что цена — именно перечитывание артефактов. В бенчмарке Uvik (50 brownfield-тикетов на Python, claude-sonnet-5, прогон 15.10.2026, обновление 02.11.2026) фаза спецификации заняла в среднем **35,1%** токенов. OpenSpec оказался самым лёгким по спеке ([Uvik](https://uvik.net/blog/spec-driven-development-benchmark/)) **[незав.**; одна команда, один язык, одна модель**]**:

| Плечо | Медиана, фаза спеки | Медиана, фаза сборки |
|---|---|---|
| OpenSpec | 104 924 | 265 717 |
| Kiro | 130 986 | 276 962 |
| Spec Kit | 147 206 | 286 138 |
| BMAD | 227 212 | 290 429 |
| Без спеки | — | 331 936 |

У OpenSpec merge rate 84%, $2,71 за смёрженный тикет, дрейф спеки 2,4%. SDD помог на фичах и тикетах, затрагивающих ≥3 файлов, и не помог на багфиксах и рефакторинге. Команда RuStore сравнила Spec Kit 0.16.0 и OpenSpec 1.9.0 со своей цепочкой скиллов на Opus 5. Оба SDD-инструмента потратили больше input, и **основной прирост дали cache reads: каждая стадия перечитывает прежние артефакты**. Цифры опубликованы только скриншотами ([RuStore, 17.09.2026](https://rustore.ru/developer/blog/spec-kit-i-openspec-v-realnom-android-proekte-testiruem-sdd-na-zadachah-rustore)). Опубликованной постадийной разбивки токенов для конвейера OpenSpec + opencode нет, и именно её команде предстоит снять.

Механика расхода в нашем стеке объясняет, почему это так. Input одного прогона примерно равен сумме по всем вызовам LLM трёх слагаемых:

- фиксированного префикса: системный промпт, схемы инструментов, `AGENTS.md`, список скиллов;
- артефактов, которые прочитала стадия;
- истории, накопленной в сессии, включая выводы инструментов.

Число вызовов работает как множитель. Возьмём для иллюстрации 10 задач по 20 шагов: 200 вызовов × префикс в 8 тыс. токенов дают ~1,6 млн входных токенов на один только префикс, пусть и в основном из кэша **[оценка]**. Отсюда гипотеза о порядке расхода в конвейере кейса. Она выведена по аналогии с измеренными системами, а не измерена на OpenSpec **[оценка]**:

| Стадия | Механизм расхода в OpenSpec + opencode | Ожидаемая доля |
|---|---|---|
| Ревью (3–5 итераций) | каждая итерация заново читает спеку, код, дифф и прошлые замечания; verify-скилл ~4–5 тыс. токенов плюс все артефакты плюс поиск по коду | самая большая (аналог 59,4% у Tokenomics) |
| Реализация (8–12 задач) | apply-скилл плюс полное чтение `contextFiles` на каждую задачу, перезапуск `instructions apply --json`, логи тестов до 50 KB, повторные чтения файлов, LSP-диагностика | вторая (Explore + Fix ≈ 2/3 раундов у Bai et al.) |
| Верификация | логи тестов и линтеров, повторное чтение артефактов | третья |
| Артефакты (proposal/specs/design/tasks) | скилл propose плюс инструкции артефактов (specs ~1,7 тыс.), исследование кода, **output** на генерацию текста | 28–44% в Uvik; в ChatDev Design — 2,4% |
| Накладные расходы | title/summary-вызовы, компакция, субагенты, ретраи | выделять отдельной строкой |

Расхождение в доле спеки (35% у Uvik против 2,4% у ChatDev) — повод замерить её самим, а не догадка в пользу одной из оценок. Постадийная таблица из ваших прогонов — это и есть ответ на критерий на 15%.

---

## 5. Техники экономии с доказательствами (§техники): сначала убрать повторное чтение, потом сжимать

### 5.1. Ранжированный каталог

Ранг в таблице — суждение исследователей. Оно объединяет измеренные эффекты со структурой конвейера кейса. Ограничения кейса (та же модель и провайдер, без урезания требований и стадий) исключают методы, которым нужна вспомогательная модель, — их статус указан отдельно в §5.9.

| # | Техника | Стадия | Реализация в OpenSpec + opencode | Доказательство | Риск для качества | Малые модели |
|---|---|---|---|---|---|---|
| 1 | Срез спеки на задачу + индекс требований + чтение по требованию | реализация, ревью | `show <change> --json`, `show <spec> --json -r N`, ID `[REQ-…]` в заголовках, `rules.tasks` с «covers» | прямых замеров нет; сфокусированный промпт (~300 ток.) лучше полного (~113 тыс.) у всех 18 моделей ([Chroma](https://www.trychroma.com/research/context-rot)) **[незав.]** | потеря сквозных требований; страхует trace-check | сильный плюс |
| 2 | Детерминированное состояние вместо LLM-циклов скилла | все | оркестратор вызывает `status/instructions/validate/archive --json` | следует из механики скилла apply (§2.4) **[оценка]** | нет | плюс |
| 3 | Урезанный фиксированный префикс | все вызовы | короткий `prompt`/`system`, deny для `webfetch`/`websearch`/`todowrite`/`task`/`lsp`/`question`, минимум скиллов и MCP, короткий `AGENTS.md` и `config.yaml context` | база V1 7–15 KB против 1 KB в V2; дубли скиллов ~5–7 тыс. токенов ([#22236](https://github.com/anomalyco/opencode/issues/22236)); OpenSlimedit −22…−45% **[самоотчёт]** | слабым моделям может не хватить инструкций | обычно плюс, проверять |
| 4 | Маскирование наблюдений (последние M≈5–10 выводов дословно) | циклы реализации и ревью | `experimental.chat.messages.transform` порциями или `compaction.prune: true` (V1) | −50…−57% стоимости, solve rate в пределах CI ([Complexity Trap](https://arxiv.org/html/2508.21433v3)) **[незав.]** | ломает кэш в точке правки; −2…−4 п.п. в части конфигураций | хорошо, подбирать M |
| 5 | Сжатие вывода тестов и логов (только падения, дедуп, полный лог в файл) | реализация, верификация | обёртка над test-runner + `tool.execute.after` + `tool_output.max_bytes` | RTK 60–90% вывода **[самоотчёт]**, end-to-end ~0% **[незав.]**; Squeez −92% при recall 0,86 **[авторы метода**, нужна доп. модель**]** | скрытая первопричина ошибки | отлично (детерминированно) |
| 6 | Ревью по дельте со структурными замечаниями и детерминированными гейтами | ревью | итерация 1 — дифф + чек-лист ID; итерации 2..N — только Δ + открытые замечания в JSON | 5–15× меньше токенов и до 2,17× выше SEM-F1 ([OpenCodeReview](https://arxiv.org/abs/2608.09290)) **[авторы метода]** | пропуск межфайловых проблем; страхует blast radius | хорошо |
| 7 | Кэш стабильного префикса + детерминированная сериализация | все | порядок tools → system → правила → repo map → артефакты → задача; `X-Session-ID` для GigaChat | скидки 90–98% на кэшированный input (документация провайдеров) | нейтрально по построению | универсально, если провайдер поддерживает |
| 8 | Точечное чтение кода (окна, символы, repo map) | propose/design, реализация | карта файлов и символов в design/tasks; repo map ~1 тыс. токенов в префиксе; Serena по желанию | окно 100 строк 18,0% против полного файла 12,7% ([SWE-agent](https://arxiv.org/html/2405.15793v3)) **[авторы метода]**; Serena 79 тыс. против 861 тыс. ([Habr](https://habr.com/ru/articles/1042880/)) | инфраструктура под каждый язык | хорошо |
| 9 | Экономия на выходе: правки диффом, краткий структурный вывод | coding, отчёты ревью | search/replace-правки, JSON-замечания без пересказа кода | udiff 20%→61% на laziness-бенчмарке ([aider](https://aider.chat/docs/unified-diffs.html)) **[самоотчёт]**; caveman −8,5% output ([JetBrains](https://blog.jetbrains.com/ai/2026/07/speak-to-ai-agents-like-cavemen-tosave-tokens/)) **[незав.]** | малые модели путают формат диффа | смешанно |
| 10 | LLM-суммаризация истории | только длинные сессии | `experimental.session.compacting` со своим SDD-промптом | −41…−55% стоимости, но траектории на 13–15% длиннее, сводка съедает до 7,2% ([Complexity Trap](https://arxiv.org/abs/2508.21433)) **[незав.]** | теряет ID требований | хуже маскирования |
| 11 | Потокенная компрессия промпта (LLMLingua-2, LongCodeZip) | не рекомендуется | — | 2–5× на общем тексте, 5,6× на коде **[незав.**, не на агентах**]** | ломает синтаксис и идентификаторы; нужна доп. модель | неясно |

### 5.2. Срез спеки и детерминированное состояние: главный рычаг, специфичный для SDD

Прямых исследований «требование-уровневого» среза спеки в SDD нет. Косвенные данные сильны, и все они говорят о качестве, а не только о цене. Chroma «Context Rot» (18 моделей, 194 480 вызовов) показала, что на LongMemEval сфокусированные промпты (~300 токенов) обходят полные (~113 тыс.) у всех моделей, а дистракторы ухудшают результат накопительно ([Chroma](https://www.trychroma.com/research/context-rot)). «Lost in the Middle» показывает U-образную точность: лучше всего модель использует материал в начале и в конце контекста ([arXiv 2307.03172](https://arxiv.org/abs/2307.03172)).

Реализация на примитивах OpenSpec выглядит так **[оценка]**. При генерации `tasks.md` каждая задача получает список ID требований и сценариев и файлов/символов, которые она трогает. Это делается правилом `rules.tasks` или схемой `spec-driven-lean`. На каждую задачу агент получает три части:

1. кэшируемый общий префикс: правила, repo map и компактный индекс всех ID с однострочными заголовками;
2. полный текст **только** своих требований и сценариев из `openspec show --json`, плюс относящиеся к задаче решения `### D<n>` из design.md (шардинг в стиле BMAD);
3. саму задачу, в самом конце, рядом с инструкцией.

Полная спека остаётся на диске для чтения по требованию. Покрытие 100% сохраняется: каждый ID назначен хотя бы одной задаче и проверяется детерминированным trace-check (§7.3). Отметку галочек и проверку прогресса оркестратор делает сам, без перезапуска `instructions apply --json` внутри LLM-сессии. Кэш общего префикса помогает и подходу «читать всё», поэтому выигрыш среза в оплачиваемых токенах меньше, чем в сырых. Зато выигрыш в качестве, за счёт меньшего числа отвлекающих фрагментов, больше всего на малых моделях.

### 5.3. Маскирование наблюдений надёжнее LLM-сводок

Лучше всего доказанное реальное сокращение токенов — замена старых выводов инструментов однострочными заглушками. В «The Complexity Trap» (JetBrains Research и др.; SWE-agent, SWE-bench Verified 500, окно M=10) маскирование сравнили с LLM-сводкой, которая сжимает 21 ход и оставляет 10 ([arXiv 2508.21433v3](https://arxiv.org/html/2508.21433v3)) **[незав.]**:

| Модель | Solve rate: Raw → маскирование → LLM-сводка | Стоимость маскирования относительно Raw |
|---|---|---|
| Qwen3-Coder-480B | 53,4 → 54,8 → 53,8 | −52,7% |
| Gemini 2.5 Flash | 32,8 → 35,6 → 36,0 | −56,1% |
| Gemini 2.5 Flash (thinking) | 40,4 → 36,4 → 31,4 | −57,1% |
| Qwen3-32B (non-thinking) | 17,0 → 15,0 → 16,0 | −50,9% |
| Qwen3-32B (thinking) | 23,0 → 24,6 → 24,8 | −9,8% |

95% CI по solve rate составляют около ±3–4 п.п. LLM-сводки удлиняют траекторию: у Qwen3-Coder на 15% относительно Raw, потому что сводка прячет сигналы остановки. Гибрид «сначала маскирование, потом сводка» дал ещё −7% ([arXiv 2508.21433](https://arxiv.org/abs/2508.21433)). В SWE-agent хранение только последних 5 наблюдений дало 18,0% против 15,0% с полной историей ([arXiv 2405.15793](https://arxiv.org/html/2405.15793v3)). У Anthropic очистка устаревших tool results сократила токены на **84%** в 100-ходовом eval веб-поиска (не код) и дала +29% качества ([Claude](https://claude.com/resources/articles/context-management)) **[самоотчёт]**. ACON (Microsoft) сократил пиковые токены на 26–54% и помог малым моделям «до 46%» за счёт меньшего отвлечения ([arXiv 2510.00615](https://arxiv.org/abs/2510.00615v2)) **[авторы метода]**.

Для конвейера из этого следует: маскировать в циклах реализации и ревью, а не суммаризировать. Маскирование детерминировано, не требует дополнительного вызова LLM и не теряет ID требований. Заглушку стоит делать восстановимой, например `[вывод pytest -q опущен: 3 падения, полный лог: runs/…/t3.log]`. У Qwen3-32B non-thinking маскирование стоило 2 п.п., поэтому окно M нужно подобрать на вашей малой модели.

### 5.4. Сжатие вывода тестов работает, только если сохранить детали падений

Вывод тестов и исследование репозитория — главные источники скачков стоимости ([Bai et al.](https://arxiv.org/pdf/2604.22750)). Детерминированный фильтр «только падения» — переносимая база. Обёртка над test-runner выдаёт «N passed, M failed» и для каждого падения: id теста, сообщение assert, верхние кадры трейса проекта, не больше K строк. Полный лог пишется в файл, передаётся путь. Линтеры группируются по правилам, сборка оставляет только ошибки, а `git diff --stat` идёт раньше полного диффа.

В opencode это ставится в `tool.execute.after` (V1), где результат постоянный и не ломает кэш, или в `tool.execute.before` подменой команды. Сверху ставится понижение `tool_output.max_bytes`. Manus предупреждает: ошибки и стектрейсы надо оставлять в контексте, иначе модель повторит промах ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).

Масштаб эффекта надо оценивать трезво. RTK заявляет 60–90% на выводе команд по эвристике bytes/4 и сам отмечает, что экономия «размывается» ([RTK](https://github.com/rtk-ai/rtk)) **[самоотчёт]**. Независимые парные тесты дали другую картину:

- **Quesma** (Terminal-Bench 2.1, 1 740 попыток, в том числе OpenCode 1.18.25 + DeepSeek V4 Pro): итоговые траты −5% и +5%, pass rate 84→83% и 71→69%. На DeepSeek символов вывода стало на 9% меньше, но prompt-токенов на 9% больше из-за 18% лишних ходов. Чтения из кэша составили 94–98% input, но только 26–30% счёта ([Quesma](https://quesma.com/blog/does-rtk-make-ai-coding-cheaper/)).
- **JetBrains** (Claude Code, 86 задач SkillsBench, ~425 прогонов): медианная стоимость +7,6% (p=0,004) на low effort. Хук видел лишь треть Bash-вызовов, и максимально достижимая экономия была ~3% input ([JetBrains](https://blog.jetbrains.com/ai/2026/07/rtk-claude-code-token-savings/)).

Вывод: в SDD фильтровать стоит вывод test-runner'ов, которые конвейер запускает сам и детерминированно, а эффект доказывать оплачиваемыми токенами.

### 5.5. Ревью по дельте и детерминированные гейты сокращают и токены, и итерации

OpenCodeReview (август 2026) объединил три приёма: детерминированный rule-guided выбор файлов и критериев, параллельные субагенты по файлам и «Independent Reflection», которая видит только дифф. По сравнению с Claude Code и Codex на шести LLM на AACR-Bench (200 реальных PR, 10 языков, 1 505 экспертных комментариев) он потребил **в 5–15× меньше токенов** при **до 2,17× более высоком SEM-F1** (25,10% против 11,57%) ([arXiv 2608.09290](https://arxiv.org/abs/2608.09290)) **[авторы метода**; одноразовое ревью, не итеративное**]**.

Перенос на конвейер **[оценка]** устроен так:

1. Первая итерация ревью получает дифф изменения, символы в радиусе влияния (blast radius) и чек-лист по одной строке на каждый ID требования и сценария.
2. Итерации 2..N получают только Δ с прошлой итерации и список открытых замечаний в JSON вида `{id, file, line, req_id, severity, status}`. Закрытые замечания повторно не разбираются.
3. До любого LLM-ревью проходит цепочка гейтов: formatter → linter → type checker → unit tests → trace-check. LLM получает только остаток: падения, непокрытые ID и дифф.

Арифметика: каждая итерация заново оплачивает контекст, поэтому сокращение итераций с 5 до 3 само по себе снимает ~40% токенов стадии ревью. lint-on-edit в SWE-agent дал +3 п.п. resolve rate, так что гейты одновременно экономят и повышают качество ([arXiv 2405.15793](https://arxiv.org/html/2405.15793v3)).

### 5.6. Кэш префикса: самая безопасная экономия, но учитывать её отдельно

Кэш не меняет ни токенов, ни ответов, поэтому качество при нём нейтрально по построению. Сокращает он **оплачиваемую стоимость и задержку, но не объём обработанных токенов и не загрузку окна**. Условия по провайдерам на ноябрь 2026:

| Провайдер | Цена чтения из кэша | Цена записи в кэш | Минимум | Поля usage |
|---|---|---|---|---|
| Anthropic | 0,1× базы (Opus/Sonnet 5.5 — 0,05×) | 1,25× (TTL 5 мин) / 2× (1 ч) | 512–4 096 токенов в зависимости от модели | `cache_read_input_tokens`, `cache_creation_input_tokens`, `input_tokens` |
| OpenAI (GPT-5.6+) | 0,1× | 1,25× (30 мин) / 2,5× (12 ч) | 1 024 | `usage.input_tokens_details.cached_tokens` |
| Gemini 2.5+ | 10% цены input, неявный кэш | — | 2 048 / 4 096 | — |
| DeepSeek | скидка ≈96,7–98% | — | — | `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` |
| GigaChat | **не тарифицируется** | — | не опубликован | `precached_prompt_tokens`; кэш по заголовку `X-Session-ID` |

Источники: [Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching); [OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching); [Gemini](https://ai.google.dev/gemini-api/docs/pricing); [DeepSeek](https://api-docs.deepseek.com/quick_start/pricing); [GigaChat](https://developers.sber.ru/docs/ru/gigachat/guides/keeping-context). У Anthropic смена определения инструментов инвалидирует весь кэш, а префикс читается в порядке tools → system → messages. У OpenAI переиспользование требует совпадения всего отрендеренного префикса.

Для конвейера префикс упорядочивается так: определения инструментов → system и правила агента → проектный контекст (repo map, короткий `AGENTS.md`) → артефакты OpenSpec изменения → инструкция стадии → история, только дописываемая. Всё переменное (ID задачи, дата, дифф) идёт после последней точки кэша. Сериализацию надо сделать детерминированной:

- сортированные списки файлов;
- фиксированный порядок ключей JSON;
- никаких таймстемпов в начале.

На vc.ru автор 17 локальных MCP обнаружил, что поиск файлов возвращал результаты в другом порядке примерно в 7 из 10 прогонов, и сортировка это исправила. Его формулировка: «одно большое сжатие на одном ходе не окупает потерю кэша на каждом следующем» ([vc.ru](https://vc.ru/dev/2945685-sokrashchenie-raskhoda-tokenov-v-claude-code-s-lokalnymi-mcp)) **[самоотчёт]**.

Конфликт кэша и маскирования разрешается двумя способами: маскировать порциями при достижении порога и держать длинный стабильный префикс перед зоной подрезки. TTL тоже важен. Пауза между итерациями ревью дольше 5 минут промахивается мимо 5-минутного кэша. Длинный TTL окупается, только если на одну запись приходится несколько чтений по 0,1× **[оценка]**.

### 5.7. Точечное чтение кода вместо целых файлов

В абляциях SWE-agent (GPT-4 Turbo, SWE-bench Lite) просмотр окном в 100 строк дал 18,0%, окном в 30 строк — 14,3%, целым файлом — **12,7%**. Сводный поиск дал 18,0% против 12,0% у итеративного ([arXiv 2405.15793](https://arxiv.org/html/2405.15793v3)) **[авторы метода]**. В русскоязычном сравнении 21 способа сбора контекста (Agno, gpt-4.1-mini, метрика Success Per Token) результаты такие:

- на средней задаче ugrep справился за ~2 697 токенов, а read-all + repo_map потратил 175 208 и провалился;
- на сложной задаче Serena прошла 6/6 за ~79 тыс. токенов против ~861 тыс. у codex-like конфигурации, то есть примерно в 11× дешевле.

Вывод автора: инструмент подбирают под сложность задачи. Харнесс `letya999/tools-token-economy` открыт, но без лицензии ([Habr](https://habr.com/ru/articles/1042880/); [GitHub](https://github.com/letya999/tools-token-economy)) **[незав.**, один автор**]**. aider строит ранжированную карту репозитория с бюджетом `--map-tokens` 1 тыс. ([aider](https://aider.chat/docs/repomap.html)). SWE-Pruner сокращает токены на 23–54% на SWE-bench Verified, но использует вспомогательную модель на 0,6B ([arXiv 2601.16746](https://arxiv.org/abs/2601.16746)).

Применение **[оценка]**:

- design.md или tasks.md содержит явную карту «задача → файлы и символы»;
- apply читает только эти символы или окна строк;
- для propose и design годится сжатый скелет: `repomix --compress` или repo map в кэшируемом префиксе вместо исследовательских `ls`/`grep`/`cat` в каждой из 8–12 задач.

### 5.8. Экономия на выходе: правки диффом и краткие отчёты, без игр с reasoning

Output дорог за токен, но по объёму это меньшинство, кроме фазы Coding с её 58%. Search/replace- и udiff-правки не пересоздают файл целиком. У aider udiff поднял результат GPT-4 Turbo на laziness-бенчмарке с 20% до 61% ([aider](https://aider.chat/docs/unified-diffs.html)). Малые модели путают формат диффа, поэтому формат правок надо делать настраиваемым под модель. Краткий стиль по caveman в агентной работе сократил output лишь на 8,5% (592 тыс. → 542 тыс.) без потери качества (8 лучше / 10 хуже / 64 вничью, p=0,82). Заявленные 65% относятся к чат-вопросам ([JetBrains](https://blog.jetbrains.com/ai/2026/07/speak-to-ai-agents-like-cavemen-tosave-tokens/)) **[незав.]**. Ревьюеру стоит задать структурный JSON вместо пересказа кода, а реализатору — запретить прозаическое резюме в конце. Reasoning effort и параметры thinking надо зафиксировать одинаково в обоих плечах. Их смена меняет качество и может инвалидировать кэш, а по правилам кейса это скорее смена конфигурации модели, чем оптимизация.

### 5.9. Что не брать и почему

Потокенная компрессия LLMLingua-2 даёт 2–5× на общем тексте, но проверялась на MeetingBank, LongBench и GSM8K, а не на коде или агентах. PyPI-пакет `llmlingua` не обновлялся с 0.2.2 от 09.04.2024 ([arXiv 2403.12968](https://arxiv.org/abs/2403.12968); [PyPI](https://pypi.org/pypi/llmlingua/json)). Код терпит сжатие при r ≥ 0,6, но perplexity-методы выбрасывают «низкоперплексивные» числа и идентификаторы. Возврат сигнатур функций поднял pass rate с 5,3% до 39,3% ([arXiv 2602.15843](https://arxiv.org/abs/2602.15843)). Для спеки с ID и нормативными SHALL это прямой риск для 100% покрытия.

Под запрет «не менять модель/провайдера» попадает всё, что требует вспомогательной модели: Squeez, SWE-Pruner, LLMLingua, отдельная дешёвая модель для компакции (`agents.compaction.model`), роутинг стадий по моделям. Local-Splitter получил 45–79% экономии облачных токенов именно за счёт локального роутинга ([arXiv 2604.12301](https://arxiv.org/abs/2604.12301)), то есть сменой модели. Аргумент «дешёвая Lite для чтения, Max для кода» допустимо показать только как перспективу, вне зачётного A/B.

Ближайший к нашей задаче независимый результат на уровне обвязки дала команда Writer. Поиск через субагента со сводкой, статичный префикс под кэш, история вне контекста с подгрузкой по требованию и жёсткие лимиты на токены и шаги дали **−38% токенов** (14,2 тыс. → 8,8 тыс.), **−41% стоимости** и успех 78→81% (незначимо) на 22 корпоративных задачах, не кодовых ([arXiv 2607.06906](https://arxiv.org/abs/2607.06906)) **[авторы метода]**. Иллюстративная модель сложения эффектов в конвейере кейса выглядит так. Ревью занимает 50–60%, реализация 30–40%. Маскирование, ревью по дельте и сжатие логов вместе дают ~40–60% сокращения сырых токенов. Кэш затем снимает до ~90% стоимости оставшейся кэшированной доли **[оценка**, проверяется только своими прогонами**]**.

---

## 6. Готовые инструменты и лицензии (§инструменты): много плагинов, мало проверенных цифр, ничего под стадии OpenSpec

Экосистема opencode богата плагинами для подрезки, компакции, похудения схем, сжатия вывода и измерения. Почти ни один из них не знает о стадиях OpenSpec. Ближайший SDD-прецедент — расширение spec-kit-token-analyzer для Spec Kit, а не для OpenSpec. Независимый обзор pantheon-org (17 разборов инструментов, 17 воспроизведений бенчмарков) делает вывод, что «few claims are verified». Типичные ошибки, которые он называет: эвристика chars/4, байты вместо токенов, экстремальные базовые линии, скопированные таблицы и скрытые затраты (холодный старт, overhead `tools/list`) ([pantheon synthesis](https://pantheon-org.github.io/agentic-context/synthesis/)). Число звёзд приблизительное (снято со страниц GitHub в ноябре 2026). Версии и лицензии сверены с npm и PyPI 21.11.2026.

| Инструмент | Лицензия | Версия, дата | opencode | Механизм | Заявлено / независимо | Вердикт |
|---|---|---|---|---|---|---|
| DCP `@tarquinen/opencode-dcp` | **AGPL-3.0** | 3.2.1, 16.11.2026 | плагин V1 (≥1.18.29) | плейсхолдеры через `messages.transform`, инструмент `compress`, дедуп одинаковых вызовов, `purgeErrors` (4 хода); `.opencode/dcp.jsonc` | README цифр не даёт; «50–70%» встречается только в пересказе Upsun; кэш ~85% против 90% | сравнить как внешнюю базу; не встраивать (AGPL); разработка переходит в Sleev |
| Magic Context `@cortexkit/opencode-magic-context` | MIT | 0.49.68, 20.11.2026 | плагин | фоновый «historian», `ctx_expand`/`ctx_reduce` в безопасные для кэша моменты; отключает `compaction.auto`/`prune` | количественных заявлений нет | идея восстановимого сжатия |
| OpenSlimedit | MIT | 1.0.4, 16.02.2026 | плагин | короткие описания инструментов, относительные пути, `oldString` как диапазон строк | −21,8…−45,1% на 4 задачах, 5 моделях, по 1 прогону; регрессии до +248% на отдельных задачах **[самоотчёт]** | кандидат в аблацию «префикс» |
| opencode-snip | MIT | 3.0.1, 18.11.2026 | плагин | префикс `snip` для git/go/npm | 60–90% **[самоотчёт]** | только как аналог RTK |
| RTK | Apache-2.0 CLI (`rtk-oss`); движок и прокси BUSL-1.1 | — | TS-плагин | фильтрация, группировка, дедуп вывода 100+ команд | 60–90% **[самоотчёт]**; ~0% или рост end-to-end **[незав.]** | взять идею фильтра для test-runner |
| Headroom `headroom-ai` | Apache-2.0 | 0.44.0, 10.11.2026 | обёртка или прокси | AST-aware сжатие, восстановимый CCR + `headroom_retrieve`, CacheAligner; телеметрия включена (`HEADROOM_OFFLINE=1`) | ~20% для кодинг-агентов **[самоотчёт]** | опционально |
| context-mode | **ELv2** | 2.2.1, 17.11.2026 | `"plugin": ["context-mode"]` | песочница + FTS5/BM25-индекс вывода | «98%» в байтах **[самоотчёт]**; холодный старт 1–4 с (pantheon) | не встраивать (ELv2) |
| caveman | Apache-2.0 | `@caveman-ai/cli` 4.1.0, 08.11.2026 | поддерживается | краткий вывод, сжатие логов | −8,5% output **[незав.]** | не главное |
| Serena `serena-agent` | MIT или **GPL-3.0** (PyPI 2.1.0) | 2.1.0, 19.10.2026 | MCP | символы через LSP | эффективность «unverified»; 79 тыс. против 861 тыс. на Habr | проверить лицензию; опционально для apply |
| codebase-memory-mcp | MIT | 0.12.1, 16.10.2026 | указан в установщике | граф tree-sitter + SQLite | 10× **[самоотчёт]** | опционально |
| repomix | MIT | 1.19.0, 08.11.2026 | CLI/MCP | `--compress`: только сигнатуры | цифр нет | скелет для propose/design |
| opencode-tokenscope | MIT | 2.1.0, 11.11.2026 | плагин V1 | `/tokenscope`: записанное потребление отдельно от оценок, кэш, субагенты | — | взять для диагностики префикса |
| Langfuse plugin / opencode-plugin-otel | n/a / MPL-2.0 | ≥0.5.0 / 2.1.0 | плагины | трассы / OTel | — | опционально; Langfuse получает промпты |
| tokscale | MIT | 4.23.0, 15.11.2026 | читает данные opencode | сводка по агентам | — | сверка |
| LiteLLM | MIT | 1.110.2, 20.11.2026 | baseURL на прокси | теги `x-litellm-tags`, `LiteLLM_SpendLogs`, провайдер GigaChat | — | **главный измерительный прокси** |
| gpt2giga | n/a | 0.3.1 (0.3.3a1 — кандидат) | `opencode.json` в репозитории | OpenAI/Anthropic-совместимый прокси к GigaChat | — | обязателен для GigaChat |
| spec-kit-token-analyzer | MIT | v0.1.0 | Spec Kit, нужен порт | токены по стадиям + quality score + гейты | «lean»-пресет −46,8% **[самоотчёт]** | **портировать на стадии OpenSpec** |
| opencode-plugin-openspec | MIT | 0.1.4, 24.03.2026 | плагин | агент «OpenSpec Architect» пишет только в `openspec/**` | токен-функций нет | не нужен |

Источники: [DCP](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning); [Magic Context](https://github.com/cortexkit/magic-context); [OpenSlimedit](https://github.com/ASidorenkoCode/openslimedit); [opencode-snip](https://registry.npmjs.org/opencode-snip); [Upsun](https://developer.upsun.com/posts/ai/opencode-token-optimization); [RTK](https://github.com/rtk-ai/rtk); [Headroom](https://github.com/chopratejas/headroom); [context-mode](https://github.com/mksglu/context-mode); [caveman](https://raw.githubusercontent.com/JuliusBrussee/caveman/HEAD/README.md); [Serena PyPI](https://pypi.org/pypi/serena-agent/json); [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp); [repomix](https://repomix.com/guide/code-compress); [tokenscope](https://github.com/ramtinJ95/opencode-tokenscope); [Langfuse](https://langfuse.com/integrations/developer-tools/opencode.md); [otel](https://registry.npmjs.org/@devtheops/opencode-plugin-otel); [tokscale](https://registry.npmjs.org/tokscale); [LiteLLM](https://pypi.org/pypi/litellm/json); [gpt2giga](https://github.com/ai-forever/gpt2giga); [spec-kit-token-analyzer](https://speckit-community.github.io/extensions/token-analyzer); [opencode-plugin-openspec](https://github.com/Octane0411/opencode-plugin-openspec).

Из таблицы следуют три решения. Первое касается лицензий: для решения, которое СберТех может захотеть встроить, не годятся DCP (AGPL), context-mode (ELv2), движок RTK (BUSL-1.1), Sleev (собственная лицензия) и Taskmaster («MIT WITH Commons-Clause») ([npm task-master-ai](https://registry.npmjs.org/task-master-ai)). Лицензию Serena надо проверить. Безопасны MIT/Apache-инструменты: OpenSlimedit, Magic Context, tokenscope, Headroom, caveman, rtk-oss, repomix, codebase-memory-mcp, LiteLLM.

Второе — свой слой надо писать самим. Ни один инструмент не нарезает контекст по стадиям OpenSpec, а это и есть ниша решения. Из готового берутся идеи и измерители. Дизайн spec-kit-token-analyzer почти один в один ложится на требуемый отчёт:

- токены по стадиям: input, output, cache read, cache creation;
- веса quality score: полнота разделов 0,30, глубина 0,25, точность перекрёстных ссылок 0,20, применимость 0,15, формат 0,10;
- гейты приёмки: снижение >10% при дельте качества > −0,1.

Третье — сторонние плагины полезны как **внешние сравнения** в A/B. Например, плечо «baseline + DCP» показывает, что специализированный SDD-слой лучше универсального. Подключать их нужно по одному, с зафиксированными версиями: так рекомендует и Upsun ([Upsun](https://developer.upsun.com/posts/ai/opencode-token-optimization)).

---

## 7. Методика замеров, статистика и доказательство качества (§методика): один прогон ничего не доказывает

### 7.1. Нормализация учёта токенов (§учёт токенов): сначала договориться, что такое «input»

Эталоном служит то, что сообщает провайдер, с разбивкой по типам: некэшированный input, чтение из кэша, запись в кэш, output, reasoning. Снимать эти данные надо в двух независимых точках, и одно число «токенов» без разбивки не годится. Проблема в том, что провайдеры и харнессы по-разному решают, входит ли кэш в «input». Без нормализации одна и та же оптимизация кэша выглядит как 90% экономии в одном представлении и 0% в другом.

| Источник | Поле «input» | Кэш внутри? | Полный prompt | Комментарий |
|---|---|---|---|---|
| opencode `step_finish.tokens` (V1 и V2) | `input` | **нет** (`inputTokens − cacheRead − cacheWrite`) | `input + cache.read + cache.write` | в V1 `output = outputTokens − reasoning`, полный output = `output + reasoning` ([V1 session.ts](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/session/session.ts)) |
| GigaChat `usage` | `prompt_tokens` | **нет** («после вычитания кэшированных токенов») | `prompt_tokens + precached_prompt_tokens` | `total_tokens` — уже оплачиваемый итог, кэш не тарифицируется ([GigaChat](https://developers.sber.ru/docs/ru/gigachat/guides/counting-tokens)) |
| Anthropic | `input_tokens` | нет | `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` | ([Claude docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)) |
| OpenAI | prompt/input | да, кэшированная часть в `input_tokens_details.cached_tokens` | = input | включение кэша в input **[не проверено]** ([OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching)) |
| DeepSeek | `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` | раздельно | hit + miss | ([DeepSeek](https://api-docs.deepseek.com/guides/kv_cache)) |
| OTel GenAI | `gen_ai.usage.input_tokens` | SHOULD включать `cache_read`/`cache_creation` | = input | reasoning входит в `output_tokens`; конвенции в статусе Development ([OTel](https://opentelemetry.io/docs/specs/semconv/attributes-registry/gen-ai/)) |

Нормализуйте к конвенции OTel, где input включает кэш, и пишите в отчёте, какая конвенция использована. На каждый прогон и каждую стадию считайте три величины **[оценка]**.

**(а) Сырые обработанные токены** — полный prompt плюс полный output. Кэш их не уменьшает, и критерий «% экономии» проще всего проверить именно по ним.

**(б) Эффективные токены:** `uncached + w_cr·cache_read + w_cw·cache_write + w_out·output`, с весами из прайса провайдера. У GigaChat w_cr = 0, а прайс указан единой ценой за 1M токенов, так что эффективные токены совпадают с `total_tokens`.

**(в) Стоимость в рублях** по зафиксированному прайсу.

Кэш показывается как экономия по (б) и (в), отдельной строкой, а «настоящее» сокращение (срезы, маскирование, сжатие) — по (а). Так экономия не посчитается дважды, и судьям видно, где что. Дополнительно логируйте пиковый размер prompt на вызов, потому что для малых моделей важен именно он, а также число вызовов LLM и инструментов.

Есть особенность у GigaChat через opencode. Поле `cost` в opencode для своего провайдера без цены, скорее всего, будет нулевым, а как gpt2giga отображает `precached_prompt_tokens` в OpenAI-поля, которые читает AI SDK, неизвестно **[не проверено]**. Цепочку нужно откалибровать двумя одинаковыми запросами, сравнив лог прокси и `step_finish`.

Учёт ведётся из двух источников со сверкой. Первый — прокси: LiteLLM с тегом `x-litellm-tags: stage=…,run=…,arm=…,task=…`, теги которого попадают в `request_tags` таблицы `LiteLLM_SpendLogs` вместе с `spend` и `model` ([LiteLLM Request Tags](https://docs.litellm.ai/docs/proxy/request_tags)), или логирование `usage` в самом gpt2giga. Второй — данные opencode: NDJSON `run --format json` плюс `opencode db`. Если opencode не умеет ставить заголовок на стадию, запускайте каждую стадию отдельным процессом со своим ключом или тегом по умолчанию. Расхождение больше 1–2% обычно означает пропущенные ретраи, субагентов или title/summary-вызовы **[оценка]**.

Таксономия стадий должна быть фиксированной и одинаковой в обоих плечах: proposal, specs, design, tasks, implement[i] (i = 1..N), циклы test-fix, review[k], verify и отдельная стадия **overhead**: заголовки, компакция, субагенты, ретраи. Спрятанный overhead — частая причина потери доверия. Локальные токенизаторы годятся только для предварительной оценки размеров артефактов. У GigaChat для этого есть `POST /tokens/count` (в SDK `giga.tokens_count(input_=[...], model=...)`). Он не считает генерацию и файлы, а «в среднем в одном токене 3–4 символа» ([GigaChat](https://developers.sber.ru/docs/ru/gigachat/guides/counting-tokens)).

### 7.2. Дизайн эксперимента: сколько прогонов и какие тесты

Агенты стохастичны даже при T=0. В «On Randomness in Agentic Evals» (KTH, ICLR 2026; 60 000 траекторий, 25,58 млрд токенов) pass@1 в отдельных прогонах колебался на 2,2–6,0 п.п. ([arXiv 2602.07150](https://arxiv.org/html/2602.07150v2)) **[незав.]**:

- DeepSWE при T=0: 20,4% ± 1,0%;
- Qwen3-32B/R2E-Gym при T=0: 22,3% ± 1,8%;
- у Qwen3-32B/nano-agent SD при T=0 **выросло** с 0,7% до 1,2%;
- траектории расходятся почти сразу: медиана первого расхождения — 5–56-й токен.

Токены шумят ещё сильнее: самый дорогой прогон в среднем ~2× дешёвого, а в аннотации заявлено до 30× ([Bai et al.](https://arxiv.org/pdf/2604.22750)). Jarmak (август 2026) приводит три предупреждения ([arXiv 2608.13867](https://arxiv.org/pdf/2608.13867)):

- при <10 прогонах bootstrap даёт ~10% ложноположительных результатов на номинальных 5%;
- сравнение по пяти прогонам однажды признало значимо разными две выборки одной и той же реализации;
- разрыв +0,054 по одному прогону сжался до +0,0035 на трёх повторах.

Рекомендованный план **[оценка]**. Единица анализа — полный прогон конвейера от требований до верификации на чистом checkout. Главный исход — суммарные токены за прогон. Если SD log-токенов ≈ 0,3, то для обнаружения снижения на 30% с мощностью 80% нужно ~11 прогонов на плечо, а при 5 прогонах минимально обнаружимый эффект ~40%. Поэтому:

1. Пилот на 3–5 прогонов, чтобы измерить реальный SD.
2. Заголовочный A/B на одной модели — 8–10 прогонов на плечо.
3. Аблации — по 3–5 прогонов, описательно: эффект и CI без заявлений о значимости.

Ловушка точных тестов, которую стоит назвать на защите:

| Тест и выборки | Минимальное двустороннее p | Может ли дать p<0,05 |
|---|---|---|
| Mann-Whitney 3 против 3 | 2/20 = 0,10 | никогда |
| Mann-Whitney 4 против 4 | 2/70 ≈ 0,029 | только при полном разделении выборок |
| Mann-Whitney 5 против 5 | 2/252 ≈ 0,008 | да |
| Wilcoxon signed-rank, 5 пар | 2/32 = 0,0625 | никогда |
| Wilcoxon signed-rank, 6 пар | 2/64 ≈ 0,031 | да |

Статистика:

- **Главный эффект:** savings = 1 − median(B)/median(A) с bootstrap-CI 95% (percentile или BCa, 10 000 ресэмплов внутри плеч) и CI отношения средних.
- **Значимость:** Mann-Whitney U или Welch t на log-токенах.
- **Размер эффекта:** Cliff's δ или Hodges-Lehmann.
- **Несколько фич:** парность по фиче, Wilcoxon.
- **Pass/fail по задачам:** McNemar и pass^k.

Об оценке погрешности: Miller из Anthropic советует считать 95% CI как mean ± 1,96·SEM, кластеризовать ошибки по единице рандомизации (кластерные SE бывают >3× наивных) и использовать парные разности ([Anthropic](https://www.anthropic.com/engineering/statistical-approach-to-model-evals)).

Справедливость сравнения обеспечивают:

- одинаковые коммит репозитория, контейнер, версия модели, версии opencode и OpenSpec, текст требований и набор задач;
- чередование A и B (ABBA…), чтобы снять эффект времени суток у провайдера;
- одинаковые лимиты итераций;
- учёт всех упавших прогонов, без выбрасывания.

Сэмплинг берётся рекомендованный провайдером и одинаковый в обоих плечах. Seed задаётся там, где API позволяет. Температуру под плечо подбирать нельзя.

Аблации строятся по схеме leave-one-in (A + одна мера) и leave-one-out (B без одной меры). Вклад каждой меры атрибутируется по leave-one-out, потому что взаимодействия мешают эффектам складываться. Результат показывается водопадом с остатком на взаимодействие. До запуска B закоммитьте `experiment.yaml`: гипотезы, N, метрики, тесты, правило остановки. Это предрегистрация.

Пропускная способность. У физлица GigaChat генерирует в один поток ([тарифы](https://developers.sber.ru/docs/ru/gigachat/tariffs/individual-tariffs)), поэтому прогоны идут последовательно. Схема «2 плеча × 2 модели × 8 прогонов» — это 32 полных прогона. Реальную длительность прогона надо замерить в пилоте (E0) и по ней спланировать последовательные серии; N выбирается по анализу мощности, а не по длительности. Параллелить можно на локальной модели или, если условия это допускают, на аккаунтах разных участников.

### 7.3. Доказательство качества: детерминированные гейты, а LLM-судья только для подстраховки

Грамматика OpenSpec достаточно жёсткая, чтобы трассируемость проверялась машиной. Стабильные ID ставятся в заголовки обоих плеч: `### Requirement: [REQ-todo-3] Due dates`, `#### Scenario: [SCN-todo-3.1] …`. Задачи ссылаются на них: `- [ ] 2.1 … (REQ-todo-3; SCN-todo-3.1, 3.2)`. Тесты несут ID сценария одним из способов:

- в pytest — `@pytest.mark.req("SCN-todo-3.1")` или имя `test_SCN_todo_3_1_…`, сбор через `--junitxml`;
- в Jest/Vitest — `it('[SCN-todo-3.1] …')` и `--json`;
- в JUnit 5 — `@Tag`/`@DisplayName`.

Скрипт `trace-check` парсит `^### Requirement:`, `^#### Scenario:`, `tasks.md` и отчёт тестов, строит матрицу «требование → сценарии → задачи → тесты → статус» и **валит сборку**, если выполняется хотя бы одно условие **[оценка]**:

- у сценария нет теста;
- связанный тест не прошёл;
- у задачи нет ссылки на требование;
- у требования нет задачи;
- тест ссылается на неизвестный ID;
- в выходе оптимизированного плеча пропал хотя бы один ID требования или сценария из входа.

Последнее условие проверяется сравнением множеств ID и хешей нормализованного текста, и это прямое доказательство, что требования не урезаны. В тот же набор гейтов входит `openspec validate --strict --json`.

Покрытие строк само по себе обманчиво: «Some test suites achieve 100% coverage but only 4% mutation score» ([arXiv 2506.02954](https://arxiv.org/abs/2506.02954)). Поэтому качество подкрепляется ещё тремя сигналами:

- **diff coverage** изменённых строк: `pytest-cov`, `c8`, JaCoCo;
- **mutation score** только по изменённым файлам: mutmut, Stryker, PIT;
- **скрытый acceptance-suite** из 15–30 black-box тестов на фичу, написанных по требованиям до запуска агентов и хранящихся вне рабочего каталога агента. Это самый весомый сигнал, потому что ни одно плечо не может под него подстроиться.

Число итераций ревью считается механически: сколько циклов reviewer→fixer прошло до approve при зелёных гейтах, с потолком 5 и разбивкой замечаний по severity. Если оптимизированное плечо требует больше итераций, это уже учтено в суммарных токенах прогона.

LLM-судья годится только как вторичный сигнал. У судей есть систематические смещения: позиционное, к многословию и к собственным ответам ([Zheng et al., arXiv 2306.05685](https://arxiv.org/abs/2306.05685)). В «The Coin Flip Judge?» (arXiv 2606.13685) получены такие цифры:

- средний flip rate 13,6% при T=1,0;
- GPT-4o-mini выбирал первый ответ в 72% вопросов;
- согласие двух судей κ = 0,51;
- эквивалентные переформулировки меняли решение большинства в 25% случаев.

Отсюда минимальные требования к LLM-аудиту: ≥10 испытаний, случайный порядок, ≥2 судьи другой модельной семьи, скрытые метки плеч ([arXiv 2606.13685](https://arxiv.org/pdf/2606.13685)). Итоговые диффы обоих плеч стоит прогнать через один фиксированный «аудит-ревьюер». Так проверяется, что оптимизированный ревьюер не стал снисходительнее.

### 7.4. Стенд и подача результатов

Один прогон — одна команда `run.sh --arm A|B --model M --seed S --run-id R`. Она делает шесть шагов:

1. создаёт git worktree на зафиксированном SHA, `git clean -fdx && git reset --hard <sha>`;
2. поднимает прокси с тегами прогона;
3. прогоняет стадии OpenSpec + opencode, каждую отдельной тегированной сессией;
4. запускает гейты: тесты агента, скрытый suite, `trace-check`, `openspec validate --strict`, coverage, мутации;
5. выгружает SpendLogs и `opencode.db` в `runs/<id>/usage.jsonl`;
6. всё сносит.

`make bench N=10 MODELS="small large" ARMS="A B"` собирает `results.csv`. Фиксируются версии opencode, OpenSpec, ревизия и квантизация модели, движок инференса, digest образа и прайс-лист ([Jarmak](https://arxiv.org/pdf/2608.13867)). Демо-фича должна давать 3–5 требований с 8–15 сценариями и 8–12 задач, иметь тесты быстрее 30 секунд, обходиться без внешних сервисов и содержать краевые случаи (валидация, таймзоны, пагинация). Пример — «сроки + фильтр просроченных + сортировка» в TODO API на FastAPI или Express. Для портативности нужен второй репозиторий на другом языке с N=3–5.

Порядок слайдов:

1. Карточка постановки.
2. Заголовочная цифра с CI. Формат: «−X% эффективных токенов, 95% CI [−a%, −b%], N=10 против 10, Mann-Whitney p=…, та же модель, все гейты зелёные в 10/10».
3. Столбцы по стадиям A против B с разбивкой на uncached, cache read, cache write, output, reasoning. Это ответ на критерий на 15%.
4. Водопад аблаций.
5. Точечный график всех прогонов.
6. Таблица паритета качества: покрытие ID 100%, тесты, скрытый suite, мутации, diff coverage, итерации ревью, `validate`.
7. Та же панель для малой и крупной модели.
8. Портативность.
9. Угрозы валидности.

Сильнее всего технических судей убеждают сырые данные и перезапуск анализа одной командой. Вторые по силе — сверка токенов прокси с базой агента и дифф множеств ID требований.

---

## 8. Модели разного размера, включая GigaChat и открытые веса (§модели): экономия контекста должна помогать малым моделям сильнее

**API GigaChat.** С 16.07.2026 у API единый адрес **`https://api.giga.chat`**, OpenAI-совместимая база — `https://api.giga.chat/v1`. Токен доступа выдаёт OAuth `https://ngw.devices.sberbank.ru:9443/api/v2/oauth` со `scope=GIGACHAT_API_PERS`, и «токен доступа действует 30 минут». Совместимость с OpenAI лишь частичная ([changelog](https://developers.sber.ru/docs/ru/gigachat/changelog); [Совместимость с OpenAI](https://developers.sber.ru/docs/ru/gigachat/guides/compatible-openai)).

Кэш включается необязательным заголовком **`X-Session-ID`** с произвольной строкой; без него сервер присвоит uuid4. Если у запросов один ID и частично совпадающий контекст, этот контекст не пересчитывается. Среди сценариев документация прямо называет «ассистенты для написания кода, которые кэшируют кодовую базу». Документация утверждает, что необязательные заголовки поддерживаются «только в Python-библиотеках GigaChat», где ID задаётся через `gigachat.context.session_id_cvar.set(...)`, но её же curl-примеры содержат этот заголовок. Какие модели поддерживают кэш, не указано ([Работа с историей чата](https://developers.sber.ru/docs/ru/gigachat/guides/keeping-context)).

Описания функций и история в `messages` тоже считаются токенами ([Подсчёт токенов](https://developers.sber.ru/docs/ru/gigachat/guides/counting-tokens)). У GigaChat 3 шаблон чата пишет описания функций синтаксисом TypeScript, а не JSON, что, по словам Сбера, «до 30%» экономит токены ([Habr SberDevices](https://habr.com/ru/companies/sberdevices/articles/968904/)) **[самоотчёт]**. С 06.10.2026 поддерживаются параллельные вызовы функций в `POST /v2/chat/completions` с GigaChat 3 Ultra ([changelog](https://developers.sber.ru/docs/ru/gigachat/changelog)).

| Модель (API-имя) | Окно | Цена для физлиц | Freemium |
|---|---|---|---|
| GigaChat 2 Lite (`GigaChat` / `GigaChat-2`) | не подтверждено | 20M за 1 300 ₽ ≈ 65 ₽/1M | 250M |
| GigaChat 2 Pro (`GigaChat-2-Pro`) | не подтверждено | 3M за 1 500 ₽ ≈ 500 ₽/1M | 40M |
| GigaChat 2 Max (`GigaChat-2-Max`) | **128 000** | 3M за 1 950 ₽ ≈ 650 ₽/1M | 25M |
| GigaChat 3 Ultra (`GigaChat-3-Ultra`) | 128K у HF-версии Preview | платных тарифов «пока не имеют» | 50M |

Источники: [Модели](https://developers.sber.ru/docs/ru/gigachat/models); [Max](https://developers.sber.ru/docs/ru/gigachat/models/gigachat-2-max); [Ultra](https://developers.sber.ru/docs/ru/gigachat/models/gigachat-3-ultra); [тарифы для физлиц](https://developers.sber.ru/docs/ru/gigachat/tariffs/individual-tariffs). Всего freemium даёт **365 000 000** токенов. Срок 12 месяцев известен только из пересказа и **[не проверено]**. Генерация для физлиц идёт в один поток. Новые клиенты с 01.09.2026 оплачивают через cloud.ru. Для ориентира: медиана Uvik по OpenSpec — ~370 тыс. токенов на тикет (спека плюс сборка). Если ориентироваться на неё, 25M Max хватит на десятки прогонов, но конвейер кейса с 8–12 задачами и 3–5 ревью, скорее всего, тяжелее **[оценка]**.

**Подключение к opencode.** Прокси **gpt2giga** — FastAPI-сервер от ai-forever ([GitHub](https://github.com/ai-forever/gpt2giga); [Sber docs](https://developers.sber.ru/docs/ru/gigachain/tools/utilities/gpttogiga-proxy-server)):

- адрес по умолчанию `http://localhost:8090`, установка `pip install gpt2giga`, стабильная версия 0.3.1;
- маршруты `POST /chat/completions`, `/responses`, `/embeddings`, `GET /models`, Anthropic-маршруты `/messages` и `/messages/count_tokens`, Gemini-маршруты;
- переводит tools/function calling, structured output и SSE;
- README честно предупреждает: «GigaChat не является drop-in заменой OpenAI или Anthropic API».

Альтернатива — провайдер GigaChat в LiteLLM ([LiteLLM GigaChat](https://docs.litellm.ai/docs/providers/gigachat)). Тогда в одном прокси сойдутся и измерение, и теги стадий. Передаёт ли gpt2giga `usage` и `precached_prompt_tokens` клиенту и пробрасывает ли `X-Session-ID`, **[не проверено]**. Качество function calling через слой совместимости в связке с opencode тоже никем не описано.

**Открытые веса Сбера** под лицензией MIT ([Habr SberDevices](https://habr.com/ru/companies/sberdevices/articles/968904/); [HF Lightning 3.1](https://huggingface.co/ai-sage/GigaChat3.1-10B-A1.8B); [GGUF](https://huggingface.co/ai-sage/GigaChat3.1-10B-A1.8B-GGUF); [GigaChat 3.5](https://huggingface.co/collections/ai-sage/gigachat-35)):

- **GigaChat 3.1 Lightning** (`ai-sage/GigaChat3.1-10B-A1.8B`, MoE 10B, 1,8B активных) поддерживает tool calling в transformers, vLLM (`--tool-call-parser gigachat3`) и SGLang. Есть сборки FP8 и GGUF, запуск `docker model run hf.co/ai-sage/GigaChat3.1-10B-A1.8B`, HumanEval Plus 0,7317. У GigaChat 3 Lightning окно 256K, HumanEval+ 0,6951 и LiveCodeBench 0,2031; окно 3.1 не подтверждено.
- Крупные открытые модели — GigaChat 3 Ultra Preview / 3.1 Ultra (702B-A36B, окно 128K, HumanEval+ 0,8659) и GigaChat 3.5 (432B MoE, есть Reasoning-вариант от 10.09). На хакатоне запускать их локально непрактично.

Агентных бенчмарков (SWE-bench, BFCL) для Lightning не найдено. При 1,8B активных параметров эта модель может не пройти конвейер даже в базовом плече, и тогда процент экономии на ней ничего не значит. Практичная схема **[оценка]**: «малая» модель — GigaChat-2 Lite через API или Lightning локально, если она проходит пилот. «Крупная» — GigaChat-2-Max или GigaChat-3-Ultra на freemium. Lightning в любом случае полезна как стресс-демо «закрытого контура».

**Сторонние открытые модели** как контроль портативности:

- **Qwen3-Coder-30B-A3B-Instruct**: 3,3B активных, 256K нативно, сэмплинг T=0.7, top_p=0.8, top_k=20, repetition_penalty=1.05. Карточка советует снижать контекст до 32 768 при OOM ([HF](https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct)). SWE-bench Verified 51,6 в таблице baseline чужой статьи ([arXiv 2602.09892](https://arxiv.org/pdf/2602.09892)).
- **gpt-oss-20b**: SWE-bench Verified 37,4 / 53,2 / 60,7 на low/med/high reasoning, 3,6B активных, окно 131 072 ([arXiv 2508.10925](https://arxiv.org/html/2508.10925v1)).
- **Devstral Small 2 (24B)**: 68,0% по компиляции Modal, обвязка в основном не указана ([Modal](https://modal.com/resources/best-open-source-models-swe-bench-coding-agents)).

Цифры gpt-oss показывают, что reasoning effort двигает качество на десятки пунктов. Поэтому его фиксируют одинаковым в обоих плечах.

**Почему экономия контекста должна сильнее помогать малым моделям.** Длинный контекст ухудшает работу всех моделей. На NoLiMa при 32K 11 из 13 моделей опускаются ниже 50% своего результата на коротком контексте, GPT-4o падает с 99,3% до 69,7% ([arXiv 2502.05167](https://arxiv.org/abs/2502.05167)). Chroma видит деградацию у всех 18 моделей ([Chroma](https://www.trychroma.com/research/context-rot)). Малые модели вдобавок стартуют с более низкого уровня, локально часто работают с окном 32K и чаще ошибаются в формате tool calls, а ошибки порождают ретраи. Гипотеза для проверки: на малой модели оптимизированное плечо и экономит токены, и улучшает прохождение гейтов, а на крупной экономит при плоском качестве. Это не установленный факт. В Complexity Trap маскирование стоило Qwen3-32B non-thinking 2 п.п. ([arXiv 2508.21433v3](https://arxiv.org/html/2508.21433v3)), поэтому окно маскирования подбирается на самой малой модели.

Ловушки opencode для малых моделей:

- явно задать `limit.context`/`limit.output`, потому что V2 по умолчанию ставит 200K/32K;
- включить tools у автообнаруженных vLLM-моделей ([V2 models](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/models.mdx));
- на локальном llama.cpp помнить, что вырезанный reasoning ломает KV-кэш ([#19081](https://github.com/anomalyco/opencode/issues/19081));
- фиксировать квантизацию (Q4_K_M или FP8) и версию движка.

---

## 9. Практические выводы для команды: ранжированный план, чего не делать и что проверить на старте

### 9.1. Ранжированный план

Архитектура, которая закрывает все пять критериев, состоит из трёх слоёв **[оценка]**:

1. **Измерительный стенд**: прокси плюс NDJSON opencode плюс гейты качества.
2. **Файловый слой экономии**, переносимый между opencode V1/V2 и репозиториями: собственные скиллы в `.agents/skills/sdd-*`, агенты `.opencode/agents/sdd-*.md`, схема `openspec/schemas/spec-driven-lean/`, `opencode.json`, детерминированный оркестратор и `trace-check`.
3. **Тонкий плагин** с двойным экспортом V1 `server()` / V2 `setup()` для сжатия выводов, маскирования и заголовков.

Ранжирование ниже учитывает ожидаемый эффект и доказательную базу. Трудоёмкость реализации не учитывается: разработка идёт через Codex, объём кода не ограничен, поэтому реализуются все меры, а ранг задаёт порядок абляций.

| Ранг | Мера | Стадии | Где и как | Обоснование | Критерии |
|---|---|---|---|---|---|
| 0 | Стенд замеров и пилот N=3 до любой оптимизации | все | LiteLLM или gpt2giga с логированием `usage`; `opencode run --format json --title <run>/<stage>`; `opencode db`; `run.sh`, `experiment.yaml`, `results.csv` | без этого нет ни 35%, ни 15%; пилот даёт SD для выбора N (§7.2) | 35, 15 |
| 1 | Оркестратор над CLI OpenSpec: отдельная сессия на задачу, LLM не управляет состоянием | все | `status`/`instructions apply`/`validate --strict`/`archive -y` с `--json`; галочки по `sourcePath`/`line` ставит скрипт | убирает перезапуски apply-инструкций и преамбулы скиллов (§2.4) | 35, 10 |
| 2 | Срез спеки на задачу + ID в заголовках + «covers» в задачах | реализация, ревью | `show <change> --json`; `### Requirement: [REQ-…]`; `rules.tasks` в `config.yaml`; решения `### D<n>` по ссылке | Chroma, RuStore; качество растёт на малых моделях | 35, 25, 15 |
| 3 | Лёгкий префикс агентов | все вызовы | `.opencode/agents/sdd-impl.md` и др. с коротким `prompt` (V2 — `system`); deny `webfetch`/`websearch`/`todowrite`/`task`/`lsp`/`question`; проектные скиллы только для стадии; `AGENTS.md` и `config.yaml context` в несколько строк | база V1 7–15 KB + 14,5 KB описаний инструментов на каждом шаге (§3.4) | 35, 15, 10 |
| 4 | Сжатие вывода тестов и линтеров | реализация, верификация | обёртка `sdd-test` (сводка + падения + путь к полному логу) через `tool.execute.before/after`; `tool_output.max_bytes`/`max_lines` | запуск тестов даёт скачки стоимости; урок RTK — фильтровать то, что конвейер вызывает сам, и мерить по счёту (§5.4) | 35, 25 |
| 5 | Ревью по дельте + гейты + `trace-check` + лимит итераций | ревью, верификация | итерация 1 — дифф + чек-лист ID; дальше — Δ + JSON открытых замечаний; formatter → linter → types → tests → trace | OpenCodeReview: 5–15× меньше токенов и выше F1; с 5 до 3 итераций ≈ −40% ревью (§5.5) | 35, 25, 15 |
| 6 | Маскирование старых наблюдений | циклы реализации и ревью | V1: `experimental.chat.messages.transform` порциями по порогу или `compaction.prune: true`; V2: хук `context` | Complexity Trap: −50…−57% при solve rate в пределах CI (§5.3) | 35, 15 |
| 7 | Стабильный префикс и кэш | все | детерминированный порядок и сериализация; `X-Session-ID` = sessionID через `chat.headers` или на прокси; в V2 — `instructions.entry.put` вместо правки system | GigaChat не тарифицирует `precached_prompt_tokens`; показывать отдельной строкой (§7.1) | 35 |
| 8 | Схема `spec-driven-lean` | артефакты | `openspec schema fork` → короткие `instruction`, «ссылаться, а не пересказывать», опционально `trace.md`; `validate --strict` обязателен | дублирование между артефактами (#2215); лимит 500 символов на требование | 35, 10 |
| 9 | Карта файлов и символов + repo map / `repomix --compress` | propose, design, apply | раздел «File map» в design.md, чтение окнами | SWE-agent: окно лучше целого файла; Serena на Habr ≈ 11× (§5.7) | 35, 25 |

Чего не делать:

- **Менять модель или роутить стадии по моделям**, включая дешёвую модель для компакции. Это нарушает условие кейса.
- **Применять LLMLingua и другую потокенную компрессию к спекам и коду.** Она ломает идентификаторы и требует вспомогательной модели.
- **Править встроенные `openspec-*` скиллы**: `openspec update` молча сотрёт правки.
- **Подавать самоотчёты утилит** (`rtk gain`, `/dcp stats`) как доказательство экономии.
- **Встраивать AGPL/ELv2/BUSL-код.**
- **Мерить по одному прогону** или считать экономию без кэш-нормализации.
- **Менять reasoning effort между плечами.**

### 9.2. Как упаковать результат под критерии

За 35% отвечает заголовочная цифра по сырым и по эффективным токенам с CI и тестом. Кэш идёт отдельной строкой. За 25% — таблица паритета: 100% ID в матрице трассируемости, зелёные тесты, скрытый suite, diff coverage и мутации, итерации ревью, `validate --strict`. За 15% универсальности — та же таблица для малой и крупной модели, A/B внутри каждой. За 10% портативности — второй репозиторий на другом языке, где ставятся только файлы слоя и `trace-check` с адаптером тест-фреймворка. За 15% обоснования — постадийные столбцы базового плеча с разбивкой по типам токенов и ссылками на Tokenomics, Bai et al. и Uvik как внешнюю валидацию. Финальный аргумент — масштаб Сбера: 9 трлн токенов в месяц × ваш процент × публичный прайс, с пометкой «иллюстрация».

### 9.3. Стартовые проверки (до первых замеров)

- [ ] **Линия opencode:** `opencode --version`. Узнать, что стоит у жюри (`opencode-ai` 1.19.6 V1 или `@opencode/cli` 2.3.2 V2), и решить, под какую линию писать плагин; двойной экспорт `server()`/`setup()` — запасной вариант.
- [ ] **Скиллы OpenSpec 2.x в opencode:** после `openspec init --scope project --tools opencode` проверить, что выбранная линия opencode видит `.agents/skills/openspec-*` (вызов `/openspec-propose`, список скиллов в первом запросе). Если нет — закрепить OpenSpec 1.17.0 (`.opencode/skills` + `.opencode/commands/opsx-*.md`). Заодно выяснить, на какую версию рассчитан baseline кейса (`/opsx:*` = 1.x).
- [ ] **ID в именах требований:** проверить, что `openspec validate --strict` принимает `### Requirement: [REQ-1] …` и `#### Scenario: [REQ-1.1] …`, что `archive` корректно сливает MODIFIED с ID в имени, и что `show --json` отдаёт ID в `name`.
- [ ] **Реальные JSON-формы и размеры** `openspec instructions apply --json` и `status --json` на настоящем изменении. Отправляются ли `context`/`rules` из `config.yaml` целиком в каждом вызове `instructions`?
- [ ] **gpt2giga:** передаёт ли клиенту `usage` вместе с `precached_prompt_tokens` и в какие OpenAI-поля; пробрасывает ли `X-Session-ID`; работает ли function calling с opencode; обновляется ли 30-минутный токен. Альтернатива — провайдер GigaChat в LiteLLM.
- [ ] **Кэш GigaChat:** два одинаковых запроса с одним `X-Session-ID` к Lite и к Max. Даёт ли второй `precached_prompt_tokens > 0`?
- [ ] **Субагенты в учёте:** в V1 найти дочерние сессии (`GET /session/:id/children` или SQL по `parent_id`, узнать имя таблицы); в V2 проверить, попадают ли `step_finish` детей в NDJSON родителя.
- [ ] **Фиксированный префикс:** на «hi» для каждого агента снять `input + cache.read + cache.write` первого `step_finish`. Какой базовый промпт V1 выбирает для id `GigaChat-2-Max` (ожидается `default.txt`)?
- [ ] **Хуки:** в V1 входит ли `agent` во вход `chat.headers` (для тега стадии); в V2 сохраняется ли в истории заменённый `event.result` в `ctx.tool.hook("execute.after")`.
- [ ] **LSP в V1:** найти ключ, отключающий диагностику, и замерить её вклад в результаты `edit`/`write`.
- [ ] **Малая модель:** проходит ли Lightning через vLLM (`--tool-call-parser gigachat3`) базовое плечо; явно задать `limit.context`; в V2 включить tools у vLLM-модели.
- [ ] **Время и потоки:** замерить wall-time одного полного прогона на GigaChat (один поток у физлица) и от него выбрать N.
- [ ] **Правила:** в кабинете `/team/` и на открытии выяснить формат сдачи, разрешены ли вспомогательные модели и как жюри считает «% экономии» (сырые или оплачиваемые токены).

### 9.4. Главный вывод

Исследования переворачивают интуицию о том, что дорого в SDD. Сами спецификации — не главная статья расхода. Дорого то, что агент снова и снова перечитывает спецификации, код и логи, причём по инструкциям самого OpenSpec. Это делает задачу инженерной, а не алгоритмической. Выигрывает тот, кто отберёт у LLM управление состоянием и выбор контекста и отдаст их детерминированному коду. Так устроены Agentless и OpenCodeReview, которые дешевле и не хуже агентов со свободным исследованием ([Agentless, arXiv 2407.01489](https://arxiv.org/abs/2407.01489)).

Второй неочевидный вывод — экономия и качество здесь не конфликтуют. Те же меры, что режут токены (срезы, маскирование, гейты), по данным о context rot должны повышать качество, особенно на малых моделях. Значит, оптимизированный конвейер выгоден по всем пяти критериям сразу, если команда докажет это честным замером, а не процентами из README утилит.

---

## 10. Источники

**Хакатон и Сбер:** [hackathon.fpmi.tech](https://hackathon.fpmi.tech) · [кейсы](https://hackathon.fpmi.tech/cases) · [Telegram Студсовета](https://t.me/s/stfpmi?q=хакатон) · [kod.ru: Меньшов, GigaConf 2026](https://kod.ru/gigakonf-2026-kirill-menshov/amp) · [kod.ru: GigaConf, агенты в разработке](https://kod.ru/kak-ii-agenty-menyayut-razrabotku-gigaconf-2026/amp) · [kod.ru: GitVerse BYOK](https://kod.ru/gitverse-agentnyi-konveier-byok) · [CNews, июнь 2026](https://zoom.cnews.ru/soft/news/line/2026-06-19_ot_assistentov_k_agentam/print) · [Habr, блог Сбера](https://habr.com/ru/articles/1009838) · [ComNews, СберТех](https://www.comnews.ru/content/246655/2026-07-30/2026-w31/1018/ii-reshenie-sbertekha-pomozhet-biznesu-ekonomit-resursy-razrabotchikov-do-40)

**GigaChat:** [Работа с историей чата (X-Session-ID)](https://developers.sber.ru/docs/ru/gigachat/guides/keeping-context) · [Подсчёт токенов](https://developers.sber.ru/docs/ru/gigachat/guides/counting-tokens) · [POST /tokens/count](https://developers.sber.ru/docs/ru/gigachat/api/reference/rest/post-tokens-count) · [Совместимость с OpenAI](https://developers.sber.ru/docs/ru/gigachat/guides/compatible-openai) · [Changelog](https://developers.sber.ru/docs/ru/gigachat/changelog) · [Модели](https://developers.sber.ru/docs/ru/gigachat/models) · [GigaChat 2 Max](https://developers.sber.ru/docs/ru/gigachat/models/gigachat-2-max) · [GigaChat 3 Ultra](https://developers.sber.ru/docs/ru/gigachat/models/gigachat-3-ultra) · [Тарифы для физлиц](https://developers.sber.ru/docs/ru/gigachat/tariffs/individual-tariffs) · [gpt2giga](https://github.com/ai-forever/gpt2giga) · [opencode.json в gpt2giga](https://raw.githubusercontent.com/ai-forever/gpt2giga/main/opencode.json) · [gpt2giga в документации Сбера](https://developers.sber.ru/docs/ru/gigachain/tools/utilities/gpttogiga-proxy-server) · [LiteLLM GigaChat](https://docs.litellm.ai/docs/providers/gigachat) · [Habr SberDevices: GigaChat 3](https://habr.com/ru/companies/sberdevices/articles/968904/) · [HF GigaChat3.1-10B-A1.8B](https://huggingface.co/ai-sage/GigaChat3.1-10B-A1.8B) · [GGUF](https://huggingface.co/ai-sage/GigaChat3.1-10B-A1.8B-GGUF) · [GigaChat3.1-702B-A36B](https://huggingface.co/ai-sage/GigaChat3.1-702B-A36B) · [GigaChat 3.5](https://huggingface.co/collections/ai-sage/gigachat-35)

**OpenSpec:** [npm versions](https://www.npmjs.com/package/@fission-ai/openspec?activeTab=versions) · [CHANGELOG](https://github.com/Fission-AI/OpenSpec/blob/main/CHANGELOG.md) · [docs-lab/reference/cli.md](https://github.com/Fission-AI/OpenSpec/blob/main/docs-lab/reference/cli.md) · [supported-tools (2.x)](https://github.com/Fission-AI/OpenSpec/blob/main/docs-lab/reference/supported-tools.md) · [upgrade-to-2.md](https://github.com/Fission-AI/OpenSpec/blob/main/docs-lab/help/upgrade-to-2.md) · [config-yaml.md](https://github.com/Fission-AI/OpenSpec/blob/main/docs-lab/reference/configuration/config-yaml.md) · [change-metadata.md](https://github.com/Fission-AI/OpenSpec/blob/main/docs-lab/reference/configuration/change-metadata.md) · [schema-yaml.md](https://github.com/Fission-AI/OpenSpec/blob/main/docs-lab/reference/schemas/schema-yaml.md) · [schema.yaml spec-driven 2.1.1](https://unpkg.com/@fission-ai/openspec@2.1.1/schemas/spec-driven/schema.yaml) · [skills/](https://github.com/Fission-AI/OpenSpec/tree/main/skills) · [apply SKILL.md](https://github.com/Fission-AI/OpenSpec/blob/main/skills/openspec-apply-change/SKILL.md) · [verify SKILL.md](https://github.com/Fission-AI/OpenSpec/blob/main/skills/openspec-verify-change/SKILL.md) · [constants.ts](https://github.com/Fission-AI/OpenSpec/blob/main/src/core/validation/constants.ts) · [#2167 stable IDs](https://github.com/Fission-AI/OpenSpec/issues/2167) · [#1013](https://github.com/Fission-AI/OpenSpec/issues/1013) · [#611](https://github.com/Fission-AI/OpenSpec/issues/611) · [#2215](https://github.com/Fission-AI/OpenSpec/issues/2215) · [Habr: OpenSpec](https://habr.com/en/articles/983062)

**opencode:** [README](https://github.com/anomalyco/opencode/blob/dev/README.md) · [CHANGELOG V2](https://github.com/anomalyco/opencode/blob/dev/CHANGELOG.md) · [migrate-v1](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/migrate-v1.mdx) · [V2 plugins/server](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/build/plugins/server.mdx) · [V2 compaction](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/compaction.mdx) · [V2 models](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/models.mdx) · [V2 instructions](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/instructions.mdx) · [V2 agents](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/content/agents.mdx) · [V1 cli](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/v1/content/cli.mdx) · [V1 config](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/v1/content/config.mdx) · [V1 providers](https://github.com/anomalyco/opencode/blob/dev/services/site/src/docs/v1/content/providers.mdx) · [V1 plugin hooks](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/plugin/src/index.ts) · [V1 run.ts](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/cli/cmd/run.ts) · [V1 session.ts](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/session/session.ts) · [V1 system.ts](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/session/system.ts) · [V1 transform.ts](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/provider/transform.ts) · [V1 compaction.ts](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/session/compaction.ts) · [V1 truncate.ts](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/tool/truncate.ts) · [#22236](https://github.com/anomalyco/opencode/issues/22236) · [#19081](https://github.com/anomalyco/opencode/issues/19081) · [#5224](https://github.com/anomalyco/opencode/issues/5224)

**Исследования о расходе и техниках:** [Tokenomics, arXiv 2601.14470](https://arxiv.org/html/2601.14470) · [Bai et al., arXiv 2604.22750](https://arxiv.org/pdf/2604.22750) · [The Complexity Trap, arXiv 2508.21433](https://arxiv.org/html/2508.21433v3) · [SWE-agent, arXiv 2405.15793](https://arxiv.org/html/2405.15793v3) · [OpenCodeReview, arXiv 2608.09290](https://arxiv.org/abs/2608.09290) · [CodeHealth, arXiv 2610.21914](https://arxiv.org/abs/2610.21914) · [ACON, arXiv 2510.00615](https://arxiv.org/abs/2510.00615v2) · [SWE-Pruner, arXiv 2601.16746](https://arxiv.org/abs/2601.16746) · [Squeez, arXiv 2604.04979](https://arxiv.org/abs/2604.04979) · [LLMLingua-2, arXiv 2403.12968](https://arxiv.org/abs/2403.12968) · [Perplexity Paradox, arXiv 2602.15843](https://arxiv.org/abs/2602.15843) · [Local-Splitter, arXiv 2604.12301](https://arxiv.org/abs/2604.12301) · [Writer harness, arXiv 2607.06906](https://arxiv.org/abs/2607.06906) · [Agentless, arXiv 2407.01489](https://arxiv.org/abs/2407.01489) · [Chroma Context Rot](https://www.trychroma.com/research/context-rot) · [Lost in the Middle](https://arxiv.org/abs/2307.03172) · [NoLiMa](https://arxiv.org/abs/2502.05167) · [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) · [Anthropic: context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) · [Claude: context management](https://claude.com/resources/articles/context-management) · [aider repo map](https://aider.chat/docs/repomap.html) · [aider unified diffs](https://aider.chat/docs/unified-diffs.html)

**Кэш провайдеров:** [Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) · [OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching) · [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) · [DeepSeek KV cache](https://api-docs.deepseek.com/guides/kv_cache) · [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing)

**SDD-бенчмарки и сообщество:** [Uvik SDD benchmark](https://uvik.net/blog/spec-driven-development-benchmark/) · [RuStore: Spec Kit и OpenSpec](https://rustore.ru/developer/blog/spec-kit-i-openspec-v-realnom-android-proekte-testiruem-sdd-na-zadachah-rustore) · [Habr: 21 инструмент контекста](https://habr.com/ru/articles/1042880/) · [tools-token-economy](https://github.com/letya999/tools-token-economy) · [Habr: дорожная карта Spec Kit](https://habr.com/ru/articles/1063940/) · [Habr: Spec Kit в Cursor](https://habr.com/ru/articles/1066276/) · [vc.ru: 17 MCP и кэш](https://vc.ru/dev/2945685-sokrashchenie-raskhoda-tokenov-v-claude-code-s-lokalnymi-mcp) · [BMAD sharding](https://docs.bmad-method.org/how-to/shard-large-documents/) · [Taskmaster AGENTS.md](https://app.unpkg.com/task-master-ai@0.17.1/files/assets/AGENTS.md) · [Kiro specs](https://kiro.dev/docs/specs/) · [sdd-skills](https://jorgeferrando.github.io/sdd-skills/concepts/token-optimization/) · [PolicyLayer: OpenSpec MCP](https://policylayer.com/token-cost/openspec)

**Инструменты и независимые проверки:** [DCP](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning) · [Magic Context](https://github.com/cortexkit/magic-context) · [OpenSlimedit](https://github.com/ASidorenkoCode/openslimedit) · [RTK](https://github.com/rtk-ai/rtk) · [Quesma: RTK](https://quesma.com/blog/does-rtk-make-ai-coding-cheaper/) · [JetBrains: RTK](https://blog.jetbrains.com/ai/2026/07/rtk-claude-code-token-savings/) · [JetBrains: caveman](https://blog.jetbrains.com/ai/2026/07/speak-to-ai-agents-like-cavemen-tosave-tokens/) · [Headroom](https://github.com/chopratejas/headroom) · [context-mode](https://github.com/mksglu/context-mode) · [caveman](https://raw.githubusercontent.com/JuliusBrussee/caveman/HEAD/README.md) · [pantheon-org synthesis](https://pantheon-org.github.io/agentic-context/synthesis/) · [Serena (pantheon)](https://pantheon-org.github.io/agentic-context/analysis/oraios-serena/) · [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) · [repomix compress](https://repomix.com/guide/code-compress) · [tokenscope](https://github.com/ramtinJ95/opencode-tokenscope) · [spec-kit-token-analyzer](https://speckit-community.github.io/extensions/token-analyzer) · [Upsun: opencode token optimization](https://developer.upsun.com/posts/ai/opencode-token-optimization) · [awesome-opencode](https://github.com/awesome-opencode/awesome-opencode) · [Langfuse opencode](https://langfuse.com/integrations/developer-tools/opencode.md) · [LiteLLM Request Tags](https://docs.litellm.ai/docs/proxy/request_tags)

**Методика и статистика:** [On Randomness in Agentic Evals, arXiv 2602.07150](https://arxiv.org/html/2602.07150v2) · [Jarmak, arXiv 2608.13867](https://arxiv.org/pdf/2608.13867) · [Anthropic: statistical approach to evals](https://www.anthropic.com/engineering/statistical-approach-to-model-evals) · [The Coin Flip Judge?, arXiv 2606.13685](https://arxiv.org/pdf/2606.13685) · [Zheng et al., arXiv 2306.05685](https://arxiv.org/abs/2306.05685) · [MUTGEN, arXiv 2506.02954](https://arxiv.org/abs/2506.02954) · [OTel GenAI registry](https://opentelemetry.io/docs/specs/semconv/attributes-registry/gen-ai/) · [gpt-oss model card](https://arxiv.org/html/2508.10925v1) · [Qwen3-Coder-30B-A3B](https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct) · [arXiv 2602.09892](https://arxiv.org/pdf/2602.09892) · [Modal: open models on SWE-bench](https://modal.com/resources/best-open-source-models-swe-bench-coding-agents)
