# Закреплённый снимок minibank

В `minibank/` находятся публичные исходники. Харнесс клонирует `minibank.bundle` во временный каталог и переходит на коммит из `minibank.sha`. Bundle содержит один корневой коммит с исходниками стенда, тестами регрессии и двумя базовыми спецификациями.

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
