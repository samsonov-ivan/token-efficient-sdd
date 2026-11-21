# Minibank

Локальный сервис счетов и переводов на FastAPI и SQLite. Во всех ответах суммы заданы целыми копейками. Каждый тест использует свой файл SQLite. Внешние сервисы для запуска не требуются.

## Запуск тестов

Используйте Python 3.11 или новее. Из корня репозитория выполните:

```sh
uv sync --locked
uv run --locked python -m pytest -q
uv run --locked python -m pytest --junitxml=results.xml
```

В `openspec/specs/` находятся исходные требования к счетам, переводам и кассовым сменам. Указанная в правилах проекта команда `openspec validate --specs --strict` проверяет все три спецификации.

## Публичное API

| Метод | Путь | Успешный ответ |
|---|---|---|
| POST | /accounts | 201, созданный счёт |
| GET | /accounts/{id} | 200, счёт с балансом |
| POST | /accounts/{id}/close | 200, закрытый счёт |
| POST | /transfers | 201, запись перевода |
| GET | /transfers/{id} | 200, сохранённый перевод |
| GET | /accounts/{id}/history | 200, объект с массивом items |

Счёт создаётся из объекта `{"id":"alice","kind":"personal","balance":500}`. Допустимы типы personal и business. При пропуске kind и balance используются personal и 0. Уникальный идентификатор счёта может содержать буквы, запятые, кавычки, пробелы и цифры. Максимальная длина — 80 символов. Символ / и управляющие символы запрещены. Ответ содержит id, kind, balance и closed.

Перевод создаётся из `{"source":"alice","destination":"bob","amount":150}`. Получатель должен существовать. В ответе сохранены id, source, destination, amount, status и created_at. Завершённая операция получает статус completed. Целые id упорядочены по времени записи. Время нормализовано к UTC и записано с точностью до секунды.

Бизнес-ошибки возвращаются как `{"error":{"code":"insufficient_funds"}}`. Неизвестный счёт или перевод получает 404. Конфликт идентификатора и нехватка средств дают 409. Ошибочный запрос получает 422.

## Встраивание в тест

```python
from datetime import UTC, datetime
from fastapi.testclient import TestClient
from minibank.api import create_app

clock = lambda: datetime(2026, 11, 21, 12, tzinfo=UTC)
with TestClient(create_app("ledger.sqlite3", clock=clock)) as client:
    response = client.post("/accounts", json={"id": "alice", "balance": 500})
    assert response.status_code == 201
```

Фабрика создаёт приложение на переданном файле. Отдельное соединение SQLite на каждый запрос владеет транзакцией. Если изменить счёт получателя не удалось, списание у отправителя откатывается. Новое приложение над тем же файлом видит записанные счета и историю. Время операций задаётся параметром clock.

## Кассовая смена

`POST /cash/drawers` открывает кассу с уникальным id и остатком opening_cash. `POST /cash/drawers/{id}/receipts` принимает account_id, direction (deposit или withdrawal) и положительный amount. В одной транзакции обновляются счёт клиента, остаток кассы и чек. Чек хранит оба остатка после операции и дату. `GET /cash/drawers/{id}/receipts/{receipt_id}` возвращает сохранённый чек, а `POST /cash/drawers/{id}/receipts/{receipt_id}/reverse` с полем reason проводит обратную кассовую операцию отдельным чеком. Повторное сторно запрещено.

`GET /cash/drawers/{id}/reconciliation` пересчитывает ожидаемую наличность из начального остатка и чеков. Для закрытия передайте counted_cash в `POST /cash/drawers/{id}/close`. Если подсчёт расходится с журналом, поле reason обязательно. После закрытия смены отчёт содержит дату, зафиксированный подсчёт и разницу. Обычные переводы между счетами не двигают наличность.

Для чернового пересчёта банкнот и монет отправьте `{"lines":[{"denomination":100,"quantity":3}]}` в `POST /cash/drawers/{id}/count`. Номинал — в копейках, quantity — число экземпляров. Ответ показывает количество предметов, сумму и расхождение с кассовым журналом. Черновой подсчёт не закрывает смену.
