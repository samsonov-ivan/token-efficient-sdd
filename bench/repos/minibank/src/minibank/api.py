"""Create a local HTTP API backed by a single SQLite database file."""

from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .models import DomainError, NewAccount, NewTransfer
from .service import Ledger
from .storage import Database


def utc_now() -> datetime:
    return datetime.now(UTC)


def create_app(
    db_path: Path | str, *, clock: Callable[[], datetime] = utc_now
) -> FastAPI:
    """Use a file per application and an optional clock for deterministic tests."""
    app = FastAPI(title="Minibank", version="0.1.0")
    ledger = Ledger(Database(db_path), clock)

    @app.exception_handler(DomainError)
    async def handle_error(_request: Request, error: DomainError) -> JSONResponse:
        return JSONResponse({"error": {"code": error.code}}, status_code=error.status)

    @app.post("/accounts", status_code=201)
    def create_account(request: NewAccount) -> dict:
        return ledger.create_account(request)

    @app.get("/accounts/{account_id}")
    def account(account_id: str) -> dict:
        return ledger.account(account_id)

    @app.post("/accounts/{account_id}/close")
    def close_account(account_id: str) -> dict:
        return ledger.close(account_id)

    @app.post("/transfers", status_code=201)
    def transfer(request: NewTransfer) -> dict:
        return ledger.transfer(request)

    @app.get("/transfers/{transfer_id}")
    def transfer_by_id(transfer_id: int) -> dict:
        return ledger.transfer_by_id(transfer_id)

    @app.get("/accounts/{account_id}/history")
    def history(account_id: str) -> dict:
        return ledger.history(account_id)

    return app
