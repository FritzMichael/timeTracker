require('dotenv').config();

const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GitHubStrategy = require('passport-github2').Strategy;
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const webpush = require('web-push');
const path = require('path');
const fs = require('fs');

// Load modules
const EmailReports = require('./lib/emailReports');
const ExcelReport = require('./lib/excelReport');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy - needed when behind Caddy/nginx
app.set('trust proxy', 1);

// Middleware
app.use(express.json());

// Serve manifest.json with correct content-type
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

app.use(express.static('public'));

// Initialize SQLite database
const db = new Database(path.join(__dirname, 'data', 'timetracker.db'));

// Create tables with multi-user support
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    github_id TEXT UNIQUE,
    email TEXT,
    avatar_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    check_in TEXT,
    check_out TEXT,
    comment TEXT,
    timezone TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    UNIQUE(user_id, key),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT UNIQUE NOT NULL,
    keys TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS vapid_keys (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Migration: Add timezone column to entries table if it doesn't exist
try {
  const tableInfo = db.prepare("PRAGMA table_info(entries)").all();
  const hasTimezone = tableInfo.some(col => col.name === 'timezone');
  
  if (!hasTimezone) {
    console.log('Running database migration: Adding timezone column to entries table...');
    db.exec('ALTER TABLE entries ADD COLUMN timezone TEXT');
    console.log('✅ Migration successful: timezone column added to entries table');
  }
} catch (err) {
  console.error('❌ Database migration failed:', err.message);
  console.error('   Details:', err);
  console.error('   The application may not function correctly. Please check database permissions.');
  // Don't crash the server - allow it to start even if migration fails
  // This maintains availability while alerting admins to the issue
}

// Session configuration
app.use(session({
  store: new SQLiteStore({ 
    db: 'sessions.db', 
    dir: path.join(__dirname, 'data')
  }),
  secret: process.env.SESSION_SECRET || 'time-tracker-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use(passport.initialize());
app.use(passport.session());

// Passport serialization
passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser((id, done) => {
  try {
    const user = db.prepare('SELECT id, username, email, avatar_url FROM users WHERE id = ?').get(id);
    done(null, user);
  } catch (err) {
    done(err, null);
  }
});

// Local Strategy (username/password)
passport.use(new LocalStrategy(
  async (username, password, done) => {
    try {
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      
      if (!user) {
        return done(null, false, { message: 'Invalid username or password' });
      }
      
      if (!user.password_hash) {
        return done(null, false, { message: 'Please login with GitHub' });
      }
      
      const isValid = await bcrypt.compare(password, user.password_hash);
      if (!isValid) {
        return done(null, false, { message: 'Invalid username or password' });
      }
      
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }
));

// GitHub Strategy (optional - only if credentials are configured)
const githubEnabled = process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET;

if (githubEnabled) {
  passport.use(new GitHubStrategy({
      clientID: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      callbackURL: process.env.GITHUB_CALLBACK_URL || '/auth/github/callback'
    },
    (accessToken, refreshToken, profile, done) => {
      try {
        let user = db.prepare('SELECT * FROM users WHERE github_id = ?').get(profile.id);
        
        if (!user) {
          const existingUser = db.prepare('SELECT * FROM users WHERE username = ?').get(profile.username);
          
          if (existingUser) {
            db.prepare('UPDATE users SET github_id = ?, avatar_url = ? WHERE id = ?')
              .run(profile.id, profile.photos?.[0]?.value, existingUser.id);
            user = existingUser;
          } else {
            const email = profile.emails?.[0]?.value || null;
            const avatarUrl = profile.photos?.[0]?.value || null;
            
            const result = db.prepare(
              'INSERT INTO users (username, github_id, email, avatar_url) VALUES (?, ?, ?, ?)'
            ).run(profile.username, profile.id, email, avatarUrl);
            
            user = { id: result.lastInsertRowid, username: profile.username, email, avatar_url: avatarUrl };
          }
        }
        
        return done(null, user);
      } catch (err) {
        return done(err);
      }
    }
  ));
}

// Generate VAPID keys if they don't exist
const vapidKeysStmt = db.prepare('SELECT value FROM vapid_keys WHERE key = ?');
let vapidPublicKey = vapidKeysStmt.get('public')?.value;
let vapidPrivateKey = vapidKeysStmt.get('private')?.value;

if (!vapidPublicKey || !vapidPrivateKey) {
  const vapidKeys = webpush.generateVAPIDKeys();
  vapidPublicKey = vapidKeys.publicKey;
  vapidPrivateKey = vapidKeys.privateKey;
  
  const insertStmt = db.prepare('INSERT OR REPLACE INTO vapid_keys (key, value) VALUES (?, ?)');
  insertStmt.run('public', vapidPublicKey);
  insertStmt.run('private', vapidPrivateKey);
}

webpush.setVapidDetails(
  'mailto:admin@example.com',
  vapidPublicKey,
  vapidPrivateKey
);

// Initialize email reports module
const emailReports = new EmailReports(db);

// Auth middleware
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ error: 'Not authenticated' });
}

// ============ AUTH ROUTES ============

app.get('/api/user', (req, res) => {
  if (req.isAuthenticated()) {
    res.json({
      id: req.user.id,
      username: req.user.username,
      email: req.user.email,
      avatar_url: req.user.avatar_url
    });
  } else {
    res.json(null);
  }
});

app.get('/api/auth/providers', (req, res) => {
  res.json({
    local: true,
    github: githubEnabled
  });
});

app.post('/auth/register', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  
  if (username.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  }
  
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  
  try {
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      return res.status(400).json({ error: 'Username already taken' });
    }
    
    const passwordHash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run(username, passwordHash);
    
    const user = { id: result.lastInsertRowid, username };
    
    req.login(user, (err) => {
      if (err) {
        return res.status(500).json({ error: 'Login failed after registration' });
      }
      res.json({ success: true, user: { id: user.id, username: user.username } });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/auth/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!user) {
      return res.status(401).json({ error: info?.message || 'Login failed' });
    }
    req.login(user, (err) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ 
        success: true, 
        user: { 
          id: user.id, 
          username: user.username,
          email: user.email,
          avatar_url: user.avatar_url
        }
      });
    });
  })(req, res, next);
});

app.post('/auth/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ success: true });
  });
});

if (githubEnabled) {
  app.get('/auth/github', passport.authenticate('github', { scope: ['user:email'] }));
  
  app.get('/auth/github/callback',
    passport.authenticate('github', { failureRedirect: '/?error=github_auth_failed' }),
    (req, res) => {
      res.redirect('/');
    }
  );
}

// ============ API ROUTES (Protected) ============

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidPublicKey });
});

app.get('/api/status', requireAuth, (req, res) => {
  try {
    // Accept client date from query parameter for proper timezone handling
    const today = req.query.date || new Date().toISOString().split('T')[0];
    const stmt = db.prepare('SELECT * FROM entries WHERE user_id = ? AND date = ? ORDER BY id DESC LIMIT 1');
    const entry = stmt.get(req.user.id, today);
    
    // Get the last entry with a comment (could be from a previous day)
    let lastComment = null;
    let lastCommentDate = null;
    try {
      const lastCommentStmt = db.prepare('SELECT comment, date FROM entries WHERE user_id = ? AND comment IS NOT NULL AND comment != ? ORDER BY date DESC, id DESC LIMIT 1');
      const lastCommentEntry = lastCommentStmt.get(req.user.id, '');
      if (lastCommentEntry) {
        lastComment = lastCommentEntry.comment;
        lastCommentDate = lastCommentEntry.date;
      }
    } catch (commentErr) {
      console.error('Error fetching last comment:', commentErr);
      // Continue without the last comment feature
    }
    
    const status = {
      hasEntry: !!entry,
      checkedIn: entry?.check_in && !entry?.check_out,
      checkedOut: !!entry?.check_out,
      entry: entry || null,
      lastComment: lastComment,
      lastCommentDate: lastCommentDate
    };
    
    res.json(status);
  } catch (err) {
    console.error('Error in /api/status:', err);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

app.post('/api/clock-in', requireAuth, (req, res) => {
  // Accept client time and timezone
  const { date, time, timezone } = req.body;
  
  // Fallback to server time if client doesn't send time (backward compatibility)
  const today = date || new Date().toISOString().split('T')[0];
  const now = time || new Date().toTimeString().slice(0, 5);
  const tz = timezone || null;
  
  const checkStmt = db.prepare('SELECT * FROM entries WHERE user_id = ? AND date = ? ORDER BY id DESC LIMIT 1');
  const existing = checkStmt.get(req.user.id, today);
  
  if (existing && existing.check_in && !existing.check_out) {
    return res.status(400).json({ error: 'Already clocked in' });
  }
  
  const insertStmt = db.prepare('INSERT INTO entries (user_id, date, check_in, timezone) VALUES (?, ?, ?, ?)');
  const result = insertStmt.run(req.user.id, today, now, tz);
  
  res.json({ success: true, id: result.lastInsertRowid, time: now });
});

app.post('/api/clock-out', requireAuth, (req, res) => {
  // Accept client time and timezone
  const { comment, date, time, timezone } = req.body;
  
  // Fallback to server time if client doesn't send time (backward compatibility)
  const today = date || new Date().toISOString().split('T')[0];
  const now = time || new Date().toTimeString().slice(0, 5);
  
  const stmt = db.prepare('SELECT * FROM entries WHERE user_id = ? AND date = ? ORDER BY id DESC LIMIT 1');
  const entry = stmt.get(req.user.id, today);
  
  if (!entry || !entry.check_in) {
    return res.status(400).json({ error: 'Not clocked in' });
  }
  
  if (entry.check_out) {
    return res.status(400).json({ error: 'Already clocked out' });
  }
  
  // Update entry with check-out time and comment
  // Note: We preserve the timezone from check-in (using COALESCE) to maintain consistency
  // for duration calculations, even if user's timezone changed between check-in and check-out
  const updateStmt = db.prepare('UPDATE entries SET check_out = ?, comment = ?, timezone = COALESCE(timezone, ?) WHERE id = ? AND user_id = ?');
  updateStmt.run(now, comment || null, timezone || null, entry.id, req.user.id);
  
  res.json({ success: true, time: now });
});

// Toggle endpoint for NFC/quick check-in/out
app.post('/api/toggle', requireAuth, (req, res) => {
  try {
    // Accept client time and timezone
    const { date, time, timezone } = req.body;
    
    // Fallback to server time if client doesn't send time (backward compatibility)
    const today = date || new Date().toISOString().split('T')[0];
    const now = time || new Date().toTimeString().slice(0, 5);
    const tz = timezone || null;
    
    // Check current status
    const stmt = db.prepare('SELECT * FROM entries WHERE user_id = ? AND date = ? ORDER BY id DESC LIMIT 1');
    const entry = stmt.get(req.user.id, today);
    
    // If no entry today or already checked out -> check in
    if (!entry || entry.check_out) {
      const insertStmt = db.prepare('INSERT INTO entries (user_id, date, check_in, timezone) VALUES (?, ?, ?, ?)');
      const result = insertStmt.run(req.user.id, today, now, tz);
      
      // Get the last entry with a comment
      let lastComment = null;
      let lastCommentDate = null;
      try {
        const lastCommentStmt = db.prepare('SELECT comment, date FROM entries WHERE user_id = ? AND comment IS NOT NULL AND comment != ? ORDER BY date DESC, id DESC LIMIT 1');
        const lastCommentEntry = lastCommentStmt.get(req.user.id, '');
        if (lastCommentEntry) {
          lastComment = lastCommentEntry.comment;
          lastCommentDate = lastCommentEntry.date;
        }
      } catch (commentErr) {
        console.error('Error fetching last comment:', commentErr);
      }
      
      return res.json({ 
        action: 'check-in', 
        time: now,
        entryId: result.lastInsertRowid,
        lastComment: lastComment,
        lastCommentDate: lastCommentDate
      });
    }
    
    // If checked in but not out -> check out
    if (entry.check_in && !entry.check_out) {
      const updateStmt = db.prepare('UPDATE entries SET check_out = ?, timezone = COALESCE(timezone, ?) WHERE id = ? AND user_id = ?');
      updateStmt.run(now, tz, entry.id, req.user.id);
      
      // Calculate duration
      const [inH, inM] = entry.check_in.split(':').map(Number);
      const [outH, outM] = now.split(':').map(Number);
      const totalMinutes = (outH * 60 + outM) - (inH * 60 + inM);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      const duration = `${hours}h ${minutes}m`;
      
      return res.json({ 
        action: 'check-out', 
        time: now,
        checkIn: entry.check_in,
        checkOut: now,
        duration,
        entryId: entry.id
      });
    }
    
    res.status(400).json({ error: 'Unknown state' });
  } catch (err) {
    console.error('Error in /api/toggle:', err);
    res.status(500).json({ error: 'Toggle failed' });
  }
});

// Update comment for an entry (used by toggle page)
app.put('/api/entries/:id/comment', requireAuth, (req, res) => {
  const { comment } = req.body;
  const { id } = req.params;
  
  const entry = db.prepare('SELECT * FROM entries WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!entry) {
    return res.status(404).json({ error: 'Entry not found' });
  }
  
  const stmt = db.prepare('UPDATE entries SET comment = ? WHERE id = ? AND user_id = ?');
  stmt.run(comment, id, req.user.id);
  
  res.json({ success: true });
});

app.get('/api/entries', requireAuth, (req, res) => {
  const stmt = db.prepare('SELECT * FROM entries WHERE user_id = ? ORDER BY date DESC, id DESC');
  const entries = stmt.all(req.user.id);
  res.json(entries);
});

app.put('/api/entries/:id', requireAuth, (req, res) => {
  const { date, check_in, check_out, comment } = req.body;
  const { id } = req.params;
  
  const entry = db.prepare('SELECT * FROM entries WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!entry) {
    return res.status(404).json({ error: 'Entry not found' });
  }
  
  const stmt = db.prepare('UPDATE entries SET date = ?, check_in = ?, check_out = ?, comment = ? WHERE id = ? AND user_id = ?');
  stmt.run(date || entry.date, check_in, check_out, comment, id, req.user.id);
  
  res.json({ success: true });
});

app.delete('/api/entries/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  
  const entry = db.prepare('SELECT * FROM entries WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!entry) {
    return res.status(404).json({ error: 'Entry not found' });
  }
  
  const stmt = db.prepare('DELETE FROM entries WHERE id = ? AND user_id = ?');
  stmt.run(id, req.user.id);
  res.json({ success: true });
});

// Initialize Excel report module
const excelReport = new ExcelReport(db);

app.get('/api/export', requireAuth, async (req, res) => {
  try {
    const { startMonth, startYear, endMonth, endYear } = req.query;
    
    let startDate, endDate;
    
    if (startMonth && startYear && endMonth && endYear) {
      // Use provided month range
      startDate = `${startYear}-${String(startMonth).padStart(2, '0')}-01`;
      const lastDay = new Date(parseInt(endYear), parseInt(endMonth), 0).getDate();
      endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-${lastDay}`;
    } else {
      // Default: all entries (find min/max dates)
      const rangeStmt = db.prepare('SELECT MIN(date) as minDate, MAX(date) as maxDate FROM entries WHERE user_id = ?');
      const range = rangeStmt.get(req.user.id);
      
      if (!range.minDate || !range.maxDate) {
        return res.status(404).json({ error: 'No entries found' });
      }
      
      startDate = range.minDate;
      endDate = range.maxDate;
    }
    
    const buffer = await excelReport.generateReport(req.user.id, startDate, endDate);
    
    if (!buffer) {
      return res.status(404).json({ error: 'No entries found for the selected period' });
    }
    
    const filename = ExcelReport.generateFilename(req.user.username, startDate, endDate);
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Export failed' });
  }
});

app.get('/api/settings', requireAuth, (req, res) => {
  const stmt = db.prepare('SELECT * FROM settings WHERE user_id = ? AND key LIKE ?');
  const settings = stmt.all(req.user.id, 'reminder_%');
  
  const result = {
    reminderTime: '20:00',
    reminderEnabled: true
  };
  
  settings.forEach(s => {
    if (s.key === 'reminder_time') result.reminderTime = s.value;
    if (s.key === 'reminder_enabled') result.reminderEnabled = s.value === 'true';
  });
  
  res.json(result);
});

app.post('/api/settings', requireAuth, (req, res) => {
  const { reminderTime, reminderEnabled } = req.body;
  
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (user_id, key, value) VALUES (?, ?, ?)');
  stmt.run(req.user.id, 'reminder_time', reminderTime);
  stmt.run(req.user.id, 'reminder_enabled', reminderEnabled.toString());
  
  res.json({ success: true });
});

app.post('/api/subscribe', requireAuth, (req, res) => {
  const subscription = req.body;
  
  try {
    const stmt = db.prepare('INSERT OR REPLACE INTO subscriptions (user_id, endpoint, keys) VALUES (?, ?, ?)');
    stmt.run(req.user.id, subscription.endpoint, JSON.stringify(subscription.keys));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ MONTHLY EMAIL REPORTS ============

// Manual trigger endpoint for sending monthly reports
app.post('/api/admin/send-monthly-reports', requireAuth, async (req, res) => {
  try {
    const result = await emailReports.sendAllMonthlyReports();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Error sending monthly reports:', err);
    res.status(500).json({ error: err.message });
  }
});

// Send report to a specific user (for testing)
app.post('/api/admin/send-report/:userId', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { year, month } = req.body;
    
    const user = db.prepare('SELECT id, username, email FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const reportYear = year || new Date().getFullYear();
    const reportMonth = month || new Date().getMonth() || 12;
    
    const success = await emailReports.sendReportToUser(user, reportYear, reportMonth);
    res.json({ success, user: user.username, email: user.email });
  } catch (err) {
    console.error('Error sending report:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ PUSH NOTIFICATIONS ============

function checkReminders() {
  const usersStmt = db.prepare(`
    SELECT DISTINCT u.id, s1.value as reminder_time, s2.value as reminder_enabled
    FROM users u
    LEFT JOIN settings s1 ON u.id = s1.user_id AND s1.key = 'reminder_time'
    LEFT JOIN settings s2 ON u.id = s2.user_id AND s2.key = 'reminder_enabled'
    WHERE s2.value = 'true' OR s2.value IS NULL
  `);
  const users = usersStmt.all();
  
  const now = new Date();
  const currentTime = now.toTimeString().slice(0, 5);
  const today = now.toISOString().split('T')[0];
  
  users.forEach(user => {
    const reminderTime = user.reminder_time || '20:00';
    
    if (currentTime !== reminderTime) return;
    
    const entryStmt = db.prepare('SELECT * FROM entries WHERE user_id = ? AND date = ? ORDER BY id DESC LIMIT 1');
    const entry = entryStmt.get(user.id, today);
    
    if (entry && entry.check_in && !entry.check_out) {
      const subsStmt = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?');
      const subscriptions = subsStmt.all(user.id);
      
      subscriptions.forEach(sub => {
        const subscription = {
          endpoint: sub.endpoint,
          keys: JSON.parse(sub.keys)
        };
        
        webpush.sendNotification(subscription, JSON.stringify({
          title: 'Time Tracker Reminder',
          body: 'Did you forget to clock out?',
          icon: '/icon-192.png'
        })).catch(err => {
          console.error('Push notification error:', err);
          if (err.statusCode === 410) {
            const delStmt = db.prepare('DELETE FROM subscriptions WHERE endpoint = ?');
            delStmt.run(sub.endpoint);
          }
        });
      });
    }
  });
}

setInterval(checkReminders, 60000);

// Start the monthly report scheduler
emailReports.startScheduler();

// Development helper: Icon generator
app.get('/generate-icons', (req, res) => {
  res.sendFile(path.join(__dirname, 'icon-generator.html'));
});

app.listen(PORT, () => {
  console.log(`\n🕐 Time Tracker running on http://localhost:${PORT}`);
  console.log(`   GitHub OAuth: ${githubEnabled ? '✅ Enabled' : '❌ Disabled (set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to enable)'}`);
  console.log(`   Monthly Reports: ${emailReports.isEnabled() ? '✅ Enabled (via ' + process.env.SMTP_HOST + ')' : '❌ Disabled (set SMTP_* variables to enable)'}`);
  console.log(`\n⚠  PWA Setup: Visit http://localhost:${PORT}/generate-icons to create icon files`);
});