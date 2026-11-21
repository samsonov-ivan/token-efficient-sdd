"""Public request shapes and stable domain errors used by the HTTP layer."""

from datetime import UTC, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

Money = Annotated[int, Field(strict=True, ge=0, le=2**63 - 1)]
Amount = Annotated[int, Field(strict=True, gt=0, le=2**63 - 1)]
AccountId = Annotated[
    str,
    StringConstraints(min_length=1, max_length=80, pattern=r"^[^/\x00-\x1f]+$"),
]
AccountKind = Literal["personal", "business"]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NewAccount(RequestModel):
    id: AccountId
    kind: AccountKind = "personal"
    balance: Money = 0


class NewTransfer(RequestModel):
    source: AccountId
    destination: AccountId
    amount: Amount


class DomainError(Exception):
    def __init__(self, status: int, code: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code


def format_timestamp(value: datetime) -> str:
    """Store a timezone-independent UTC timestamp, with one-second precision."""
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("clock must return a timezone-aware datetime")
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
