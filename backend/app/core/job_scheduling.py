from datetime import datetime, timedelta

from app.core.config import ACCOUNT_COMMENT_COOLDOWN_SECONDS
from app.core.time_utils import parse_to_naive_utc

COOLDOWN = timedelta(seconds=ACCOUNT_COMMENT_COOLDOWN_SECONDS)


def build_account_cooldown_tracker(accounts, active_jobs, now=None):
    """
    Map each account's _id (str) to the earliest time it can next post a
    Threads comment without violating ACCOUNT_COMMENT_COOLDOWN_SECONDS,
    based on its last_activity and any jobs already queued/retrying for it.
    """
    now = now or datetime.utcnow()
    tracker = {}
    for acc in accounts:
        last_activity = parse_to_naive_utc(acc.get("last_activity"))
        tracker[str(acc["_id"])] = (last_activity + COOLDOWN) if last_activity else now

    for job in active_jobs:
        acc_id_str = str(job["account_id"])
        if acc_id_str not in tracker:
            continue
        job_scheduled = parse_to_naive_utc(job.get("scheduled_time")) or now
        candidate = job_scheduled + COOLDOWN
        if candidate > tracker[acc_id_str]:
            tracker[acc_id_str] = candidate

    return tracker


def reserve_account_schedule(tracker, account_id_str, platform, now=None):
    """
    Returns (scheduled_time, is_delayed) for the next job assigned to this
    account and advances the tracker so subsequent jobs for the same account
    are spaced out by the cooldown. Only Threads needs this spacing.
    """
    now = now or datetime.utcnow()
    if platform != "Threads":
        return now, False

    scheduled_time = max(now, tracker.get(account_id_str, now))
    tracker[account_id_str] = scheduled_time + COOLDOWN
    is_delayed = scheduled_time > now + timedelta(seconds=1)
    return scheduled_time, is_delayed
