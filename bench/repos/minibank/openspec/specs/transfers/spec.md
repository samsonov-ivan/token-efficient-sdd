# transfers Specification

## Purpose

Define how the local ledger records ordinary payments, protects account balances and exposes the resulting operation history.

## Requirements

### Requirement: REQ-TXN-01 Atomic account transfers

The service SHALL settle an ordinary transfer in one transaction and preserve balances if it cannot complete the request.

#### Scenario: SCN-TXN-01.1 Settle an ordinary payment

- **WHEN** a valid payment for a positive amount within the sender's available balance is accepted
- **THEN** return 201, a unique integer transfer ID, source, destination, amount, status and creation time
- **AND** an ordinary completed same-currency payment decreases the sender's balance and increases the recipient's by that amount

#### Scenario: SCN-TXN-01.2 Reject an invalid amount

- **WHEN** an amount is zero, negative, fractional, a string or boolean
- **THEN** return 422 without changing the ledger

#### Scenario: SCN-TXN-01.3 Refuse unsettled payments

- **WHEN** an ordinary transfer would overdraw the sender, overflow the recipient or use an unknown account
- **THEN** return the corresponding insufficient_funds, balance_overflow or account_not_found error without recording a payment

#### Scenario: SCN-TXN-01.4 Handle competing withdrawals

- **WHEN** two otherwise valid transfers individually fit the balance but their sum exceeds it
- **THEN** only an affordable payment settles and the resulting balances agree with history

### Requirement: REQ-TXN-02 Operation history

The service SHALL retrieve recorded transactions by integer ID and list an account's incoming and outgoing transactions newest first.

#### Scenario: SCN-TXN-02.1 Read the history

- **WHEN** a client reads an account's history
- **THEN** the items array contains only related payments in descending ID order and is empty when there are no payments

#### Scenario: SCN-TXN-02.2 Retrieve a recorded transaction

- **WHEN** a client requests an existing transaction after restarting on the same database
- **THEN** its identifier, parties, amount, status and creation time are preserved
- **AND** an unknown transaction returns 404 with code transfer_not_found

#### Scenario: SCN-TXN-02.3 Normalize time

- **WHEN** the clock supplies an instant with a timezone offset
- **THEN** the payment stores the equivalent UTC time using second precision and the Z suffix
