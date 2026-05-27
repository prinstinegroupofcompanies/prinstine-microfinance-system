# Prinstine-Microfinance-System

## Savings balances

Savings account balances are updated when deposits and withdrawals are recorded (including initial opening deposits at account creation). Balances are **not** recalculated from transaction history automatically.

After deploying an update that removes reconciliation, the server runs a **one-time restore** on startup to credit back initial opening deposits that were removed by the old reconciliation process. To skip that restore: set `SKIP_SAVINGS_INITIAL_DEPOSIT_RESTORE=true` on the backend.

Manual restore (from project root):

```bash
node backend/scripts/restore-savings-initial-deposits.js
```

Or call `POST /api/savings/restore-initial-deposits` as admin, head micro loan, head micro finance, or finance (after deploying the updated restore logic).
