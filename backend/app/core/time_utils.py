from datetime import datetime, timezone


def parse_to_naive_utc(val) -> datetime:
    """
    Converts a datetime object or ISO string (with or without timezone offset/Z)
    to a timezone-naive UTC datetime object.
    """
    if not val:
        return None
    if isinstance(val, str):
        try:
            if val.endswith("Z"):
                val = val[:-1] + "+00:00"
            dt = datetime.fromisoformat(val)
            if dt.tzinfo is not None:
                dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
            return dt
        except Exception:
            return datetime.utcnow()
    elif isinstance(val, datetime):
        if val.tzinfo is not None:
            return val.astimezone(timezone.utc).replace(tzinfo=None)
        return val
    return datetime.utcnow()
