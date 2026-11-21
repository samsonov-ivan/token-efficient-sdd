# Перенос H-01 на yocto-queue

[Скачать первичные материалы](../../docs/probes/yocto-queue-h01.zip). В каталоге `yocto-queue/` можно открыть `upstream.patch`, сравнить журналы исходных и итоговых тестов и пересчитать учёт командой `node scripts/replay.mjs <путь-к-распакованному-каталогу>/yocto-queue`. В архиве 37 ответов локальной HTTP-фикстуры.

Один и тот же исполнитель `executeLiveOptimized` проходит две открытые кодовые базы. При запуске без параметров он реализует выдачу идентификатора и квитанции в небольшой фикстуре. С параметром `--yocto-queue` он добавляет `peekLast()` в закреплённый исходник внешнего npm-пакета. Локальный HTTP-провайдер возвращает заранее заданные действия. Установленный OpenCode исполняет их своими инструментами в новом checkout вне проекта. Любое расхождение в последовательности вызовов, сессиях, гейтах или итоговом дереве останавливает проверку.

Для повтора из корня Frugal нужны Node из `.node-version`, собранные зависимости Frugal, локальный Git-клон yocto-queue с коммитом `72a8fa96a9d389765cdf2bb9c6daba8302fc375d` и npm-кэш для сохранённого lock-файла. Подготовить последние два на новой машине можно так:

```sh
cache=$(mktemp -d)
export YOCTO_MIRROR="$cache/yocto-queue" YOCTO_NPM_CACHE="$cache/npm-cache"
git clone https://github.com/sindresorhus/yocto-queue.git "$YOCTO_MIRROR"
git -C "$YOCTO_MIRROR" checkout --detach 72a8fa96a9d389765cdf2bb9c6daba8302fc375d
cp bench/portability/yocto-queue/package-lock.json "$YOCTO_MIRROR/"
(cd "$YOCTO_MIRROR" && npm ci --ignore-scripts --no-audit --no-fund --cache="$YOCTO_NPM_CACHE")
```

Для подготовленного проектного стенда пути по умолчанию лежат в `~/.cache/frugal-sdd/portability/{yocto-queue-72a8fa9,npm-cache}`. Сам прогон устанавливает зависимости офлайн и обращается к провайдеру на 127.0.0.1.

```sh
npm run build
node scripts/probe-live-opt.mjs
evidence="bench/runs/portability-$(date +%s)/yocto-queue"
node scripts/probe-live-opt.mjs --yocto-queue "$evidence"
node scripts/replay.mjs "$evidence"
```

`probe.json` сохраняет версии, SHA исходного коммита и lock-файла, идентификаторы двух apply-сессий, проверенное дерево и результаты тестов. Первый apply реализует поведение и тест AVA, второй получает подтверждённый handoff и добавляет декларацию, тесты tsd и описание API. Полное ревью и verify читают пять изменённых файлов upstream и четыре артефакта OpenSpec. Строгая валидация OpenSpec и повтор штатного `npm test` завершают проверку. Новые JS- и TS-тесты отдельно падают при наложении на первозданный исходник: ошибки сохранены в `negative-runtime.log` и `negative-types.log`. Правки библиотеки и проверок можно посмотреть в `upstream.patch`, события и экспорты сессий — в `raw/`.

Этот опыт проверяет перенос исполнительного конвейера и передачу контекста. Внешняя модель, независимая приёмка качества и A/B-замер расхода токенов остаются открытыми.
