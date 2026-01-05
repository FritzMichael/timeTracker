# Time Tracker

A multi-user time tracking app with authentication, Excel export, and push notifications.
Very basic, mostly vibe coded - still useful for simple time tracking needs.

## Features

- ✅ **Multi-user support** with user accounts
- ✅ **Local authentication** (username/password)
- ✅ **GitHub OAuth** (optional)
- ✅ **Timezone aware** - logs times in user's local timezone
- ✅ Clock in/out with NFC tags
- ✅ Track work hours automatically
- ✅ Add daily comments/notes
- ✅ Export to Excel
- ✅ Push notification reminders
- ✅ Works on desktop and mobile
- ✅ Progressive Web App (PWA)
- ✅ Self-hosted with Docker

## Quick Start

### Using Docker Compose

1. Create the project directory structure:
```bash
mkdir timetracker
cd timetracker
```

2. Copy `.env.example` to `.env` and configure:
```bash
cp .env.example .env
# Edit .env with your settings
```

3. Start the application:
```bash
docker-compose up -d
```

4. Access at `http://localhost:3000`

### Manual Setup

1. Install dependencies:
```bash
npm install
```

2. Copy and configure environment:
```bash
cp .env.example .env
# Edit .env with your settings
```

3. Start the server:
```bash
npm start
```

## Authentication

### Local Authentication (Default)
Users can register with a username and password. This works completely offline after initial setup.

### GitHub OAuth (Optional)
To enable "Sign in with GitHub":

1. Go to [GitHub Developer Settings](https://github.com/settings/developers)
2. Click "New OAuth App"
3. Fill in:
   - **Application name**: Time Tracker
   - **Homepage URL**: `http://localhost:3000`
   - **Authorization callback URL**: `http://localhost:3000/auth/github/callback`
4. Copy the Client ID and Client Secret to your `.env` file:
   ```
   GITHUB_CLIENT_ID=your_client_id
   GITHUB_CLIENT_SECRET=your_client_secret
   ```
5. Restart the server

**Note**: GitHub OAuth requires an internet connection to authenticate. Local username/password login works offline.

## File Structure

- `server.js` - Express backend with SQLite database
- `public/index.html` - Frontend PWA interface
- `public/manifest.json` - PWA manifest
- `public/sw.js` - Service worker for offline support and push notifications
- `data/timetracker.db` - SQLite database (auto-created)

## NFC Setup

### Android:

1. Open the Time Tracker app in your browser
2. Install it as a PWA (Add to Home Screen)
3. Get an NFC tag (NTAG213 or similar)
4. Use an NFC writing app like "NFC Tools"
5. Write a URL record with your server address (e.g., `http://192.168.1.100:3000`)
6. Tap the tag to open the app and clock in/out

### iPhone:

1. Open Shortcuts app
2. Create a new shortcut
3. Add "Open URL" action with your server address
4. Add an Automation triggered by NFC tag
5. Scan your NFC tag and link it to the shortcut

## Push Notifications

1. Open the app and go to Settings
2. Click "Enable Notifications"
3. Allow notification permissions
4. Set your preferred reminder time
5. You'll get reminders if you forget to clock out

## Data Backup

Your SQLite database is stored in `./data/timetracker.db`. Back this up regularly:

```bash
# Copy the database
cp data/timetracker.db data/timetracker.backup.db

# Or use docker volume backup
docker run --rm -v timetracker_data:/data -v $(pwd):/backup alpine tar czf /backup/timetracker-backup.tar.gz -C /data .
```

## Export to Excel

Click the "Export to Excel" button in the History tab to download all your time entries as an Excel file. Times are exported in your local timezone as they were logged.

## Timezone Handling

The app logs all times in your **local timezone**, not the server's timezone. This means:

- If you clock in at 9:00 AM in New York, it's stored as 9:00 AM (not 2:00 PM UTC)
- Date boundaries are correct for your timezone (11 PM doesn't become next day)
- When traveling, times are logged in your current timezone
- Excel exports show times exactly as you logged them

For more details, see [TIMEZONE.md](TIMEZONE.md).

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3000 |
| `NODE_ENV` | Environment mode | development |
| `SESSION_SECRET` | Session encryption key | (auto-generated, set for production) |
| `GITHUB_CLIENT_ID` | GitHub OAuth Client ID | (optional) |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth Client Secret | (optional) |
| `GITHUB_CALLBACK_URL` | OAuth callback URL | /auth/github/callback |

## Security Notes

This app includes built-in authentication. For production deployments:

- Set a strong `SESSION_SECRET` in your `.env` file
- Use HTTPS (required for PWA features and secure cookies)
- Use a reverse proxy (nginx, Caddy)
- Consider using PostgreSQL instead of SQLite for better concurrency
- Set `NODE_ENV=production` for secure cookies

## Troubleshooting

**NFC tag not working:**
- Make sure NFC is enabled on your phone
- Verify the URL is correct (use IP address, not localhost)
- Try writing the tag again

**Push notifications not working:**
- Ensure HTTPS is enabled (required for service workers in production)
- Check notification permissions in browser settings
- Verify the service worker is registered (check browser DevTools)

**Can't access from phone:**
- Make sure your phone and server are on the same network
- Use the server's IP address, not localhost
- Check firewall settings

## License

MIT