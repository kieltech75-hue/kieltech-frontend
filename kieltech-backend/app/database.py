import os
import re
from typing import Any

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:
    psycopg = None
    dict_row = None

class DatabaseConnection:
    """PostgreSQL connection wrapper with placeholder translation for legacy queries."""

    def __init__(self):
        self._dsn = os.getenv('DATABASE_URL', '').strip()
        if not self._dsn.startswith(('postgres://', 'postgresql://')):
            raise RuntimeError('DATABASE_URL must be a PostgreSQL connection string.')
        if psycopg is None:
            raise RuntimeError('psycopg is required for PostgreSQL DATABASE_URL')
        self.connection = psycopg.connect(self._dsn, row_factory=dict_row)

    def _ensure_connection(self):
        if getattr(self.connection, 'closed', False):
            self.connection = psycopg.connect(self._dsn, row_factory=dict_row)
        return self.connection

    def _translate(self, query: str, params: tuple[Any, ...] = ()) -> tuple[str, tuple[Any, ...]]:
        normalized = query.strip()
        normalized = re.sub(r'\?', '%s', query)
        normalized = re.sub(r'\bINSERT\s+OR\s+IGNORE\s+INTO\b', 'INSERT INTO', normalized, flags=re.I)
        if re.search(r'INSERT INTO', normalized, flags=re.I) and 'ON CONFLICT' not in normalized.upper() and re.search(r'auth_device_claims|api_tokens', normalized, flags=re.I):
            normalized += ' ON CONFLICT DO NOTHING'
        return normalized, params

    def execute(self, query: str, params: tuple[Any, ...] = ()):
        self._ensure_connection()
        translated, translated_params = self._translate(query, params)
        return self.connection.execute(translated, translated_params)

    def executescript(self, script: str):
        statements = [statement.strip() for statement in script.split(';') if statement.strip()]
        for statement in statements:
            self.execute(statement)
        return None

    def table_columns(self, table_name: str) -> set[str]:
        rows = self.execute(
            'SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = %s',
            (table_name,),
        ).fetchall()
        return {row['name'] for row in rows}

    def commit(self):
        self._ensure_connection()
        return self.connection.commit()

    def rollback(self):
        self._ensure_connection()
        return self.connection.rollback()

    def close(self):
        return self.connection.close()


def connect_database() -> DatabaseConnection:
    return DatabaseConnection()
