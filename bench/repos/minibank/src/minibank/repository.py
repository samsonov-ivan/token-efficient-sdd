"""Ledger persistence. All methods operate inside the caller's transaction."""

import sqlite3

from .models import DomainError, NewAccount, NewTransfer

MAX_BALANCE = 2**63 - 1


def account_record(connection: sqlite3.Connection, account_id: str) -> dict:
    row = connection.execute(
        "SELECT * FROM accounts WHERE id = ?", (account_id,)
    ).fetchone()
    if row is None:
        raise DomainError(404, "account_not_found")
    record = dict(row)
    record["closed"] = bool(record["closed"])
    return record


def insert_account(connection: sqlite3.Connection, request: NewAccount) -> dict:
    result = connection.execute(
        """INSERT INTO accounts (id, kind, balance) VALUES (?, ?, ?)
           ON CONFLICT(id) DO NOTHING""",
        (request.id, request.kind, request.balance),
    )
    if result.rowcount == 0:
        raise DomainError(409, "account_exists")
    return account_record(connection, request.id)


def close_account(connection: sqlite3.Connection, account_id: str) -> dict:
    connection.execute("UPDATE accounts SET closed = 1 WHERE id = ?", (account_id,))
    return account_record(connection, account_id)


def debit(connection: sqlite3.Connection, account_id: str, amount: int) -> None:
    result = connection.execute(
        """UPDATE accounts SET balance = balance - ?
           WHERE id = ? AND balance >= ?""",
        (amount, account_id, amount),
    )
    if result.rowcount == 0:
        raise DomainError(409, "insufficient_funds")


def credit(connection: sqlite3.Connection, account_id: str, amount: int) -> None:
    result = connection.execute(
        """UPDATE accounts SET balance = balance + ?
           WHERE id = ? AND balance <= ?""",
        (amount, account_id, MAX_BALANCE - amount),
    )
    if result.rowcount == 0:
        raise DomainError(409, "balance_overflow")


def transfer_record(connection: sqlite3.Connection, transfer_id: int) -> dict:
    row = connection.execute(
        "SELECT * FROM transfers WHERE id = ?", (transfer_id,)
    ).fetchone()
    if row is None:
        raise DomainError(404, "transfer_not_found")
    return dict(row)


def insert_transfer(
    connection: sqlite3.Connection, request: NewTransfer, created_at: str
) -> dict:
    result = connection.execute(
        """INSERT INTO transfers (source, destination, amount, created_at)
           VALUES (?, ?, ?, ?)""",
        (request.source, request.destination, request.amount, created_at),
    )
    return transfer_record(connection, result.lastrowid)


def list_transfers(connection: sqlite3.Connection, account_id: str) -> list[dict]:
    rows = connection.execute(
        """SELECT * FROM transfers WHERE source = ? OR destination = ?
           ORDER BY id DESC""",
        (account_id, account_id),
    )
    return [dict(row) for row in rows]
