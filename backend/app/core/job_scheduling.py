import random
from datetime import datetime, timedelta

from app.core.config import (
    ACCOUNT_COMMENT_COOLDOWN_MIN_SECONDS,
    ACCOUNT_COMMENT_COOLDOWN_MAX_SECONDS,
)
from app.core.time_utils import parse_to_naive_utc

# Gap between consecutive X posts per account (seconds, random).
X_MIN_GAP_SECONDS = 15
X_MAX_GAP_SECONDS = 45


def _threads_cooldown() -> timedelta:
    """Return a random Threads inter-comment cooldown (120-300 s)."""
    return timedelta(seconds=random.randint(ACCOUNT_COMMENT_COOLDOWN_MIN_SECONDS, ACCOUNT_COMMENT_COOLDOWN_MAX_SECONDS))


def build_account_cooldown_tracker(accounts, active_jobs, now=None, platform=None):
    """
    Map each account's _id (str) to the earliest time it can next post,
    based on last_activity and jobs already queued/retrying for it.
    - Threads: random 120-300 s cooldown per reservation.
    - X: random 15-45 s gap.
    Pass platform explicitly so active_jobs are spaced with the right gap.
    """
    now = now or datetime.utcnow()
    tracker = {}
    for acc in accounts:
        last_activity = parse_to_naive_utc(acc.get("last_activity"))
        acc_platform = platform or acc.get("platform", "")
        if acc_platform == "Threads":
            gap = _threads_cooldown()
        elif acc_platform == "X":
            gap = timedelta(seconds=X_MIN_GAP_SECONDS)
        else:
            gap = timedelta(seconds=0)
        tracker[str(acc["_id"])] = (last_activity + gap) if last_activity else now

    for job in active_jobs:
        acc_id_str = str(job["account_id"])
        if acc_id_str not in tracker:
            continue
        job_scheduled = parse_to_naive_utc(job.get("scheduled_time")) or now
        if platform == "X":
            gap = timedelta(seconds=random.randint(X_MIN_GAP_SECONDS, X_MAX_GAP_SECONDS))
        else:
            gap = _threads_cooldown()
        candidate = job_scheduled + gap
        if candidate > tracker[acc_id_str]:
            tracker[acc_id_str] = candidate

    return tracker


def reserve_account_schedule(tracker, account_id_str, platform, now=None):
    """
    Returns (scheduled_time, is_delayed) for the next job assigned to this
    account and advances the tracker so subsequent jobs for the same account
    are spaced out by the cooldown.
    - Threads: enforces ACCOUNT_COMMENT_COOLDOWN_SECONDS between posts.
    - X: enforces a random 15-45s gap between consecutive posts per account
      to avoid bursting from one account in rapid succession.
    """
    now = now or datetime.utcnow()

    if platform == "Threads":
        scheduled_time = max(now, tracker.get(account_id_str, now))
        tracker[account_id_str] = scheduled_time + _threads_cooldown()
        is_delayed = scheduled_time > now + timedelta(seconds=1)
        return scheduled_time, is_delayed

    if platform == "X":
        scheduled_time = max(now, tracker.get(account_id_str, now))
        gap = timedelta(seconds=random.randint(X_MIN_GAP_SECONDS, X_MAX_GAP_SECONDS))
        tracker[account_id_str] = scheduled_time + gap
        is_delayed = scheduled_time > now + timedelta(seconds=1)
        return scheduled_time, is_delayed

    return now, False
