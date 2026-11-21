"""Account and transfer operations used by the HTTP application."""

from collections.abc import Callable
from datetime import datetime

from . import repository
from .models import DomainError, NewAccount, NewTransfer, format_timestamp
from .storage import Database


class Ledger:
    def __init__(self, database: Database, clock: Callable[[], datetime]) -> None:
        self.database = database
        self.clock = clock

    def create_account(self, request: NewAccount) -> dict:
        with self.database.session(write=True) as connection:
            return repository.insert_account(connection, request)

    def account(self, account_id: str) -> dict:
        with self.database.session() as connection:
            return repository.account_record(connection, account_id)

    def close(self, account_id: str) -> dict:
        with self.database.session(write=True) as connection:
            return repository.close_account(connection, account_id)

    def transfer(self, request: NewTransfer) -> dict:
        with self.database.session(write=True) as connection:
            sender = repository.account_record(connection, request.source)
            repository.account_record(connection, request.destination)
            if sender["closed"]:
                raise DomainError(409, "account_closed")
            created_at = format_timestamp(self.clock())
            repository.debit(connection, request.source, request.amount)
            repository.credit(connection, request.destination, request.amount)
            return repository.insert_transfer(connection, request, created_at)

    def transfer_by_id(self, transfer_id: int) -> dict:
        with self.database.session() as connection:
            return repository.transfer_record(connection, transfer_id)

    def history(self, account_id: str) -> dict:
        with self.database.session() as connection:
            repository.account_record(connection, account_id)
            return {"items": repository.list_transfers(connection, account_id)}
