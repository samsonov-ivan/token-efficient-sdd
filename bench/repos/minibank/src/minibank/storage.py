"""SQLite transactions and the initial ledger schema."""

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('personal', 'business')),
    balance INTEGER NOT NULL CHECK (typeof(balance) = 'integer' AND balance >= 0),
    closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1))
);
CREATE TABLE IF NOT EXISTS transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL REFERENCES accounts(id),
    destination TEXT NOT NULL REFERENCES accounts(id),
    amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount > 0),
    status TEXT NOT NULL DEFAULT 'completed',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS transfers_by_source ON transfers(source, id);
CREATE INDEX IF NOT EXISTS transfers_by_destination ON transfers(destination, id);
"""


class Database:
    """Each request owns a connection; related writes commit together."""

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        if str(path) == ":memory:":
            raise ValueError("Pass a database file shared by request connections")
        with self.session() as connection:
            connection.executescript(SCHEMA)

    @contextmanager
    def session(self, *, write: bool = False) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=10.0, isolation_level=None)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()
