# Исходная проверка двух внешних стендов

Для каждого стенда скрипт получает закреплённый коммит в новом временном каталоге, проверяет API и запускает штатные тесты. Список upstream, SHA и лицензий хранится в [repos.json](repos.json). При запуске создаётся новый каталог свидетельств с result.json и полным commands.log. После тестов Git должен показывать чистый checkout.

- **yocto-queue**. Проверка выполняет `npm ci` с сохранённым lock-файлом и `npm test` (AVA и tsd). На входном SHA очередь предоставляет `peek()`, а `peekLast()` отсутствует в прототипе и исходной декларации типов. Для сравниваемых плеч следует использовать один lock-файл. [Исходник](https://github.com/sindresorhus/yocto-queue/tree/72a8fa96a9d389765cdf2bb9c6daba8302fc375d)
- **google/uuid**. Проверка выполняет `go test -count=1 -json ./... -args -regressions` со свежим кэшем. Флаг запускает также минутную регрессию конкурентной генерации UUID. На SHA тега v1.6.0 пакет предлагает `Parse` и `Validate`, допускающие несколько форм записи. Отдельный `ParseCanonical` отсутствует. В репозиторий Frugal записаны URL, SHA и результаты проверки. Лицензионное уведомление BSD-3-Clause находится в исходном checkout. [Исходник](https://github.com/google/uuid/tree/0f11ee6918f41a04c201eceeadf612a377bc7fbc)

В исходной проверке использованы Node 24.15.0 и Go 1.27.4. Для повторения из корня проекта укажите разные новые каталоги результатов.

```sh
node bench/portability/check.mjs yocto-queue bench/runs/portability-repeat/yocto-queue
node bench/portability/check.mjs google-uuid bench/runs/portability-repeat/google-uuid
```

Последним аргументом можно передать путь к локальному зеркалу upstream. Для установки зависимостей JavaScript нужен доступ к реестру либо предварительно заполненный npm-кэш, указанный через `npm_config_cache`. В Go-проекте внешние модули отсутствуют. Функциональность новой фичи, установка Frugal и A/B серий E5 и E10 проверяются отдельно.

Первичный протокол доступен для [JavaScript](../runs/summary/portability-base/yocto-queue/result.json) и [Go](../runs/summary/portability-base/google-uuid-full/result.json).
