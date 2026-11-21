"""HTTP adapter for teller drawers, immutable cash receipts and shift closure."""

from fastapi import APIRouter

from .cash_count import CountResult, DenominationCount, preview_count
from .cash_desk import CashDesk
from .cash_models import (
    CashMovement,
    CloseDrawer,
    DrawerView,
    OpenDrawer,
    Receipt,
    Reconciliation,
    ReverseMovement,
)


def cash_router(desk: CashDesk) -> APIRouter:
    router = APIRouter(prefix="/cash/drawers")

    @router.post("", status_code=201)
    def open_drawer(request: OpenDrawer) -> DrawerView:
        return desk.open_drawer(request)

    @router.get("/{drawer_id}")
    def get_drawer(drawer_id: str) -> DrawerView:
        return desk.drawer(drawer_id)

    @router.post("/{drawer_id}/receipts", status_code=201)
    def create_receipt(drawer_id: str, request: CashMovement) -> Receipt:
        return desk.book(drawer_id, request)

    @router.get("/{drawer_id}/receipts/{receipt_id}")
    def get_receipt(drawer_id: str, receipt_id: int) -> Receipt:
        return desk.receipt(drawer_id, receipt_id)

    @router.post("/{drawer_id}/receipts/{receipt_id}/reverse", status_code=201)
    def reverse_receipt(
        drawer_id: str, receipt_id: int, request: ReverseMovement
    ) -> Receipt:
        return desk.reverse(drawer_id, receipt_id, request.reason)

    @router.get("/{drawer_id}/reconciliation")
    def reconciliation(drawer_id: str) -> Reconciliation:
        return desk.reconcile(drawer_id)

    @router.post("/{drawer_id}/count")
    def count_cash(drawer_id: str, request: DenominationCount) -> CountResult:
        return preview_count(desk.reconcile(drawer_id), request)

    @router.post("/{drawer_id}/close")
    def close_drawer(drawer_id: str, request: CloseDrawer) -> Reconciliation:
        return desk.close_drawer(drawer_id, request)

    return router
