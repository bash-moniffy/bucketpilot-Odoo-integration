import re
from calendar import monthrange
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError, available_timezones

from .storage import BackupError


TIMEZONES = frozenset(available_timezones())


def normalize(value):
    if not isinstance(value, dict) or value.get("frequency") not in ("now", "once", "daily", "weekly", "monthly"):
        raise BackupError("Choose a frequency.")
    try:
        zone = value.get("timezone") or "UTC"
        if zone not in TIMEZONES:
            raise ValueError
        clock = value.get("time", "02:00")
        if not re.fullmatch(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]", clock):
            raise ValueError
        time.fromisoformat(clock)
        weekday, monthday = int(value.get("weekday", 1)), int(value.get("monthday", 1))
        if not 1 <= weekday <= 7 or not 1 <= monthday <= 31:
            raise ValueError
        day = value.get("date") or ""
        if not isinstance(day, str) or len(day) > 10:
            raise ValueError
        if value["frequency"] == "once":
            day = date.fromisoformat(day).isoformat()
    except (ValueError, TypeError, ZoneInfoNotFoundError):
        raise BackupError("Choose a valid date, local time and timezone.") from None
    return dict(frequency=value["frequency"], timezone=zone, time=clock, weekday=weekday,
                monthday=monthday, date=day)


def next_run(value, after):
    schedule = normalize(value)
    frequency = schedule["frequency"]
    if frequency == "now":
        return 0
    zone = ZoneInfo(schedule["timezone"])
    clock = time.fromisoformat(schedule["time"])
    first = after.replace(tzinfo=timezone.utc).astimezone(zone).date()
    if frequency == "once":
        days = [date.fromisoformat(schedule["date"])]
    else:
        days = (first + timedelta(days=i) for i in range(370))
    for day in days:
        if frequency == "weekly" and day.isoweekday() != schedule["weekday"]:
            continue
        if frequency == "monthly" and day.day != min(schedule["monthday"], monthrange(day.year, day.month)[1]):
            continue
        wall = datetime.combine(day, clock, zone).replace(fold=0)
        stamp = wall.astimezone(timezone.utc).replace(tzinfo=None)
        if stamp > after:
            return stamp
    return 0
