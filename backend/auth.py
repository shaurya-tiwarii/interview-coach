"""Authentication: scrypt password hashing (stdlib) + opaque session tokens.

Sessions are stored server-side in SQLite and delivered to the browser as an
HttpOnly cookie named ``ic_session``. The Authorization: Bearer header is also
accepted so API clients can authenticate without cookies.
"""
import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, Request

from . import db

COOKIE_NAME = "ic_session"
SESSION_DAYS = 30
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "0") == "1"

_SCRYPT_N = 16384
_SCRYPT_R = 8
_SCRYPT_P = 1


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode("utf-8"), salt=salt,
                        n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, dklen=64)
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt_hex, dk_hex = stored.split("$")
        if algo != "scrypt":
            return False
        dk = hashlib.scrypt(password.encode("utf-8"), salt=bytes.fromhex(salt_hex),
                            n=int(n), r=int(r), p=int(p), dklen=64)
        return hmac.compare_digest(dk.hex(), dk_hex)
    except Exception:
        return False


def new_token() -> str:
    return secrets.token_urlsafe(32)


def _token_from_request(request: Request) -> str | None:
    token = request.cookies.get(COOKIE_NAME)
    if token:
        return token
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip() or None
    return None


def get_current_user(request: Request) -> dict:
    """FastAPI dependency: returns the logged-in user row or raises 401."""
    token = _token_from_request(request)
    if not token:
        raise HTTPException(401, "not authenticated")
    sess = db.get_auth_session(token)
    if not sess:
        raise HTTPException(401, "session expired or invalid")
    user = db.get_user(sess["user_id"])
    if not user:
        raise HTTPException(401, "account no longer exists")
    return dict(user)


def issue_session(response, user_id: str) -> str:
    """Create a server-side session and set the cookie on the response."""
    token = new_token()
    expires = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)
    db.create_auth_session(token, user_id, expires.isoformat())
    response.set_cookie(
        COOKIE_NAME, token,
        max_age=SESSION_DAYS * 86400,
        httponly=True, samesite="lax", secure=COOKIE_SECURE, path="/",
    )
    return token


def clear_session(response, request: Request) -> None:
    token = _token_from_request(request)
    if token:
        db.delete_auth_session(token)
    response.delete_cookie(COOKIE_NAME, path="/")
