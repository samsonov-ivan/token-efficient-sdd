"""Cash teller operations. Each receipt balances the account and its cash drawer."""

import sqlite3
from collections.abc import Callable
from datetime import datetime

from . import cash_storage, repository
from .cash_models import (
    CashMovement,
    CloseDrawer,
    DrawerView,
    OpenDrawer,
    Receipt,
    Reconciliation,
)
from .models import DomainError, format_timestamp
from .storage import Database


class CashDesk:
    def __init__(self, db: Database, clock: Callable[[], datetime]) -> None:
        self.db = db
        self.clock = clock
        cash_storage.initialize(db)

    def open_drawer(self, request: OpenDrawer) -> DrawerView:
        with self.db.session(write=True) as connection:
            result = connection.execute(
                """INSERT INTO drawers(id, opening_cash, cash, opened_at)
                   VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING""",
                (
                    request.id,
                    request.opening_cash,
                    request.opening_cash,
                    format_timestamp(self.clock()),
                ),
            )
            if result.rowcount == 0:
                raise DomainError(409, "drawer_exists")
            return cash_storage.get_drawer(connection, request.id)

    def drawer(self, drawer_id: str) -> DrawerView:
        with self.db.session() as connection:
            return cash_storage.get_drawer(connection, drawer_id)

    def receipt(self, drawer_id: str, receipt_id: int) -> Receipt:
        with self.db.session() as connection:
            return cash_storage.get_receipt(connection, drawer_id, receipt_id)

    def _book(
        self,
        connection: sqlite3.Connection,
        drawer_id: str,
        movement: CashMovement,
        *,
        reverses: int | None = None,
        reason: str | None = None,
    ) -> Receipt:
        drawer = cash_storage.get_drawer(connection, drawer_id)
        if drawer.status != "open":
            raise DomainError(409, "drawer_closed")
        account = repository.account_record(connection, movement.account_id)
        if account["closed"]:
            raise DomainError(409, "account_closed")

        if movement.direction == "deposit":
            next_cash = drawer.cash + movement.amount
            if next_cash > repository.MAX_BALANCE:
                raise DomainError(409, "drawer_overflow")
            repository.credit(connection, movement.account_id, movement.amount)
        else:
            next_cash = drawer.cash - movement.amount
            if next_cash < 0:
                raise DomainError(409, "insufficient_cash")
            repository.debit(connection, movement.account_id, movement.amount)
        connection.execute(
            "UPDATE drawers SET cash = ? WHERE id = ?", (next_cash, drawer_id)
        )
        balance = repository.account_record(connection, movement.account_id)["balance"]
        return cash_storage.store_receipt(
            connection,
            drawer_id,
            movement,
            balance,
            next_cash,
            format_timestamp(self.clock()),
            reverses,
            reason,
        )

    def book(self, drawer_id: str, movement: CashMovement) -> Receipt:
        with self.db.session(write=True) as connection:
            return self._book(connection, drawer_id, movement)

    def reverse(self, drawer_id: str, receipt_id: int, reason: str) -> Receipt:
        with self.db.session(write=True) as connection:
            receipt = cash_storage.get_receipt(connection, drawer_id, receipt_id)
            previous = connection.execute(
                "SELECT id FROM cash_receipts WHERE reverses = ?", (receipt_id,)
            ).fetchone()
            if receipt.reverses is not None or previous is not None:
                raise DomainError(409, "receipt_not_reversible")
            opposite = CashMovement(
                account_id=receipt.account_id,
                direction="withdrawal" if receipt.direction == "deposit" else "deposit",
                amount=receipt.amount,
            )
            return self._book(
                connection, drawer_id, opposite, reverses=receipt_id, reason=reason
            )

    def _reconcile(
        self, connection: sqlite3.Connection, drawer_id: str
    ) -> Reconciliation:
        drawer = cash_storage.get_drawer(connection, drawer_id)
        deposits, withdrawals, count = cash_storage.totals(connection, drawer_id)
        expected = drawer.opening_cash + deposits - withdrawals
        closure = connection.execute(
            "SELECT * FROM drawer_closures WHERE drawer_id = ?", (drawer_id,)
        ).fetchone()
        return Reconciliation(
            drawer_id=drawer_id,
            opening_cash=drawer.opening_cash,
            deposits=deposits,
            withdrawals=withdrawals,
            receipt_count=count,
            expected_cash=expected,
            drawer_cash=drawer.cash,
            balanced=(expected == drawer.cash),
            counted_cash=closure["counted_cash"] if closure else None,
            discrepancy=(closure["counted_cash"] - expected) if closure else None,
            reason=closure["reason"] if closure else None,
            closed_at=closure["closed_at"] if closure else None,
        )

    def reconcile(self, drawer_id: str) -> Reconciliation:
        with self.db.session() as connection:
            return self._reconcile(connection, drawer_id)

    def close_drawer(self, drawer_id: str, request: CloseDrawer) -> Reconciliation:
        with self.db.session(write=True) as connection:
            current = self._reconcile(connection, drawer_id)
            if current.closed_at is not None:
                raise DomainError(409, "drawer_closed")
            if not current.balanced:
                raise DomainError(409, "unbalanced_journal")
            if request.counted_cash != current.expected_cash and not request.reason:
                raise DomainError(422, "difference_requires_reason")
            connection.execute(
                """INSERT INTO drawer_closures(drawer_id, counted_cash, reason, closed_at)
                   VALUES (?, ?, ?, ?)""",
                (
                    drawer_id,
                    request.counted_cash,
                    request.reason,
                    format_timestamp(self.clock()),
                ),
            )
            connection.execute(
                "UPDATE drawers SET status = 'closed' WHERE id = ?", (drawer_id,)
            )
            return self._reconcile(connection, drawer_id)
