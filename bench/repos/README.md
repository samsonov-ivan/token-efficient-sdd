# Закреплённый снимок minibank

В `minibank/` находятся публичные исходники. Харнесс клонирует `minibank.bundle` во временный каталог и переходит на коммит из `minibank.sha`. Bundle содержит один корневой коммит с исходниками стенда, тестами регрессии и тремя базовыми спецификациями.

Из корня проекта:

```sh
project=$(pwd)
checkout=$(mktemp -d)/minibank
git clone bench/repos/minibank.bundle "$checkout"
git -C "$checkout" checkout --detach "$(cat bench/repos/minibank.sha)"
test "$(git -C "$checkout" rev-parse 'HEAD^{tree}')" = "$(git rev-parse HEAD:bench/repos/minibank)"
test "$(git -C "$checkout" rev-list --count HEAD)" = 1
cd "$checkout"
uv sync --locked
uv run --locked python -m pytest -q
"$project/node_modules/.bin/openspec" validate --specs --strict
```

После осознанного изменения стенда сначала закоммитьте публичные исходники. Затем выполните `bench/repos/snapshot-minibank.sh` из корня проекта, проверьте свежий клон и зафиксируйте новую пару bundle и sha. Скрипт использует дерево публичного каталога на HEAD, постоянные автора, сообщение и дату, чтобы повторная сборка с теми же исходниками давала тот же commit ID. Выбор ревизии для каждой серии фиксируется до запуска.

## История фиксации стенда

До калибровки B0 первый технический снимок `da8fc41644cc5df8a9c8a2ea1b5bc0ce262d1f1e` содержал 588 физических строк Python вместе с регрессионными тестами. Для размера стенда по ТЗ §13.1 добавлен отдельный контур кассовых смен с учётом наличности, сторнированием, сохранением чеков и сверкой при закрытии. В конкурсных требованиях S, M и L сохранились исходные контракты.

Зачётный вход `77d839456fec7dca255e31b1a7bfbd64fb6f6f5d` содержит 1419 физических строк Python. По `cloc --include-lang=Python src tests` это 1098 строк кода, из них 543 в приложении и 555 в публичных тестах. Чистый клон прошёл 68 публичных тестов и строгую валидацию трёх базовых спецификаций.
