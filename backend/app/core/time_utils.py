from datetime import datetime, timedelta, timezone

# Vietnam timezone offset (UTC+7)
_VN_OFFSET = timedelta(hours=7)


def compute_next_fixed_time(fixed_times: list, from_dt: datetime = None) -> datetime:
    """Return the next UTC datetime matching one of the HH:MM times (Vietnam time UTC+7)."""
    now_utc = from_dt or datetime.utcnow()
    now_vn = now_utc + _VN_OFFSET
    candidates = []
    for time_str in fixed_times:
        try:
            h, m = map(int, str(time_str).split(":"))
            cand_vn = now_vn.replace(hour=h, minute=m, second=0, microsecond=0)
            cand_utc = cand_vn - _VN_OFFSET
            if cand_utc > now_utc:
                candidates.append(cand_utc)
        except (ValueError, TypeError):
            continue
    if candidates:
        return min(candidates)
    # All today's slots passed — use tomorrow (Vietnam date)
    tomorrow_vn = (now_vn + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    for time_str in fixed_times:
        try:
            h, m = map(int, str(time_str).split(":"))
            cand_vn = tomorrow_vn.replace(hour=h, minute=m, second=0, microsecond=0)
            candidates.append(cand_vn - _VN_OFFSET)
        except (ValueError, TypeError):
            continue
    return min(candidates) if candidates else now_utc + timedelta(hours=24)


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
