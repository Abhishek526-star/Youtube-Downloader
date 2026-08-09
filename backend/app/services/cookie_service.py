"""
Secure in-memory cookie handling.

Cookies are stored ONLY in RAM, keyed by job_id. They are:
- Never written to disk
- Never logged
- Used for exactly one yt-dlp operation
- Deleted immediately after use (or on error)

This avoids exposing a persistent cookie file on the server filesystem.
"""
import logging
from typing import Dict, Optional

logger = logging.getLogger(__name__)

# In-memory store: job_id -> cookies_text (Netscape format string)
_COOKIE_STORE: Dict[str, str] = {}


def store_cookies(job_id: str, cookies_text: str) -> None:
    """Store cookies in memory for a specific job."""
    if not cookies_text or not cookies_text.strip():
        return
    _COOKIE_STORE[job_id] = cookies_text
    logger.info(f"[{job_id}] Cookies stored in memory ({len(cookies_text)} chars)")


def get_cookies(job_id: str) -> Optional[str]:
    """Retrieve cookies for a job (returns None if none stored)."""
    return _COOKIE_STORE.get(job_id)


def delete_cookies(job_id: str) -> None:
    """Remove cookies from memory after use."""
    if job_id in _COOKIE_STORE:
        del _COOKIE_STORE[job_id]
        logger.info(f"[{job_id}] Cookies purged from memory")


def has_cookies(job_id: str) -> bool:
    return job_id in _COOKIE_STORE


def validate_cookie_format(cookies_text: str) -> tuple[bool, str]:
    """
    Basic sanity check that the uploaded file looks like a Netscape cookies file.
    Returns (is_valid, message).
    """
    if not cookies_text or len(cookies_text.strip()) < 20:
        return False, "Cookie file appears empty or too small."

    lines = cookies_text.strip().splitlines()
    # Netscape format starts with a comment header line containing "Netscape"
    # OR contains tab-separated cookie entries with .youtube.com / .google.com domains
    has_header = any("netscape" in line.lower() for line in lines[:3])
    has_yt_domain = any(
        (".youtube.com" in line or ".google.com" in line) and "\t" in line
        for line in lines
    )

    if not (has_header or has_yt_domain):
        return False, "File doesn't look like a valid YouTube cookies export (Netscape format)."

    return True, "OK"