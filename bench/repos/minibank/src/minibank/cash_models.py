"""Cash desk contracts, with amounts in the same minor units as the ledger."""

from typing import Annotated, Literal

from pydantic import Field, StringConstraints

from .models import AccountId, Amount, Money, RequestModel

DrawerId = AccountId
Direction = Literal["deposit", "withdrawal"]
Reason = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)
]


class OpenDrawer(RequestModel):
    id: DrawerId
    opening_cash: Money


class CashMovement(RequestModel):
    account_id: AccountId
    direction: Direction
    amount: Amount


class CloseDrawer(RequestModel):
    counted_cash: Money
    reason: Reason | None = None


class ReverseMovement(RequestModel):
    reason: Reason


class DrawerView(RequestModel):
    id: str
    opening_cash: int
    cash: int
    status: Literal["open", "closed"]
    opened_at: str


class Receipt(RequestModel):
    id: int
    drawer_id: str
    account_id: str
    direction: Direction
    amount: int
    account_balance_after: int
    drawer_cash_after: int
    recorded_at: str
    reverses: int | None
    reason: str | None


class Reconciliation(RequestModel):
    drawer_id: str
    opening_cash: int
    deposits: int
    withdrawals: int
    receipt_count: int = Field(ge=0)
    expected_cash: int
    drawer_cash: int
    balanced: bool
    counted_cash: int | None
    discrepancy: int | None
    reason: str | None
    closed_at: str | None
