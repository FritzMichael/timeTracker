# Timezone Handling

## Overview

The Time Tracker app now properly handles multiple timezones by logging times in the user's **local timezone** rather than the server's timezone.

## How It Works

### Before (Problem)
- ❌ Server used `new Date()` to get current time in server's timezone
- ❌ A user in New York (EST) clocking in at 9:00 AM would see 2:00 PM if server was in UTC
- ❌ Date boundaries were incorrect (11 PM user time could be next day server time)

### After (Solution)
- ✅ Client sends local date, time, and timezone to server
- ✅ Server stores the user's local time and timezone in database
- ✅ Times are always displayed in the user's local context
- ✅ Proper date boundaries based on user's timezone

## Implementation Details

### Database Changes

A new `timezone` column was added to the `entries` table:

```sql
ALTER TABLE entries ADD COLUMN timezone TEXT;
```

The migration runs automatically when the server starts.

### API Changes

All clock-in/out endpoints now accept optional timezone parameters:

**Clock In**
```javascript
POST /api/clock-in
{
  "date": "2026-01-05",        // YYYY-MM-DD in user's local timezone
  "time": "09:30",              // HH:MM in user's local timezone
  "timezone": "America/New_York" // IANA timezone identifier
}
```

**Clock Out**
```javascript
POST /api/clock-out
{
  "date": "2026-01-05",
  "time": "17:30",
  "timezone": "America/New_York",
  "comment": "Worked on feature X"
}
```

**Toggle (NFC)**
```javascript
POST /api/toggle
{
  "date": "2026-01-05",
  "time": "09:30",
  "timezone": "America/New_York"
}
```

### Client Changes

A helper function generates local date/time/timezone:

```javascript
function getLocalDateTime() {
  const now = new Date();
  const date = now.toLocaleDateString('en-CA'); // YYYY-MM-DD
  const time = now.toLocaleTimeString('en-GB', { 
    hour: '2-digit', 
    minute: '2-digit' 
  }); // HH:MM
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { date, time, timezone };
}
```

This function is called before each clock-in/out operation.

### Backward Compatibility

The implementation maintains full backward compatibility:

- If a client doesn't send date/time/timezone, server falls back to server time
- Existing entries without timezone continue to work
- Old clients continue to function (using server time)

## Examples

### Example 1: User in New York

- User clocks in at 9:00 AM EST
- Client sends: `{ date: "2026-01-05", time: "09:00", timezone: "America/New_York" }`
- Server stores exactly: `09:00` with timezone `America/New_York`
- User sees `09:00` in their history

### Example 2: User in Tokyo

- User clocks in at 10:00 PM JST (which is 8:00 AM UTC)
- Client sends: `{ date: "2026-01-05", time: "22:00", timezone: "Asia/Tokyo" }`
- Server stores: `22:00` with timezone `Asia/Tokyo`
- Date is correctly `2026-01-05` (not the next day)

### Example 3: User Traveling

- User travels from New York to London
- Times are logged in current local timezone
- Each entry has its own timezone:
  - Monday: `09:00` in `America/New_York`
  - Tuesday: `09:00` in `Europe/London`
- Export shows times as they were logged

## Excel Export

Excel reports now include a note:

> Note: Times are displayed in the user's local timezone

Each entry in the export shows times exactly as they were logged in the user's local timezone.

## Future Enhancements

Potential improvements for future versions:

1. **Timezone Conversion**: Display all times in a selected timezone
2. **Team View**: Show team members' times in manager's timezone
3. **Timezone Detection**: Warn if timezone changes frequently (possible misconfiguration)
4. **Historical Display**: Option to view past entries in their original timezone vs current timezone

## Testing

To verify timezone handling:

1. **Database Test**:
   ```bash
   sqlite3 data/timetracker.db "PRAGMA table_info(entries);"
   # Should show 'timezone' column
   ```

2. **Manual Test**:
   - Open browser DevTools
   - Override timezone (DevTools > Sensors > Location)
   - Clock in/out and verify times match your selected timezone

3. **Multi-timezone Test**:
   - Clock in with one timezone
   - Change browser timezone
   - Clock out
   - Verify both times are correct for their respective timezones

## Migration Notes

- Existing databases automatically get the timezone column added
- Existing entries without timezone data continue to work
- No data loss or corruption during migration
- Migration is idempotent (safe to run multiple times)
