# Prinstine-Microfinance-System

## Savings balance reconciliation

After deploy, the backend **automatically** recalculates every savings account balance from **completed** `deposit` and `withdrawal` transactions only (fixes historical drift).

- **Disable** automatic run on server start: set `SKIP_SAVINGS_RECONCILE_ON_START=true` in the backend environment.
- **Manual run** (also from the Savings page for authorized staff): `POST /api/savings/reconcile-balances` with a valid JWT (`admin`, `head_micro_loan`, `supervisor`, or `finance`).
- **Single account:** `POST /api/savings/:id/reconcile` (same roles). The account detail screen shows ledger vs stored balance when they differ.
