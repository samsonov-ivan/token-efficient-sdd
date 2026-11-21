"""Durable cash-desk records for statements, receipts and reconciliation."""

import sqlite3

from .cash_models import CashMovement, DrawerView, Receipt
from .models import DomainError
from .storage import Database

CASH_SCHEMA = """
CREATE TABLE IF NOT EXISTS drawers (
    id TEXT PRIMARY KEY NOT NULL,
    opening_cash INTEGER NOT NULL CHECK (opening_cash >= 0),
    cash INTEGER NOT NULL CHECK (typeof(cash) = 'integer' AND cash >= 0),
    opened_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed'))
);
CREATE TABLE IF NOT EXISTS cash_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drawer_id TEXT NOT NULL REFERENCES drawers(id),
    account_id TEXT NOT NULL REFERENCES accounts(id),
    direction TEXT NOT NULL CHECK (direction IN ('deposit', 'withdrawal')),
    amount INTEGER NOT NULL CHECK (amount > 0),
    account_balance_after INTEGER NOT NULL,
    drawer_cash_after INTEGER NOT NULL,
    recorded_at TEXT NOT NULL,
    reverses INTEGER UNIQUE REFERENCES cash_receipts(id),
    reason TEXT
);
CREATE INDEX IF NOT EXISTS cash_receipts_by_drawer ON cash_receipts(drawer_id, id);
CREATE TABLE IF NOT EXISTS drawer_closures (
    drawer_id TEXT PRIMARY KEY REFERENCES drawers(id),
    counted_cash INTEGER NOT NULL CHECK (counted_cash >= 0),
    reason TEXT,
    closed_at TEXT NOT NULL
);
"""


def initialize(database: Database) -> None:
    with database.session() as connection:
        connection.executescript(CASH_SCHEMA)


def get_drawer(connection: sqlite3.Connection, drawer_id: str) -> DrawerView:
    row = connection.execute(
        "SELECT * FROM drawers WHERE id = ?", (drawer_id,)
    ).fetchone()
    if row is None:
        raise DomainError(404, "drawer_not_found")
    return DrawerView(**dict(row))


def get_receipt(
    connection: sqlite3.Connection, drawer_id: str, receipt_id: int
) -> Receipt:
    row = connection.execute(
        "SELECT * FROM cash_receipts WHERE id = ? AND drawer_id = ?",
        (receipt_id, drawer_id),
    ).fetchone()
    if row is None:
        raise DomainError(404, "receipt_not_found")
    return Receipt(**dict(row))


def store_receipt(
    connection: sqlite3.Connection,
    drawer_id: str,
    movement: CashMovement,
    account_balance: int,
    drawer_cash: int,
    recorded_at: str,
    reverses: int | None,
    reason: str | None,
) -> Receipt:
    row = connection.execute(
        """INSERT INTO cash_receipts
               (drawer_id, account_id, direction, amount, account_balance_after,
                drawer_cash_after, recorded_at, reverses, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *""",
        (
            drawer_id,
            movement.account_id,
            movement.direction,
            movement.amount,
            account_balance,
            drawer_cash,
            recorded_at,
            reverses,
            reason,
        ),
    ).fetchone()
    return Receipt(**dict(row))


def totals(connection: sqlite3.Connection, drawer_id: str) -> tuple[int, int, int]:
    """Use exact Python totals: lifetime throughput can exceed SQLite INTEGER."""
    deposits = withdrawals = count = 0
    for row in connection.execute(
        "SELECT direction, amount FROM cash_receipts WHERE drawer_id = ?", (drawer_id,)
    ):
        count += 1
        if row["direction"] == "deposit":
            deposits += row["amount"]
        else:
            withdrawals += row["amount"]
    return deposits, withdrawals, count
