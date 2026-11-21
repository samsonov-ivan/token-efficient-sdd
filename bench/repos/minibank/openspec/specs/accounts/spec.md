# accounts Specification

## Purpose

Define the public account lifecycle and the persistent balance that subsequent ledger operations use.

## Requirements

### Requirement: REQ-ACC-01 Account registration

The service SHALL create persistent personal and business accounts with unique identifiers and nonnegative integer balances in minor units.

#### Scenario: SCN-ACC-01.1 Create and retrieve an account

- **WHEN** a client posts a new account and reads it by identifier
- **THEN** both responses include the requested identifier, account kind, initial balance and open status
- **AND** omitted kind and balance default to personal and zero

#### Scenario: SCN-ACC-01.2 Reject a repeated identifier

- **WHEN** a client registers an existing identifier
- **THEN** the service returns 409 with code account_exists and preserves the existing account

#### Scenario: SCN-ACC-01.3 Reject a malformed account

- **WHEN** a client sends a malformed identifier, unknown account kind or invalid opening balance
- **THEN** validation returns 422 and no account is created

### Requirement: REQ-ACC-02 Account closure

The service SHALL preserve an account and its balance after closure and refuse further outgoing payments.

#### Scenario: SCN-ACC-02.1 Close an existing account

- **WHEN** a client closes an account once or several times
- **THEN** the account is marked closed, its balance remains available and the state survives reopening the database

#### Scenario: SCN-ACC-02.2 Closed account initiates a transfer

- **WHEN** a transfer specifies a closed source account
- **THEN** the service returns 409 with code account_closed and preserves both balances

#### Scenario: SCN-ACC-02.3 Unknown identifier

- **WHEN** a client requests the details, closure or history of an unknown account
- **THEN** the service returns 404 with code account_not_found
