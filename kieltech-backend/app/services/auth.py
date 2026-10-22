import hashlib
import json
import secrets
import os
import re
import socket
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional
from app.database import connect_database

try:
    import bcrypt
except ImportError:
    bcrypt = None


def mask_token(token: str) -> str:
    if not token or len(token) < 8:
        return token
    return token[:3] + '\u2022' * 8 + token[-4:]


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


def hash_identifier(value: str) -> str:
    return hashlib.sha256((value or '').strip().lower().encode('utf-8')).hexdigest()


def email_domain_exists(email: str) -> bool:
    domain = (email.rsplit('@', 1)[-1] if '@' in email else '').strip().lower().rstrip('.')
    if not domain:
        return False
    try:
        socket.getaddrinfo(domain, 443, type=socket.SOCK_STREAM)
        return True
    except socket.gaierror:
        return False


def generate_referral_code(length: int = 8) -> str:
    alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    return ''.join(secrets.choice(alphabet) for _ in range(length))


def _google_generated_username(email: str, firebase_uid: str) -> str:
    username_prefix = re.sub(r'[^a-z0-9._-]+', '-', email.split('@', 1)[0].lower()).strip('._-') or 'google-user'
    firebase_suffix = hashlib.sha256(firebase_uid.encode('utf-8')).hexdigest()[:8]
    return f'{username_prefix[:20]}-{firebase_suffix}'


class AuthService:
    def __init__(self):
        self.connection = connect_database()
        self.connection.execute('''CREATE TABLE IF NOT EXISTS auth_users (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL, phone_number TEXT NOT NULL DEFAULT '',
            phone_verified INTEGER NOT NULL DEFAULT 0, free_tier_claimed INTEGER NOT NULL DEFAULT 0,
            free_tier_eligible INTEGER NOT NULL DEFAULT 0, is_admin INTEGER NOT NULL DEFAULT 0,
            is_enterprise_dedicated INTEGER NOT NULL DEFAULT 0, is_blocked INTEGER NOT NULL DEFAULT 0,
            password_auth_enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
        )''')
        user_columns = self.connection.table_columns('auth_users')
        if 'firebase_uid' not in user_columns:
            self.connection.execute('ALTER TABLE auth_users ADD COLUMN firebase_uid TEXT')
            self.connection.commit()
            user_columns = self.connection.table_columns('auth_users')
        self.connection.execute(
            'CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_firebase_uid_unique '
            'ON auth_users (firebase_uid) WHERE firebase_uid IS NOT NULL'
        )
        self.connection.commit()
        if 'referral_code' not in user_columns:
            self.connection.execute('ALTER TABLE auth_users ADD COLUMN referral_code TEXT')
            self.connection.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_referral_code ON auth_users (referral_code) WHERE referral_code IS NOT NULL')
            self.connection.commit()
            user_columns = self.connection.table_columns('auth_users')
        missing_referral_users = self.connection.execute("SELECT id FROM auth_users WHERE referral_code IS NULL OR referral_code = ''").fetchall()
        for missing_user in missing_referral_users:
            referral_code = generate_referral_code()
            while self.connection.execute('SELECT 1 FROM auth_users WHERE referral_code = ?', (referral_code,)).fetchone():
                referral_code = generate_referral_code()
            self.connection.execute('UPDATE auth_users SET referral_code = ? WHERE id = ?', (referral_code, missing_user['id']))
        self.connection.commit()
        if 'blocked_reason' not in user_columns:
            self.connection.execute('ALTER TABLE auth_users ADD COLUMN blocked_reason TEXT')
        if 'username' not in user_columns:
            self.connection.execute('ALTER TABLE auth_users ADD COLUMN username TEXT')
            existing_users = self.connection.execute('SELECT id, email FROM auth_users WHERE username IS NULL OR username = \'\'').fetchall()
            for existing_user in existing_users:
                base_username = existing_user['email'].split('@', 1)[0].lower()
                candidate = base_username[:30] or f'user-{existing_user["id"][:8]}'
                if self.connection.execute('SELECT 1 FROM auth_users WHERE lower(username) = lower(?)', (candidate,)).fetchone():
                    candidate = f'{base_username[:21]}-{existing_user["id"][:8]}'[:30]
                self.connection.execute('UPDATE auth_users SET username = ? WHERE id = ?', (candidate, existing_user['id']))
            self.connection.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_username_unique ON auth_users (lower(username))')
            self.connection.commit()
        existing_users = self.connection.execute('SELECT id, email FROM auth_users WHERE username IS NULL OR username = \'\'').fetchall()
        for existing_user in existing_users:
            base_username = existing_user['email'].split('@', 1)[0].lower()
            candidate = base_username[:30] or f'user-{existing_user["id"][:8]}'
            if self.connection.execute('SELECT 1 FROM auth_users WHERE lower(username) = lower(?)', (candidate,)).fetchone():
                candidate = f'{base_username[:21]}-{existing_user["id"][:8]}'[:30]
            self.connection.execute('UPDATE auth_users SET username = ? WHERE id = ?', (candidate, existing_user['id']))
        self.connection.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_username_unique ON auth_users (lower(username))')
        self.connection.commit()
        if 'email_verified' not in user_columns:
            self.connection.execute('ALTER TABLE auth_users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0')
            self.connection.execute('UPDATE auth_users SET email_verified = 1')
        if 'password_auth_enabled' not in user_columns:
            self.connection.execute('ALTER TABLE auth_users ADD COLUMN password_auth_enabled INTEGER NOT NULL DEFAULT 1')
            google_users = self.connection.execute(
                'SELECT id, email, firebase_uid, username FROM auth_users WHERE firebase_uid IS NOT NULL'
            ).fetchall()
            for google_user in google_users:
                if google_user['username'] == _google_generated_username(google_user['email'], google_user['firebase_uid']):
                    self.connection.execute(
                        'UPDATE auth_users SET password_auth_enabled = 0 WHERE id = ?',
                        (google_user['id'],),
                    )
            self.connection.commit()
        self.connection.execute('''CREATE TABLE IF NOT EXISTS auth_sessions (
            token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL, revoked_at TEXT, last_seen_at TEXT
        )''')
        session_columns = self.connection.table_columns('auth_sessions')
        if 'last_seen_at' not in session_columns:
            self.connection.execute('ALTER TABLE auth_sessions ADD COLUMN last_seen_at TEXT')
            self.connection.execute('UPDATE auth_sessions SET last_seen_at = created_at WHERE last_seen_at IS NULL')
        self.connection.execute('''CREATE TABLE IF NOT EXISTS auth_pending_otps (
            email TEXT PRIMARY KEY, otp TEXT NOT NULL, created_at TEXT NOT NULL,
            phone_number TEXT, device_fingerprint TEXT, ip_address TEXT
        )''')
        self.connection.execute('''CREATE TABLE IF NOT EXISTS auth_email_verifications (
            email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL, consumed_at TEXT, attempts INTEGER NOT NULL DEFAULT 0
        )''')
        self.connection.execute('''CREATE TABLE IF NOT EXISTS auth_pending_signups (
            email TEXT PRIMARY KEY, username TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, password_hash TEXT NOT NULL,
            phone_number TEXT NOT NULL DEFAULT '', device_fingerprint TEXT, referral_code TEXT,
            ip_address TEXT, created_at TEXT NOT NULL
        )''')
        pending_columns = self.connection.table_columns('auth_pending_signups')
        if 'username' not in pending_columns:
            self.connection.execute("ALTER TABLE auth_pending_signups ADD COLUMN username TEXT NOT NULL DEFAULT ''")
            pending_rows = self.connection.execute("SELECT email FROM auth_pending_signups WHERE username = ''").fetchall()
            for pending_row in pending_rows:
                self.connection.execute('UPDATE auth_pending_signups SET username = ? WHERE email = ?', (pending_row['email'].split('@', 1)[0].lower(), pending_row['email']))
        if 'referral_code' not in pending_columns:
            self.connection.execute('ALTER TABLE auth_pending_signups ADD COLUMN referral_code TEXT')
        self.connection.execute('''CREATE TABLE IF NOT EXISTS referral_attributions (
            id BIGSERIAL PRIMARY KEY, referrer_email TEXT NOT NULL, referred_email TEXT UNIQUE NOT NULL,
            referral_code TEXT NOT NULL, reward_amount REAL NOT NULL DEFAULT 0,
            referred_bonus_issued INTEGER NOT NULL DEFAULT 0,
            commission_issued INTEGER NOT NULL DEFAULT 0,
            qualifying_topup_reference TEXT,
            created_at TEXT NOT NULL
        )''')
        referral_columns = self.connection.table_columns('referral_attributions')
        for name, definition in {
            'referred_bonus_issued': 'INTEGER NOT NULL DEFAULT 0',
            'commission_issued': 'INTEGER NOT NULL DEFAULT 0',
            'qualifying_topup_reference': 'TEXT',
            'commission_reversed': 'INTEGER NOT NULL DEFAULT 0',
            'reversal_reference': 'TEXT',
            'reversal_shortfall': 'REAL NOT NULL DEFAULT 0',
        }.items():
            if name not in referral_columns:
                self.connection.execute(f'ALTER TABLE referral_attributions ADD COLUMN {name} {definition}')
        self.connection.execute('''CREATE TABLE IF NOT EXISTS auth_device_claims (
            claim_key TEXT PRIMARY KEY, email TEXT NOT NULL, device_hash TEXT, ip_hash TEXT,
            user_agent_hash TEXT, first_seen_at TEXT NOT NULL, account_id TEXT,
            signup_result TEXT NOT NULL DEFAULT 'verified', created_at TEXT NOT NULL
        )''')
        claim_columns = self.connection.table_columns('auth_device_claims')
        for name, definition in {'device_hash': 'TEXT', 'ip_hash': 'TEXT', 'user_agent_hash': 'TEXT', 'first_seen_at': 'TEXT', 'account_id': 'TEXT', 'signup_result': "TEXT NOT NULL DEFAULT 'verified'"}.items():
            if name not in claim_columns:
                self.connection.execute(f'ALTER TABLE auth_device_claims ADD COLUMN {name} {definition}')
        self.connection.execute('''CREATE TABLE IF NOT EXISTS auth_signup_rate_limits (
            ip_hash TEXT PRIMARY KEY, window_started_at TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0
        )''')
        self.connection.execute('''CREATE TABLE IF NOT EXISTS playground_memories (
            owner_email TEXT NOT NULL, model TEXT NOT NULL, history_json TEXT NOT NULL,
            updated_at TEXT NOT NULL, PRIMARY KEY (owner_email, model)
        )''')
        self.connection.execute('''CREATE TABLE IF NOT EXISTS auth_action_tokens (
            token_hash TEXT PRIMARY KEY, user_id TEXT, email TEXT NOT NULL, action TEXT NOT NULL,
            created_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT
        )''')
        self.connection.execute('''CREATE TABLE IF NOT EXISTS contact_submissions (
            id BIGSERIAL PRIMARY KEY,
            request_id TEXT UNIQUE NOT NULL,
            account_user_id TEXT,
            account_email TEXT,
            contact_name TEXT NOT NULL,
            contact_email TEXT NOT NULL,
            company TEXT NOT NULL,
            role TEXT NOT NULL,
            request_type TEXT NOT NULL,
            estimated_usage TEXT NOT NULL,
            services TEXT NOT NULL,
            deployment_requirements TEXT NOT NULL,
            message TEXT NOT NULL,
            consent_given INTEGER NOT NULL DEFAULT 0,
            consent_at TEXT,
            created_at TEXT NOT NULL
        )''')
        self.connection.commit()

    def _hash_password(self, password: str) -> str:
        return hashlib.sha256(password.encode('utf-8')).hexdigest()

    def _password_matches(self, password: str, stored_hash: str) -> bool:
        if stored_hash.startswith('$2'):
            return bool(bcrypt and bcrypt.checkpw(password.encode('utf-8'), stored_hash.encode('utf-8')))
        return stored_hash == self._hash_password(password)

    def reset(self) -> None:
        self.connection.executescript('DELETE FROM referral_attributions; DELETE FROM auth_users; DELETE FROM auth_sessions; DELETE FROM auth_pending_otps; DELETE FROM auth_email_verifications; DELETE FROM auth_pending_signups; DELETE FROM auth_device_claims;')
        self.connection.commit()

    def list_users(self) -> List[Dict[str, Optional[str]]]:
        return [self._row_to_user(row) for row in self.connection.execute('SELECT * FROM auth_users ORDER BY created_at DESC').fetchall()]

    def _row_to_user(self, row) -> Dict[str, Optional[str]]:
        result = dict(row)
        for field in ('phone_verified', 'email_verified', 'free_tier_claimed', 'free_tier_eligible', 'is_admin', 'is_enterprise_dedicated', 'is_blocked', 'password_auth_enabled'):
            result[field] = bool(result.get(field))
        return result

    def get_user_by_email(self, email: str) -> Optional[Dict[str, Optional[str]]]:
        normalized_email = (email or '').strip().lower()
        row = self.connection.execute('SELECT * FROM auth_users WHERE email = ?', (normalized_email,)).fetchone()
        return self._row_to_user(row) if row else None

    def get_user_by_username(self, username: str) -> Optional[Dict[str, Optional[str]]]:
        normalized_username = (username or '').strip().lower()
        row = self.connection.execute('SELECT * FROM auth_users WHERE lower(username) = lower(?)', (normalized_username,)).fetchone()
        return self._row_to_user(row) if row else None

    def register_user(self, name: str, email: str, password: str, phone_number: Optional[str] = None, device_fingerprint: Optional[str] = None, ip_address: Optional[str] = None) -> Dict[str, Optional[str]]:
        normalized_name = (name or '').strip()
        normalized_email = (email or '').strip().lower()
        if not normalized_name or not normalized_email or not password:
            raise ValueError('name, email and password are required')
        if not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', normalized_email):
            raise ValueError('Enter a valid email address')
        if not email_domain_exists(normalized_email):
            raise ValueError('The email domain does not exist. Check the address and try again.')

        if self.get_user_by_email(normalized_email):
            raise ValueError('Email already registered')

        if device_fingerprint and ip_address:
            claim_key = f"{str(ip_address).lower()}::{str(device_fingerprint).lower()}"
            if self.connection.execute('SELECT 1 FROM auth_device_claims WHERE claim_key = ?', (f'device::{device_hash}',)).fetchone():
                raise ValueError('Free tier already claimed for this device and IP address')

        user_id = secrets.token_hex(8)
        now = datetime.now(timezone.utc).isoformat()
        user = {
            'id': user_id,
            'name': normalized_name,
            'email': normalized_email,
            'password_hash': self._hash_password(password),
            'phone_number': (phone_number or '').strip(),
            'phone_verified': False,
            'free_tier_claimed': False,
            'free_tier_eligible': bool((phone_number or '').strip()),
            'is_admin': False,
            'is_enterprise_dedicated': False,
            'is_blocked': False,
            'created_at': now,
        }
        if user['free_tier_eligible'] and device_fingerprint and ip_address:
            claim_key = f"{str(ip_address).lower()}::{str(device_fingerprint).lower()}"
            self.connection.execute('INSERT INTO auth_device_claims (claim_key, email, created_at) VALUES (?, ?, ?) ON CONFLICT(claim_key) DO NOTHING', (claim_key, normalized_email, now))

        self.connection.execute('INSERT INTO auth_users (id, name, email, password_hash, phone_number, phone_verified, email_verified, free_tier_claimed, free_tier_eligible, is_admin, is_enterprise_dedicated, is_blocked, referral_code, created_at) VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, 0, 0, 0, ?, ?)', (user_id, normalized_name, normalized_email, user['password_hash'], user['phone_number'], int(user['free_tier_eligible']), generate_referral_code(), now))

        if user['free_tier_eligible']:
            otp = f"{secrets.randbelow(900000) + 100000:06d}"
            self.connection.execute('INSERT INTO auth_pending_otps (email, otp, created_at, phone_number, device_fingerprint, ip_address) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET otp = excluded.otp, created_at = excluded.created_at, phone_number = excluded.phone_number, device_fingerprint = excluded.device_fingerprint, ip_address = excluded.ip_address', (normalized_email, otp, now, user['phone_number'], (device_fingerprint or '').strip(), (ip_address or '').strip()))
        self.connection.commit()

        return {
            'id': user_id,
            'name': normalized_name,
            'email': normalized_email,
            'phone_verified': False,
            'free_tier_eligible': user['free_tier_eligible'],
            'is_admin': False,
            'created_at': now,
        }

    def get_or_create_google_user(self, name: str, email: str, firebase_uid: str) -> Dict[str, Optional[str]]:
        normalized_email = (email or '').strip().lower()
        normalized_name = (name or '').strip() or normalized_email.split('@', 1)[0]
        if not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', normalized_email):
            raise ValueError('Google did not provide a valid email address.')

        uid_owner = self.connection.execute(
            'SELECT email FROM auth_users WHERE firebase_uid = ?',
            (firebase_uid,),
        ).fetchone()
        if uid_owner and str(uid_owner['email']).strip().lower() != normalized_email:
            raise ValueError('This Google account is already linked to another KielTech account.')

        user = self.get_user_by_email(normalized_email)
        if user:
            if user.get('is_blocked'):
                raise ValueError(f"ACCOUNT_BLOCKED::{user.get('blocked_reason') or 'Your account has been blocked.'}")
            linked_firebase_uid = str(user.get('firebase_uid') or '')
            if linked_firebase_uid and linked_firebase_uid != firebase_uid:
                raise ValueError('This email is already linked to a different Google account.')
            if not user.get('email_verified') or not linked_firebase_uid:
                self.connection.execute(
                    'UPDATE auth_users SET email_verified = 1, firebase_uid = ? WHERE email = ?',
                    (firebase_uid, normalized_email),
                )
                self.connection.commit()
                user = self.get_user_by_email(normalized_email)
            return user

        user_id = secrets.token_hex(8)
        username = _google_generated_username(normalized_email, firebase_uid)
        referral_code = generate_referral_code()
        while self.connection.execute('SELECT 1 FROM auth_users WHERE referral_code = ?', (referral_code,)).fetchone():
            referral_code = generate_referral_code()
        now = datetime.now(timezone.utc).isoformat()
        self.connection.execute(
            '''INSERT INTO auth_users
               (id, username, name, email, password_hash, phone_number, phone_verified, email_verified, firebase_uid, password_auth_enabled,
                free_tier_claimed, free_tier_eligible, is_admin, is_enterprise_dedicated, is_blocked,
                referral_code, created_at)
               VALUES (?, ?, ?, ?, ?, '', 0, 1, ?, 0, 0, 0, 0, 0, 0, ?, ?)''',
            (
                user_id,
                username,
                normalized_name,
                normalized_email,
                self._hash_password(secrets.token_urlsafe(48)),
                firebase_uid,
                referral_code,
                now,
            ),
        )
        self.connection.commit()
        user = self.get_user_by_email(normalized_email)
        if not user:
            raise RuntimeError('Google account creation did not produce a user record.')
        return user

    def set_user_blocked(self, email: str, blocked: bool, reason: str | None = None) -> Optional[Dict[str, Optional[str]]]:
        normalized_email = (email or '').strip().lower()
        user = self.get_user_by_email(normalized_email)
        if not user:
            return None
        normalized_reason = (reason or '').strip() or None
        self.connection.execute('UPDATE auth_users SET is_blocked = ?, blocked_reason = ? WHERE email = ?', (int(bool(blocked)), normalized_reason if blocked else None, normalized_email))
        self.connection.commit()
        return self.get_user_by_email(normalized_email)

    def claim_free_signup_credit(self, email: str) -> bool:
        normalized_email = (email or '').strip().lower()
        result = self.connection.execute(
            'UPDATE auth_users SET free_tier_claimed = 1 WHERE lower(email) = lower(?) AND free_tier_claimed = 0',
            (normalized_email,),
        )
        self.connection.commit()
        return result.rowcount > 0

    def get_playground_memory(self, email: str, model: str) -> list[dict]:
        row = self.connection.execute(
            'SELECT history_json FROM playground_memories WHERE lower(owner_email) = lower(?) AND model = ?',
            ((email or '').strip().lower(), model),
        ).fetchone()
        if not row:
            return []
        try:
            import json
            history = json.loads(row['history_json'])
            return history if isinstance(history, list) else []
        except (TypeError, ValueError):
            return []

    def save_playground_memory(self, email: str, model: str, history: list[dict]) -> list[dict]:
        normalized_history = [
            {'role': item.get('role'), 'text': str(item.get('text') or '')[:12000]}
            for item in history[-60:]
            if isinstance(item, dict) and item.get('role') in {'user', 'assistant'} and str(item.get('text') or '').strip()
        ]
        now = datetime.now(timezone.utc).isoformat()
        self.connection.execute(
            '''INSERT INTO playground_memories (owner_email, model, history_json, updated_at) VALUES (?, ?, ?, ?)
               ON CONFLICT(owner_email, model) DO UPDATE SET history_json = excluded.history_json, updated_at = excluded.updated_at''',
            ((email or '').strip().lower(), model, json.dumps(normalized_history), now),
        )
        self.connection.commit()
        return normalized_history

    def create_action_token(self, email: str, action: str, expires_minutes: int = 30) -> str:
        user = self.get_user_by_email(email)
        if not user:
            raise ValueError('Account not found')
        raw_token = secrets.token_urlsafe(40)
        now = datetime.now(timezone.utc)
        self.connection.execute(
            'INSERT INTO auth_action_tokens (token_hash, user_id, email, action, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
            (hash_token(raw_token), user['id'], user['email'], action, now.isoformat(), (now + timedelta(minutes=expires_minutes)).isoformat()),
        )
        self.connection.commit()
        return raw_token

    def consume_action_token(self, raw_token: str, action: str) -> dict:
        token_hash = hash_token(raw_token or '')
        now = datetime.now(timezone.utc)
        row = self.connection.execute('SELECT * FROM auth_action_tokens WHERE token_hash = ? AND action = ? AND consumed_at IS NULL', (token_hash, action)).fetchone()
        if not row or now >= datetime.fromisoformat(row['expires_at']):
            raise ValueError('This link is invalid or has expired.')
        self.connection.execute('UPDATE auth_action_tokens SET consumed_at = ? WHERE token_hash = ?', (now.isoformat(), token_hash))
        self.connection.commit()
        return dict(row)

    def update_credentials(self, email: str, username: str | None = None, new_email: str | None = None, password: str | None = None) -> dict:
        user = self.get_user_by_email(email)
        if not user:
            raise ValueError('Account not found')
        normalized_username = (username or '').strip().lower() or user.get('username')
        normalized_email = (new_email or '').strip().lower() or user['email']
        if not re.fullmatch(r'[a-z0-9](?:[a-z0-9._-]{1,28}[a-z0-9])?', normalized_username):
            raise ValueError('Username must be 3-30 characters using letters, numbers, dots, underscores, or hyphens.')
        if not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', normalized_email):
            raise ValueError('Enter a valid email address')
        duplicate_username = self.connection.execute('SELECT 1 FROM auth_users WHERE lower(username) = lower(?) AND id <> ?', (normalized_username, user['id'])).fetchone()
        duplicate_email = self.connection.execute('SELECT 1 FROM auth_users WHERE lower(email) = lower(?) AND id <> ?', (normalized_email, user['id'])).fetchone()
        if duplicate_username:
            raise ValueError('Username already taken')
        if duplicate_email:
            raise ValueError('Email already registered')
        password_hash = self._hash_password(password) if password else user['password_hash']
        password_auth_enabled = 1 if password else int(bool(user.get('password_auth_enabled', True)))
        self.connection.execute(
            'UPDATE auth_users SET username = ?, email = ?, password_hash = ?, password_auth_enabled = ? WHERE id = ?',
            (normalized_username, normalized_email, password_hash, password_auth_enabled, user['id']),
        )
        self.connection.commit()
        return self.get_user_by_email(normalized_email)

    def get_pending_otp(self, email: str) -> Optional[str]:
        normalized_email = (email or '').strip().lower()
        pending = self.connection.execute('SELECT otp FROM auth_pending_otps WHERE email = ?', (normalized_email,)).fetchone()
        return pending['otp'] if pending else None

    def verify_otp(self, email: str, otp: str, device_fingerprint: Optional[str] = None, ip_address: Optional[str] = None) -> Dict[str, Optional[str]]:
        normalized_email = (email or '').strip().lower()
        user = self.get_user_by_email(normalized_email)
        if not user:
            raise ValueError('User not found')

        pending = self.connection.execute('SELECT * FROM auth_pending_otps WHERE email = ?', (normalized_email,)).fetchone()
        if not pending or str(pending['otp']) != str(otp):
            raise ValueError('Invalid OTP')

        self.connection.execute('UPDATE auth_users SET phone_verified = 1 WHERE email = ?', (normalized_email,))
        self.connection.execute('DELETE FROM auth_pending_otps WHERE email = ?', (normalized_email,))

        free_tier_granted = False
        if user.get('free_tier_eligible') and not user.get('free_tier_claimed'):
            claim_key = None
            if device_fingerprint and ip_address:
                claim_key = f"{str(ip_address).lower()}::{str(device_fingerprint).lower()}"
            elif pending['device_fingerprint'] and pending['ip_address']:
                claim_key = f"{str(pending['ip_address']).lower()}::{str(pending['device_fingerprint']).lower()}"
            if claim_key:
                self.connection.execute('INSERT INTO auth_device_claims (claim_key, email, created_at) VALUES (?, ?, ?) ON CONFLICT(claim_key) DO UPDATE SET email = excluded.email, created_at = excluded.created_at', (claim_key, normalized_email, datetime.now(timezone.utc).isoformat()))
            self.connection.execute('UPDATE auth_users SET free_tier_claimed = 1 WHERE email = ?', (normalized_email,))
            free_tier_granted = True
        self.connection.commit()
        user = self.get_user_by_email(normalized_email)

        return {
            'email': normalized_email,
            'phone_verified': user['phone_verified'],
            'free_tier_granted': free_tier_granted,
        }

    def login_user(self, identifier: str, password: str) -> Dict[str, Optional[str]]:
        normalized_identifier = (identifier or '').strip().lower()
        if '@' in normalized_identifier:
            if not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', normalized_identifier):
                raise ValueError('Enter a valid email address or username')
            if not email_domain_exists(normalized_identifier):
                raise ValueError('The email domain does not exist. Check the address and try again.')
            user = self.get_user_by_email(normalized_identifier)
        else:
            user_row = self.connection.execute('SELECT * FROM auth_users WHERE lower(username) = lower(?)', (normalized_identifier,)).fetchone()
            user = self._row_to_user(user_row) if user_row else None
        if not user:
            pending = self.connection.execute(
                'SELECT email FROM auth_pending_signups WHERE lower(email) = lower(?) OR lower(username) = lower(?)',
                (normalized_identifier, normalized_identifier),
            ).fetchone()
            if pending:
                raise ValueError('Verify your email before logging in. Check your inbox for the 10-minute verification code.')
            raise ValueError('Email is not registered. Create an account first.')
        if user.get('is_blocked'):
            raise ValueError(f"ACCOUNT_BLOCKED::{user.get('blocked_reason') or 'Your account has been blocked.'}")
        if not user.get('email_verified'):
            raise ValueError('Verify your email before logging in. Check your inbox for the 10-minute verification code.')
        if not user.get('password_auth_enabled', True):
            raise ValueError(
                "PASSWORD_SIGN_IN_UNAVAILABLE::This account doesn't support password sign-in. "
                'Sign in with Google instead, or set up a password in Settings once you are logged in.'
            )
        if not self._password_matches(password, user['password_hash']):
            raise ValueError('Incorrect password')

        token = f"kt-user-{secrets.token_urlsafe(24)}"
        now = datetime.now(timezone.utc)
        self.connection.execute('INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)', (hash_token(token), user['id'], now.isoformat(), (now + timedelta(days=7)).isoformat(), now.isoformat()))
        self.connection.commit()
        return {
            'token': token,
            'user': {
                'id': user['id'],
                'name': user['name'],
                'email': user['email'],
                'is_admin': user['is_admin'],
                'is_enterprise_dedicated': bool(user.get('is_enterprise_dedicated')),
                'created_at': user['created_at'],
            },
        }

    def verify_password(self, email: str, password: str) -> bool:
        user = self.get_user_by_email(email)
        return bool(user and user.get('password_auth_enabled', True) and self._password_matches(password or '', user['password_hash']))

    def create_email_verification(self, email: str) -> tuple[str, datetime]:
        normalized_email = (email or '').strip().lower()
        code = f'{secrets.randbelow(900000) + 100000:06d}'
        now = datetime.now(timezone.utc)
        expires_at = now + timedelta(minutes=10)
        self.connection.execute('INSERT INTO auth_email_verifications (email, code_hash, created_at, expires_at, consumed_at, attempts) VALUES (?, ?, ?, ?, NULL, 0) ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, created_at = excluded.created_at, expires_at = excluded.expires_at, consumed_at = NULL, attempts = 0', (normalized_email, hash_token(code), now.isoformat(), expires_at.isoformat()))
        self.connection.commit()
        return code, expires_at

    def create_pending_signup(self, username: str, email: str, password: str, phone_number: Optional[str] = None, device_fingerprint: Optional[str] = None, ip_address: Optional[str] = None, user_agent: Optional[str] = None, referral_code: Optional[str] = None) -> dict:
        normalized_username = (username or '').strip().lower()
        normalized_email = (email or '').strip().lower()
        normalized_device = (device_fingerprint or '').strip().lower()
        normalized_ip = (ip_address or '').strip()
        device_hash = hash_identifier(normalized_device)
        ip_hash = hash_identifier(normalized_ip)
        user_agent_hash = hash_identifier(user_agent or '')
        if not normalized_username or not normalized_email or not password:
            raise ValueError('username, email and password are required')
        if not re.fullmatch(r'[a-z0-9](?:[a-z0-9._-]{1,28}[a-z0-9])?', normalized_username):
            raise ValueError('Username must be 3-30 characters using letters, numbers, dots, underscores, or hyphens.')
        if not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', normalized_email):
            raise ValueError('Enter a valid email address')
        if not email_domain_exists(normalized_email):
            raise ValueError('The email domain does not exist. Check the address and try again.')
        if self.get_user_by_email(normalized_email):
            raise ValueError('Email already registered')
        normalized_referral_code = (referral_code or '').strip().upper()
        if normalized_referral_code:
            referrer = self.connection.execute('SELECT id, email FROM auth_users WHERE referral_code = ?', (normalized_referral_code,)).fetchone()
            if not referrer:
                raise ValueError('That referral link is no longer valid.')
            if referrer['email'] == normalized_email:
                raise ValueError('You cannot refer your own account.')
            if normalized_device and self.connection.execute(
                'SELECT 1 FROM auth_device_claims WHERE account_id = ? AND device_hash = ?',
                (referrer['id'], device_hash),
            ).fetchone():
                raise ValueError('This referral cannot be used from the same device as the referring account.')
        if self.connection.execute('SELECT 1 FROM auth_users WHERE lower(username) = lower(?)', (normalized_username,)).fetchone() or self.connection.execute('SELECT 1 FROM auth_pending_signups WHERE lower(username) = lower(?)', (normalized_username,)).fetchone():
            raise ValueError('Username already taken')
        if normalized_device:
            claim_key = f'device::{device_hash}'
            if self.connection.execute('SELECT 1 FROM auth_device_claims WHERE claim_key = ?', (claim_key,)).fetchone():
                raise ValueError('This device has already been used to create an account.')
            if self.connection.execute('SELECT 1 FROM auth_pending_signups WHERE device_fingerprint = ? AND email <> ?', (device_hash, normalized_email)).fetchone():
                raise ValueError('This device already has a pending signup. Verify it before creating another account.')
        rate = self.connection.execute('SELECT * FROM auth_signup_rate_limits WHERE ip_hash = ?', (ip_hash,)).fetchone()
        now_dt = datetime.now(timezone.utc)
        if rate and now_dt - datetime.fromisoformat(rate['window_started_at']) < timedelta(hours=1):
            if int(rate['attempt_count'] or 0) >= 3:
                raise ValueError('Too many signup attempts from this network. Try again later.')
            self.connection.execute('UPDATE auth_signup_rate_limits SET attempt_count = attempt_count + 1 WHERE ip_hash = ?', (ip_hash,))
        else:
            self.connection.execute('INSERT INTO auth_signup_rate_limits (ip_hash, window_started_at, attempt_count) VALUES (?, ?, 1) ON CONFLICT(ip_hash) DO UPDATE SET window_started_at = excluded.window_started_at, attempt_count = 1', (ip_hash, now_dt.isoformat()))
        existing = self.connection.execute('SELECT 1 FROM auth_pending_signups WHERE email = ?', (normalized_email,)).fetchone()
        if existing:
            self.connection.execute('DELETE FROM auth_pending_signups WHERE email = ?', (normalized_email,))
        now = datetime.now(timezone.utc).isoformat()
        self.connection.execute(
            'INSERT INTO auth_pending_signups (email, username, name, password_hash, phone_number, device_fingerprint, referral_code, ip_address, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (normalized_email, normalized_username, normalized_username, self._hash_password(password), (phone_number or '').strip(), device_hash, normalized_referral_code or None, ip_hash, now),
        )
        if normalized_device:
            self.connection.execute('INSERT INTO auth_device_claims (claim_key, email, device_hash, ip_hash, user_agent_hash, first_seen_at, account_id, signup_result, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?) ON CONFLICT(claim_key) DO UPDATE SET signup_result = excluded.signup_result', (f'device::{device_hash}', normalized_email, device_hash, ip_hash, user_agent_hash, now, 'pending', now))
        self.connection.commit()
        return {'username': normalized_username, 'email': normalized_email, 'created_at': now, 'referral_code': normalized_referral_code or None}

    def verify_email(self, email: str, code: str) -> Dict[str, object]:
        normalized_email = (email or '').strip().lower()
        record = self.connection.execute('SELECT * FROM auth_email_verifications WHERE email = ?', (normalized_email,)).fetchone()
        now = datetime.now(timezone.utc)
        if not record or record['consumed_at'] or now >= datetime.fromisoformat(record['expires_at']):
            raise ValueError('This verification code has expired. Request a new code.')
        if int(record['attempts'] or 0) >= 5:
            raise ValueError('Too many verification attempts. Request a new code.')
        if not secrets.compare_digest(record['code_hash'], hash_token(str(code or '').strip())):
            self.connection.execute('UPDATE auth_email_verifications SET attempts = attempts + 1 WHERE email = ?', (normalized_email,))
            self.connection.commit()
            raise ValueError('Invalid verification code.')
        pending = self.connection.execute('SELECT * FROM auth_pending_signups WHERE email = ?', (normalized_email,)).fetchone()
        user = self.get_user_by_email(normalized_email)
        if not pending and not user:
            raise ValueError('Signup request not found.')
        if pending and not user:
            user_id = secrets.token_hex(8)
            self.connection.execute(
                'INSERT INTO auth_users (id, username, name, email, password_hash, phone_number, phone_verified, email_verified, free_tier_claimed, free_tier_eligible, is_admin, is_enterprise_dedicated, is_blocked, referral_code, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, 1, 0, ?, 0, 0, 0, ?, ?)',
                (user_id, pending['username'], pending['name'], pending['email'], pending['password_hash'], pending['phone_number'], int(bool(pending['phone_number'])), generate_referral_code(), pending['created_at']),
            )
            if pending.get('referral_code'):
                referrer = self.connection.execute('SELECT email FROM auth_users WHERE referral_code = ?', (pending['referral_code'],)).fetchone()
                if referrer and referrer['email'] != pending['email']:
                    self.connection.execute(
                        'INSERT INTO referral_attributions (referrer_email, referred_email, referral_code, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(referred_email) DO NOTHING',
                        (referrer['email'], pending['email'], pending['referral_code'], pending['created_at']),
                    )
            self.connection.execute('DELETE FROM auth_pending_signups WHERE email = ?', (normalized_email,))
            if pending['device_fingerprint']:
                claim_key = f"device::{str(pending['device_fingerprint']).lower()}"
                self.connection.execute('UPDATE auth_device_claims SET account_id = ?, signup_result = ? WHERE claim_key = ?', (user_id, 'verified', claim_key))
            user = self.get_user_by_email(normalized_email)
        else:
            self.connection.execute('UPDATE auth_users SET email_verified = 1 WHERE email = ?', (normalized_email,))
        self.connection.execute('UPDATE auth_email_verifications SET consumed_at = ? WHERE email = ?', (now.isoformat(), normalized_email))
        self.connection.commit()
        token = f"kt-user-{secrets.token_urlsafe(24)}"
        self.create_session_for_user(user['id'], token)
        return {'email': normalized_email, 'email_verified': True, 'token': token, 'user': {'id': user['id'], 'name': user['name'], 'email': user['email'], 'is_admin': user['is_admin'], 'is_enterprise_dedicated': bool(user.get('is_enterprise_dedicated')), 'created_at': user['created_at']}}

    def save_contact_submission(self, values: dict, request_id: str, account_user_id: str | None, account_email: str | None, consent_at: str) -> None:
        self.connection.execute(
            'INSERT INTO contact_submissions (request_id, account_user_id, account_email, contact_name, contact_email, company, role, request_type, estimated_usage, services, deployment_requirements, message, consent_given, consent_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (request_id, account_user_id, account_email, values['name'], values['email'].lower(), values['company'], values['role'], values['request_type'], values['usage'], values['services'], values['deployment'], values['message'], 1, consent_at, consent_at),
        )
        self.connection.commit()

    def create_session_for_user(self, user_id: str, token: str, days: int = 7) -> None:
        now = datetime.now(timezone.utc)
        self.connection.execute('INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(token_hash) DO UPDATE SET user_id = excluded.user_id, created_at = excluded.created_at, expires_at = excluded.expires_at, last_seen_at = excluded.last_seen_at, revoked_at = NULL', (hash_token(token), user_id, now.isoformat(), (now + timedelta(days=days)).isoformat(), now.isoformat()))
        self.connection.commit()

    def get_user_from_token(self, token: str) -> Optional[Dict[str, Optional[str]]]:
        if not token:
            return None
        now = datetime.now(timezone.utc)
        row = self.connection.execute('SELECT s.last_seen_at, u.* FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?', (hash_token(token), now.isoformat())).fetchone()
        if not row:
            return None
        last_seen_at = row.get('last_seen_at') if hasattr(row, 'get') else row['last_seen_at']
        if not last_seen_at or (now - datetime.fromisoformat(last_seen_at)).total_seconds() >= 30:
            self.connection.execute('UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?', (now.isoformat(), hash_token(token)))
            self.connection.commit()
        user = self._row_to_user(row)
        return {
            'id': user['id'],
            'username': user.get('username'),
            'name': user['name'],
            'email': user['email'],
            'firebase_uid': user.get('firebase_uid'),
            'is_admin': user['is_admin'],
            'is_enterprise_dedicated': bool(user.get('is_enterprise_dedicated')),
            'is_blocked': bool(user.get('is_blocked')),
            'blocked_reason': user.get('blocked_reason'),
            'created_at': user['created_at'],
        }

    def set_user_admin(self, email: str, is_admin: bool = True) -> Optional[Dict[str, Optional[str]]]:
        self.connection.execute('UPDATE auth_users SET is_admin = ? WHERE email = ?', (int(bool(is_admin)), (email or '').strip().lower()))
        self.connection.commit()
        return self.get_user_by_email(email)

    def set_user_enterprise(self, email: str, enabled: bool = True) -> Optional[Dict[str, Optional[str]]]:
        self.connection.execute('UPDATE auth_users SET is_enterprise_dedicated = ? WHERE email = ?', (int(bool(enabled)), (email or '').strip().lower()))
        self.connection.commit()
        return self.get_user_by_email(email)

    def revoke_session(self, token: str) -> None:
        self.connection.execute('UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?', (datetime.now(timezone.utc).isoformat(), hash_token(token)))
        self.connection.commit()

    def close(self) -> None:
        self.connection.close()


class TokenService:
    def __init__(self):
        self.connection = connect_database()
        self.connection.execute('''CREATE TABLE IF NOT EXISTS api_tokens (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
            masked TEXT NOT NULL DEFAULT 'kt-********', owner_email TEXT, created_at TEXT NOT NULL, last_used_at TEXT, active INTEGER NOT NULL DEFAULT 1
        )''')
        columns = self.connection.table_columns('api_tokens')
        if 'masked' not in columns:
            self.connection.execute("ALTER TABLE api_tokens ADD COLUMN masked TEXT NOT NULL DEFAULT 'kt-********'")
        self.connection.execute("ALTER TABLE api_tokens ALTER COLUMN masked SET DEFAULT 'kt-********'")
        self.connection.execute(
            'UPDATE api_tokens SET masked = REPLACE(masked, ?, ?) WHERE masked LIKE ?',
            ('\u00e2\u20ac\u00a2', '\u2022', '%\u00e2\u20ac\u00a2%'),
        )
        self.connection.commit()

    def create_token(self, name: str, owner_email: Optional[str] = None) -> Dict[str, str]:
        normalized_name = name.strip()
        if self.connection.execute("SELECT 1 FROM api_tokens WHERE lower(name) = lower(?) AND lower(coalesce(owner_email, '')) = lower(coalesce(?, ''))", (normalized_name, owner_email)).fetchone():
            raise ValueError('Token name already used')

        token_value = f"kt-{secrets.token_urlsafe(24)}"
        token_id = secrets.token_hex(8)
        created_at = datetime.now(timezone.utc).isoformat()
        self.connection.execute('INSERT INTO api_tokens (id, name, token_hash, masked, owner_email, created_at, active) VALUES (?, ?, ?, ?, ?, ?, 1)', (token_id, normalized_name, hash_token(token_value), mask_token(token_value), (owner_email or '').strip().lower() or None, created_at))
        self.connection.commit()
        return {
            'id': token_id,
            'name': normalized_name,
            'token': token_value,
            'masked': mask_token(token_value),
            'owner_email': (owner_email or '').strip().lower() or None,
            'created_at': created_at,
            'last_used_at': None,
            'active': True,
        }

    def list_tokens(self, owner_email: Optional[str] = None) -> List[Dict[str, Optional[str]]]:
        query = 'SELECT id, name, masked, owner_email, created_at, last_used_at, active FROM api_tokens'
        query += ' WHERE active = 1'
        params = ()
        if owner_email:
            query += ' AND lower(owner_email) = lower(?)'
            params = (owner_email,)
        rows = self.connection.execute(query + ' ORDER BY created_at DESC', params).fetchall()
        return [{'id': row['id'], 'name': row['name'], 'owner_email': row['owner_email'], 'masked': row['masked'], 'created_at': row['created_at'], 'last_used_at': row['last_used_at'], 'active': bool(row['active'])} for row in rows]

    def authenticate(self, token_value: str) -> Optional[Dict[str, Optional[str]]]:
        row = self.connection.execute('SELECT id, name, owner_email, created_at, last_used_at, active FROM api_tokens WHERE token_hash = ? AND active = 1', (hash_token(token_value),)).fetchone()
        if not row:
            return None
        now = datetime.now(timezone.utc).isoformat()
        self.connection.execute('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', (now, row['id']))
        self.connection.commit()
        return {'id': row['id'], 'name': row['name'], 'owner_email': row['owner_email'], 'created_at': row['created_at'], 'last_used_at': now, 'active': True}

    def revoke_token(self, token_id: str, owner_email: Optional[str] = None) -> bool:
        query = 'UPDATE api_tokens SET active = 0 WHERE id = ? AND active = 1'
        params: tuple[str, ...] = (token_id,)
        if owner_email:
            query += ' AND lower(owner_email) = lower(?)'
            params = (token_id, owner_email.strip().lower())
        result = self.connection.execute(query, params)
        self.connection.commit()
        return result.rowcount > 0

    def close(self) -> None:
        self.connection.close()
