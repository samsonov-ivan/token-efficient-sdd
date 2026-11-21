from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from minibank.api import create_app

from conftest import create_account, transfer


@pytest.mark.req("SCN-TXN-01.1")
def test_existing_transfer_settles_and_can_be_read(client):
    create_account(client, "alice", 50)
    create_account(client, "bob", 30)
    response = transfer(client, "alice", "bob", 20)
    assert response.status_code == 201
    record = response.json()
    assert isinstance(record["id"], int)
    assert record["source"] == "alice"
    assert record["destination"] == "bob"
    assert record["amount"] == 20
    assert record["status"] == "completed"
    assert record["created_at"] == "2026-11-21T12:30:00Z"
    assert client.get(f"/transfers/{record['id']}").json() == record
    assert client.get("/accounts/alice").json()["balance"] == 30
    assert client.get("/accounts/bob").json()["balance"] == 50


@pytest.mark.req("SCN-TXN-01.1")
def test_using_entire_balance_is_allowed(client):
    create_account(client, "alice", 25)
    create_account(client, "bob")
    transfer(client, "alice", "bob", 25).raise_for_status()
    assert client.get("/accounts/alice").json()["balance"] == 0


@pytest.mark.req("SCN-TXN-01.2")
@pytest.mark.parametrize("amount", [0, -3, 0.5, "4", True])
def test_invalid_amounts_do_not_change_balances(client, amount):
    create_account(client, "alice", 50)
    create_account(client, "bob", 30)
    response = transfer(client, "alice", "bob", amount)
    assert response.status_code == 422
    assert client.get("/accounts/alice").json()["balance"] == 50
    assert client.get("/accounts/bob").json()["balance"] == 30
    assert client.get("/accounts/alice/history").json()["items"] == []


@pytest.mark.req("SCN-TXN-01.3")
def test_unknown_recipient_rolls_back(client):
    create_account(client, "alice", 50)
    response = transfer(client, "alice", "absent", 4)
    assert response.status_code == 404
    assert response.json() == {"error": {"code": "account_not_found"}}
    assert client.get("/accounts/alice").json()["balance"] == 50
    assert client.get("/accounts/alice/history").json()["items"] == []


@pytest.mark.req("SCN-TXN-01.3")
def test_unknown_sender_does_not_credit_recipient(client):
    create_account(client, "bob", 50)
    response = transfer(client, "absent", "bob", 4)
    assert response.status_code == 404
    assert client.get("/accounts/bob").json()["balance"] == 50


@pytest.mark.req("SCN-TXN-01.3")
def test_insufficient_funds_does_not_record_transfer(client):
    create_account(client, "alice", 20)
    create_account(client, "bob", 30)
    response = transfer(client, "alice", "bob", 21)
    assert response.status_code == 409
    assert response.json() == {"error": {"code": "insufficient_funds"}}
    assert client.get("/accounts/alice").json()["balance"] == 20
    assert client.get("/accounts/bob").json()["balance"] == 30
    assert client.get("/accounts/bob/history").json()["items"] == []


@pytest.mark.req("SCN-TXN-01.3")
def test_recipient_overflow_rolls_back_debit(client):
    create_account(client, "alice", 3)
    create_account(client, "bob", 2**63 - 1)
    response = transfer(client, "alice", "bob", 1)
    assert response.status_code == 409
    assert response.json() == {"error": {"code": "balance_overflow"}}
    assert client.get("/accounts/alice").json()["balance"] == 3
    assert client.get("/accounts/bob").json()["balance"] == 2**63 - 1


@pytest.mark.req("SCN-TXN-01.4")
def test_concurrent_transfers_do_not_overdraw(client, clock, db_path):
    create_account(client, "alice", 100)
    create_account(client, "bob")

    def make_transfer():
        with TestClient(create_app(db_path, clock=clock)) as caller:
            return transfer(caller, "alice", "bob", 70).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        requests = [pool.submit(make_transfer) for _ in range(2)]
        assert sorted(job.result() for job in requests) == [201, 409]
    assert client.get("/accounts/alice").json()["balance"] == 30
    assert client.get("/accounts/bob").json()["balance"] == 70
    records = client.get("/accounts/bob/history").json()["items"]
    assert len(records) == 1
    assert records[0]["amount"] == 70


@pytest.mark.req("SCN-TXN-02.1")
def test_history_only_lists_related_transfers_in_reverse_id_order(client):
    for name in ["alice", "bob", "charlie"]:
        create_account(client, name, 100)
    first = transfer(client, "alice", "bob", 20).json()
    transfer(client, "bob", "charlie", 5).raise_for_status()
    third = transfer(client, "charlie", "alice", 30).json()
    response = client.get("/accounts/alice/history")
    assert response.status_code == 200
    assert response.json()["items"] == [third, first]


@pytest.mark.req("SCN-TXN-02.1")
def test_new_account_has_empty_history(client):
    create_account(client, "alice", 100)
    assert client.get("/accounts/alice/history").json()["items"] == []


@pytest.mark.req("SCN-TXN-02.2")
def test_history_survives_a_new_app_instance(client, db_path, clock):
    create_account(client, "alice", 100)
    create_account(client, "bob")
    record = transfer(client, "alice", "bob", 30).json()
    with TestClient(create_app(db_path, clock=clock)) as reopened:
        assert reopened.get("/accounts/bob/history").json()["items"] == [record]
        assert reopened.get(f"/transfers/{record['id']}").json() == record


@pytest.mark.req("SCN-TXN-02.2")
def test_missing_transfer_has_stable_error(client):
    response = client.get("/transfers/88")
    assert response.status_code == 404
    assert response.json() == {"error": {"code": "transfer_not_found"}}


@pytest.mark.req("SCN-TXN-02.3")
def test_non_utc_clock_is_normalized(db_path):
    local = timezone(timedelta(hours=3))
    instant = datetime(2026, 11, 22, 1, 15, 9, tzinfo=local)
    with TestClient(create_app(db_path, clock=lambda: instant)) as client:
        create_account(client, "a", 4)
        create_account(client, "b")
        response = transfer(client, "a", "b", 1)
        assert response.status_code == 201
        assert response.json()["created_at"] == "2026-11-21T22:15:09Z"
