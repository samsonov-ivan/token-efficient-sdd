"""Physical drawer counts are entered as quantities of supported coins and notes."""

from typing import Annotated

from pydantic import BaseModel, Field

from .cash_models import Reconciliation
from .models import DomainError, RequestModel

Count = Annotated[int, Field(strict=True, ge=0, le=2**63 - 1)]
# Each value is in kopecks. The teller submits the same units as the journal.
DENOMINATIONS = frozenset(
    {
        1,
        5,
        10,
        50,
        100,
        200,
        500,
        1000,
        5000,
        10000,
        20000,
        50000,
        100000,
        200000,
        500000,
    }
)


class DenominationLine(RequestModel):
    denomination: Count
    quantity: Count


class DenominationCount(RequestModel):
    lines: list[DenominationLine] = Field(max_length=len(DENOMINATIONS))


class CountResult(BaseModel):
    drawer_id: str
    items: int
    counted_cash: int
    expected_cash: int
    discrepancy: int
    matches: bool


def preview_count(report: Reconciliation, request: DenominationCount) -> CountResult:
    """Validate a teller's draft without closing or changing the drawer."""
    seen = set()
    items = 0
    total = 0
    for line in request.lines:
        if line.denomination not in DENOMINATIONS:
            raise DomainError(422, "unknown_denomination")
        if line.denomination in seen:
            raise DomainError(422, "repeated_denomination")
        seen.add(line.denomination)
        items += line.quantity
        total += line.denomination * line.quantity
    if total > 2**63 - 1:
        raise DomainError(422, "cash_count_overflow")
    return CountResult(
        drawer_id=report.drawer_id,
        items=items,
        counted_cash=total,
        expected_cash=report.expected_cash,
        discrepancy=total - report.expected_cash,
        matches=total == report.expected_cash,
    )
