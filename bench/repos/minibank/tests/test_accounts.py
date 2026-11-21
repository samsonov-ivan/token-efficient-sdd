from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from minibank.api import create_app

from conftest import create_account, transfer


@pytest.mark.req("SCN-ACC-01.1")
@pytest.mark.parametrize("kind", ["personal", "business"])
def test_read_created_account(client, kind):
    record = create_account(client, "alice", 25, kind)
    assert record["id"] == "alice"
    assert record["kind"] == kind
    assert record["balance"] == 25
    assert record["closed"] is False
    response = client.get("/accounts/alice")
    assert response.status_code == 200
    assert response.json() == record


@pytest.mark.req("SCN-ACC-01.1")
def test_creation_defaults(client):
    response = client.post("/accounts", json={"id": "new"})
    assert response.status_code == 201
    assert response.json()["balance"] == 0
    assert response.json()["kind"] == "personal"


@pytest.mark.req("SCN-ACC-01.1")
@pytest.mark.parametrize("account_id", ["shop,1", "Кофейня", "a'b", 'shop"one'])
def test_identifiers_are_opaque(client, account_id):
    create_account(client, account_id, 1)
    url = "/accounts/" + quote(account_id, safe="")
    response = client.get(url)
    assert response.status_code == 200
    assert response.json()["id"] == account_id


@pytest.mark.req("SCN-ACC-01.2")
def test_duplicate_does_not_modify_previous_record(client):
    create_account(client, "alice", 100)
    response = client.post("/accounts", json={"id": "alice", "balance": 200})
    assert response.status_code == 409
    assert response.json() == {"error": {"code": "account_exists"}}
    assert client.get("/accounts/alice").json()["balance"] == 100


@pytest.mark.req("SCN-ACC-01.3")
@pytest.mark.parametrize(
    "fields",
    [
        {"id": ""},
        {"id": "a/b"},
        {"id": "a\nb"},
        {"id": "a" * 81},
        {"id": "a", "balance": -1},
        {"id": "a", "balance": 1.5},
        {"id": "a", "balance": True},
        {"id": "a", "kind": "enterprise"},
    ],
)
def test_invalid_account_request(client, fields):
    response = client.post("/accounts", json=fields)
    assert response.status_code == 422
    assert client.get("/accounts/a").status_code == 404


@pytest.mark.req("SCN-ACC-02.1")
def test_close_is_idempotent_and_preserves_balance(client):
    create_account(client, "alice", 777)
    first = client.post("/accounts/alice/close")
    assert first.status_code == 200
    assert first.json()["closed"] is True
    assert first.json()["balance"] == 777
    second = client.post("/accounts/alice/close")
    assert second.status_code == 200
    assert second.json() == first.json()
    assert client.get("/accounts/alice").json() == first.json()


@pytest.mark.req("SCN-ACC-02.2")
def test_closed_sender_cannot_spend(client):
    create_account(client, "alice", 100)
    create_account(client, "bob")
    client.post("/accounts/alice/close").raise_for_status()
    response = transfer(client, "alice", "bob", 100)
    assert response.status_code == 409
    assert response.json() == {"error": {"code": "account_closed"}}
    assert client.get("/accounts/alice").json()["balance"] == 100
    assert client.get("/accounts/bob").json()["balance"] == 0


@pytest.mark.req("SCN-ACC-02.3")
@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", "/accounts/absent"),
        ("post", "/accounts/absent/close"),
        ("get", "/accounts/absent/history"),
    ],
)
def test_missing_account_fails(client, method, path):
    response = client.request(method, path)
    assert response.status_code == 404
    assert response.json() == {"error": {"code": "account_not_found"}}


@pytest.mark.req("SCN-ACC-02.1")
def test_accounts_persist_after_reopening_sqlite(client, db_path, clock):
    create_account(client, "alice", 19)
    client.post("/accounts/alice/close").raise_for_status()
    with TestClient(create_app(db_path, clock=clock)) as reopened:
        account = reopened.get("/accounts/alice").json()
    assert account["balance"] == 19
    assert account["closed"] is True
