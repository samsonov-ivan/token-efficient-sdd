from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from minibank.api import create_app

from conftest import create_account, transfer


def open_drawer(client, drawer_id="front", opening_cash=100):
    response = client.post(
        "/cash/drawers", json={"id": drawer_id, "opening_cash": opening_cash}
    )
    assert response.status_code == 201, response.text
    return response.json()


def book(
    client, direction="deposit", amount=10, *, drawer_id="front", account_id="alice"
):
    return client.post(
        f"/cash/drawers/{drawer_id}/receipts",
        json={"account_id": account_id, "direction": direction, "amount": amount},
    )


def reconcile(client, drawer_id="front"):
    response = client.get(f"/cash/drawers/{drawer_id}/reconciliation")
    assert response.status_code == 200, response.text
    return response.json()


def reverse(client, receipt_id, reason="teller correction"):
    return client.post(
        f"/cash/drawers/front/receipts/{receipt_id}/reverse",
        json={"reason": reason},
    )


@pytest.mark.req("SCN-CASH-01.1")
def test_initial_drawer_balance_and_empty_journal(client):
    entry = open_drawer(client, opening_cash=23)
    assert entry == {
        "id": "front",
        "status": "open",
        "opening_cash": 23,
        "cash": 23,
        "opened_at": "2026-11-21T12:30:00Z",
    }
    assert client.get("/cash/drawers/front").json() == entry
    report = reconcile(client)
    assert report["receipt_count"] == 0
    assert report["expected_cash"] == report["drawer_cash"] == 23
    assert report["counted_cash"] is None
    assert report["discrepancy"] is None
    assert report["balanced"] is True


@pytest.mark.req("SCN-CASH-01.1")
def test_duplicate_open_preserves_prior_drawer(client):
    open_drawer(client, opening_cash=19)
    repeated = client.post("/cash/drawers", json={"id": "front", "opening_cash": 99})
    assert repeated.status_code == 409
    assert repeated.json()["error"]["code"] == "drawer_exists"
    assert reconcile(client)["opening_cash"] == 19


@pytest.mark.req("SCN-CASH-01.2")
def test_deposits_and_withdrawals_balance_both_books(client):
    create_account(client, "alice", 10)
    open_drawer(client, opening_cash=80)
    deposit = book(client, amount=20)
    assert deposit.status_code == 201
    first = deposit.json()
    assert first["account_balance_after"] == 30
    assert first["drawer_cash_after"] == 100
    assert first["recorded_at"] == "2026-11-21T12:30:00Z"
    second = book(client, "withdrawal", 25).json()
    assert second["account_balance_after"] == 5
    assert second["drawer_cash_after"] == 75
    assert second["id"] > first["id"]
    assert client.get("/accounts/alice").json()["balance"] == 5
    assert client.get(f"/cash/drawers/front/receipts/{first['id']}").json() == first
    report = reconcile(client)
    assert report["deposits"] == 20
    assert report["withdrawals"] == 25
    assert report["expected_cash"] == 75
    assert report["receipt_count"] == 2


@pytest.mark.req("SCN-CASH-01.2")
def test_cash_and_account_transfer_ledgers_reconcile_independently(client):
    create_account(client, "alice")
    create_account(client, "bob")
    open_drawer(client)
    book(client, amount=15).raise_for_status()
    transfer(client, "alice", "bob", 10).raise_for_status()
    assert client.get("/accounts/alice").json()["balance"] == 5
    assert client.get("/accounts/bob").json()["balance"] == 10
    assert reconcile(client)["expected_cash"] == 115
    assert reconcile(client)["receipt_count"] == 1
    history = client.get("/accounts/alice/history").json()["items"]
    assert [payment["amount"] for payment in history] == [10]


@pytest.mark.req("SCN-CASH-01.3")
@pytest.mark.parametrize(
    ("direction", "amount", "drawer_cash", "balance", "error"),
    [
        ("withdrawal", 15, 10, 20, "insufficient_cash"),
        ("withdrawal", 15, 20, 10, "insufficient_funds"),
        ("deposit", 1, 2**63 - 1, 10, "drawer_overflow"),
        ("deposit", 1, 10, 2**63 - 1, "balance_overflow"),
    ],
)
def test_refusals_do_not_leave_a_partial_booking(
    client, direction, amount, drawer_cash, balance, error
):
    create_account(client, "alice", balance)
    open_drawer(client, opening_cash=drawer_cash)
    response = book(client, direction, amount)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == error
    assert client.get("/accounts/alice").json()["balance"] == balance
    report = reconcile(client)
    assert report["drawer_cash"] == drawer_cash
    assert report["receipt_count"] == 0


@pytest.mark.req("SCN-CASH-01.3")
def test_closed_account_rejects_cash_even_with_an_open_drawer(client):
    create_account(client, "alice", 4)
    open_drawer(client)
    client.post("/accounts/alice/close").raise_for_status()
    assert book(client).json()["error"]["code"] == "account_closed"
    assert reconcile(client)["receipt_count"] == 0


@pytest.mark.req("SCN-CASH-01.3")
def test_nonexistent_objects_are_distinct(client):
    assert (
        client.get("/cash/drawers/front").json()["error"]["code"] == "drawer_not_found"
    )
    open_drawer(client)
    assert book(client).json()["error"]["code"] == "account_not_found"
    assert (
        client.get("/cash/drawers/front/receipts/1").json()["error"]["code"]
        == "receipt_not_found"
    )


@pytest.mark.req("SCN-CASH-02.1")
def test_reversal_creates_an_opposite_receipt_without_editing_history(client):
    create_account(client, "alice")
    open_drawer(client)
    original = book(client).json()
    response = reverse(client, original["id"])
    assert response.status_code == 201
    reversal = response.json()
    assert reversal["id"] != original["id"]
    assert reversal["reverses"] == original["id"]
    assert reversal["direction"] == "withdrawal"
    assert reversal["reason"] == "teller correction"
    assert reversal["amount"] == original["amount"]
    assert (
        client.get(f"/cash/drawers/front/receipts/{original['id']}").json() == original
    )
    assert client.get("/accounts/alice").json()["balance"] == 0
    report = reconcile(client)
    assert report["deposits"] == report["withdrawals"] == 10
    assert report["receipt_count"] == 2
    assert report["expected_cash"] == report["opening_cash"]


@pytest.mark.req("SCN-CASH-02.2")
def test_reversal_cannot_be_reversed_and_receipt_cannot_be_reversed_twice(client):
    create_account(client, "alice")
    open_drawer(client)
    first = book(client).json()
    second = reverse(client, first["id"]).json()
    for receipt in (first, second):
        response = reverse(client, receipt["id"])
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "receipt_not_reversible"
    assert reconcile(client)["receipt_count"] == 2


@pytest.mark.req("SCN-CASH-02.2")
def test_failed_reversal_can_be_retried_after_funds_return(client):
    create_account(client, "alice")
    create_account(client, "bob")
    open_drawer(client)
    first = book(client, amount=10).json()
    transfer(client, "alice", "bob", 10).raise_for_status()
    assert reverse(client, first["id"]).json()["error"]["code"] == "insufficient_funds"
    assert reconcile(client)["receipt_count"] == 1
    transfer(client, "bob", "alice", 10).raise_for_status()
    assert reverse(client, first["id"]).status_code == 201
    assert reconcile(client)["receipt_count"] == 2


@pytest.mark.req("SCN-CASH-03.1")
def test_close_requires_a_reason_for_difference_and_reports_it_permanently(
    client, db_path, clock
):
    create_account(client, "alice")
    open_drawer(client)
    book(client, amount=19).raise_for_status()
    invalid = client.post("/cash/drawers/front/close", json={"counted_cash": 117})
    assert invalid.status_code == 422
    assert invalid.json()["error"]["code"] == "difference_requires_reason"
    assert client.get("/cash/drawers/front").json()["status"] == "open"
    payload = {"counted_cash": 117, "reason": "two coins missing"}
    closed = client.post("/cash/drawers/front/close", json=payload)
    assert closed.status_code == 200
    report = closed.json()
    assert report["counted_cash"] == 117
    assert report["discrepancy"] == -2
    assert report["reason"] == payload["reason"]
    assert report["closed_at"] == "2026-11-21T12:30:00Z"
    with TestClient(create_app(db_path, clock=clock)) as reopened:
        assert reconcile(reopened) == report
        assert book(reopened).json()["error"]["code"] == "drawer_closed"
        assert (
            reopened.post("/cash/drawers/front/close", json=payload).status_code == 409
        )


@pytest.mark.req("SCN-CASH-03.1")
def test_exact_closing_count_needs_no_reason(client):
    open_drawer(client, opening_cash=53)
    response = client.post("/cash/drawers/front/close", json={"counted_cash": 53})
    assert response.status_code == 200
    assert response.json()["discrepancy"] == 0
    assert response.json()["reason"] is None


@pytest.mark.req("SCN-CASH-03.2")
def test_drawers_keep_separate_receipts_and_reconciliations(client):
    create_account(client, "alice", 10)
    open_drawer(client)
    open_drawer(client, "back", 0)
    receipt = book(client, drawer_id="back").json()
    assert reconcile(client)["expected_cash"] == 100
    assert reconcile(client, "back")["expected_cash"] == 10
    assert reverse(client, receipt["id"]).json()["error"]["code"] == "receipt_not_found"


@pytest.mark.req("SCN-CASH-02.2")
def test_concurrent_reversals_only_add_one_offsetting_receipt(client, db_path, clock):
    create_account(client, "alice", 50)
    open_drawer(client)
    original = book(client).json()

    def request_reversal():
        with TestClient(create_app(db_path, clock=clock)) as other:
            return reverse(other, original["id"]).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = [pool.submit(request_reversal) for _ in range(2)]
        assert sorted(f.result() for f in results) == [201, 409]
    assert reconcile(client)["receipt_count"] == 2
    assert client.get("/accounts/alice").json()["balance"] == 50


@pytest.mark.req("SCN-CASH-03.3")
def test_counting_denominations_previews_shortage_without_closing_drawer(client):
    open_drawer(client, opening_cash=331)
    before = reconcile(client)
    payload = {
        "lines": [
            {"denomination": 100, "quantity": 3},
            {"denomination": 10, "quantity": 2},
            {"denomination": 1, "quantity": 5},
        ]
    }
    response = client.post("/cash/drawers/front/count", json=payload)
    assert response.status_code == 200
    assert response.json() == {
        "drawer_id": "front",
        "items": 10,
        "counted_cash": 325,
        "expected_cash": 331,
        "discrepancy": -6,
        "matches": False,
    }
    assert reconcile(client) == before


@pytest.mark.req("SCN-CASH-03.3")
def test_empty_count_is_a_valid_zero(client):
    open_drawer(client, opening_cash=0)
    response = client.post("/cash/drawers/front/count", json={"lines": []})
    assert response.status_code == 200
    counted = response.json()
    assert counted["items"] == counted["counted_cash"] == counted["discrepancy"] == 0
    assert counted["matches"] is True


@pytest.mark.req("SCN-CASH-03.3")
@pytest.mark.parametrize(
    ("lines", "error_code"),
    [
        ([{"denomination": 3, "quantity": 1}], "unknown_denomination"),
        (
            [{"denomination": 5, "quantity": 1}, {"denomination": 5, "quantity": 2}],
            "repeated_denomination",
        ),
        ([{"denomination": 2_000, "quantity": 1}], "unknown_denomination"),
        ([{"denomination": 5_000, "quantity": 2**62}], "cash_count_overflow"),
    ],
)
def test_denomination_validation_keeps_draft_out_of_the_cash_journal(
    client, lines, error_code
):
    open_drawer(client)
    response = client.post("/cash/drawers/front/count", json={"lines": lines})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == error_code
    assert reconcile(client)["receipt_count"] == 0


@pytest.mark.req("SCN-CASH-03.3")
@pytest.mark.parametrize("quantity", [-1, True, 0.25, "2"])
def test_each_coin_count_is_a_nonnegative_integer(client, quantity):
    open_drawer(client)
    response = client.post(
        "/cash/drawers/front/count",
        json={"lines": [{"denomination": 100, "quantity": quantity}]},
    )
    assert response.status_code == 422


@pytest.mark.req("SCN-CASH-01.2")
def test_high_lifetime_turnover_uses_exact_integers(client):
    maximum = 2**63 - 1
    open_drawer(client, opening_cash=0)
    create_account(client, "alice", 0)
    for _ in range(2):
        book(client, amount=maximum).raise_for_status()
        book(client, "withdrawal", maximum).raise_for_status()
    report = reconcile(client)
    assert (
        report["opening_cash"] == report["expected_cash"] == report["drawer_cash"] == 0
    )
    assert report["deposits"] == report["withdrawals"] == 2 * maximum
    assert report["receipt_count"] == 4
    assert report["balanced"] is True


@pytest.mark.req("SCN-CASH-03.1")
def test_closed_drawer_cannot_reverse_its_old_receipts(client):
    open_drawer(client, opening_cash=20)
    create_account(client, "alice")
    receipt = book(client, amount=5).json()
    closure = client.post("/cash/drawers/front/close", json={"counted_cash": 25})
    assert closure.status_code == 200
    response = reverse(client, receipt["id"])
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "drawer_closed"
    assert client.get("/accounts/alice").json()["balance"] == 5
    assert reconcile(client) == closure.json()
