# cash-desks Specification

## Purpose

Define the cash teller's durable receipts and explain how the end-of-shift count can be reconciled against the transactions recorded for one drawer.

## Requirements

### Requirement: REQ-CASH-01 Cash journal

The service SHALL balance each cash deposit or withdrawal across the cash drawer and the customer's account in one transaction.

#### Scenario: SCN-CASH-01.1 Open a shift

- **WHEN** a teller opens a unique drawer with nonnegative opening cash
- **THEN** the journal is empty and cash equals the opening count
- **AND** reuse of the identifier fails without changing prior records

#### Scenario: SCN-CASH-01.2 Record a movement

- **WHEN** a teller books cash with an open drawer and an open account
- **THEN** credit or debit both balances, and issue a dated receipt with each resulting balance
- **AND** ordinary bank transfers leave the cash journal untouched

#### Scenario: SCN-CASH-01.3 Refuse an impossible movement

- **WHEN** a payment has an unknown account or drawer, unavailable cash, unavailable funds, an invalid amount or a resulting balance outside the supported integer range
- **THEN** preserve both balances and the receipt journal

### Requirement: REQ-CASH-02 Corrections

The service SHALL allow exactly one offsetting receipt per original booking when the opposite movement can settle.

#### Scenario: SCN-CASH-02.1 Correct a receipt

- **WHEN** a teller reverses a booking with a reason
- **THEN** keep the original receipt and record a new opposite receipt with its own ID, the original receipt ID and the reason

#### Scenario: SCN-CASH-02.2 Refuse an invalid reversal

- **WHEN** a reversal cannot settle, has already settled or targets a reversal
- **THEN** record no receipt and leave both balances unchanged
- **AND** concurrent reversals create at most one correction

### Requirement: REQ-CASH-03 Shift reconciliation

The service SHALL reconstruct each drawer's expected cash from its opening count and receipts and retain the teller's closing count and any discrepancy.

#### Scenario: SCN-CASH-03.1 Close a reconciled shift

- **WHEN** the teller provides a closing count and explains any difference
- **THEN** store the count, discrepancy, reason and closing time
- **AND** preserve all entries and prevent further booking or repeated closure

#### Scenario: SCN-CASH-03.2 Scope the records

- **WHEN** a teller looks up a receipt or statement in a drawer
- **THEN** only that drawer's receipts are included

#### Scenario: SCN-CASH-03.3 Preview a physical count

- **WHEN** a teller enters the quantity of each supported denomination in minor units
- **THEN** return the total physical item count, exact amount and signed difference against the journal without closing or changing the shift
- **AND** reject unsupported or repeated denominations, invalid item counts or a physical total exceeding the supported balance
