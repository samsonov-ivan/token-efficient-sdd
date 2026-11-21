from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from minibank.api import create_app


@pytest.fixture
def clock():
    return lambda: datetime(2026, 11, 21, 12, 30, 0, tzinfo=UTC)


@pytest.fixture
def db_path(tmp_path):
    return tmp_path / "ledger.sqlite3"


@pytest.fixture
def client(db_path, clock):
    with TestClient(create_app(db_path, clock=clock)) as client:
        yield client


def create_account(client, account_id, balance=0, kind="personal"):
    response = client.post(
        "/accounts", json={"id": account_id, "balance": balance, "kind": kind}
    )
    assert response.status_code == 201, response.text
    return response.json()


def transfer(client, source, destination, amount):
    return client.post(
        "/transfers",
        json={"source": source, "destination": destination, "amount": amount},
    )
