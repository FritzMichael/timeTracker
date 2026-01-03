require('dotenv').config();

const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GitHubStrategy = require('passport-github2').Strategy;
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const ExcelJS = require('exceljs');
const webpush = require('web-push');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
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
  const today = new Date().toISOString().split('T')[0];
  const stmt = db.prepare('SELECT * FROM entries WHERE user_id = ? AND date = ? ORDER BY id DESC LIMIT 1');
  const entry = stmt.get(req.user.id, today);
  
  const status = {
    hasEntry: !!entry,
    checkedIn: entry?.check_in && !entry?.check_out,
    checkedOut: entry?.check_out,
    entry: entry || null
  };
  
  res.json(status);
});

app.post('/api/clock-in', requireAuth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toTimeString().slice(0, 5);
  
  const checkStmt = db.prepare('SELECT * FROM entries WHERE user_id = ? AND date = ? ORDER BY id DESC LIMIT 1');
  const existing = checkStmt.get(req.user.id, today);
  
  if (existing && existing.check_in && !existing.check_out) {
    return res.status(400).json({ error: 'Already clocked in' });
  }
  
  const insertStmt = db.prepare('INSERT INTO entries (user_id, date, check_in) VALUES (?, ?, ?)');
  const result = insertStmt.run(req.user.id, today, now);
  
  res.json({ success: true, id: result.lastInsertRowid, time: now });
});

app.post('/api/clock-out', requireAuth, (req, res) => {
  const { comment } = req.body;
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toTimeString().slice(0, 5);
  
  const stmt = db.prepare('SELECT * FROM entries WHERE user_id = ? AND date = ? ORDER BY id DESC LIMIT 1');
  const entry = stmt.get(req.user.id, today);
  
  if (!entry || !entry.check_in) {
    return res.status(400).json({ error: 'Not clocked in' });
  }
  
  if (entry.check_out) {
    return res.status(400).json({ error: 'Already clocked out' });
  }
  
  const updateStmt = db.prepare('UPDATE entries SET check_out = ?, comment = ? WHERE id = ? AND user_id = ?');
  updateStmt.run(now, comment || null, entry.id, req.user.id);
  
  res.json({ success: true, time: now });
});

// Toggle endpoint for NFC/quick check-in/out
app.post('/api/toggle', requireAuth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toTimeString().slice(0, 5);
  
  // Check current status
  const stmt = db.prepare('SELECT * FROM entries WHERE user_id = ? AND date = ? ORDER BY id DESC LIMIT 1');
  const entry = stmt.get(req.user.id, today);
  
  // If no entry today or already checked out -> check in
  if (!entry || entry.check_out) {
    const insertStmt = db.prepare('INSERT INTO entries (user_id, date, check_in) VALUES (?, ?, ?)');
    const result = insertStmt.run(req.user.id, today, now);
    
    return res.json({ 
      action: 'check-in', 
      time: now,
      entryId: result.lastInsertRowid
    });
  }
  
  // If checked in but not out -> check out
  if (entry.check_in && !entry.check_out) {
    const updateStmt = db.prepare('UPDATE entries SET check_out = ? WHERE id = ? AND user_id = ?');
    updateStmt.run(now, entry.id, req.user.id);
    
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

app.get('/api/export', requireAuth, async (req, res) => {
  const stmt = db.prepare('SELECT * FROM entries WHERE user_id = ? ORDER BY date ASC');
  const entries = stmt.all(req.user.id);
  
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Time Tracking');
  
  worksheet.columns = [
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Check In', key: 'check_in', width: 12 },
    { header: 'Check Out', key: 'check_out', width: 12 },
    { header: 'Total Hours', key: 'total', width: 12 },
    { header: 'Comment', key: 'comment', width: 40 }
  ];
  
  entries.forEach(entry => {
    let total = '';
    if (entry.check_in && entry.check_out) {
      const [inH, inM] = entry.check_in.split(':').map(Number);
      const [outH, outM] = entry.check_out.split(':').map(Number);
      const totalMinutes = (outH * 60 + outM) - (inH * 60 + inM);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      total = `${hours}:${minutes.toString().padStart(2, '0')}`;
    }
    
    worksheet.addRow({
      date: entry.date,
      check_in: entry.check_in || '',
      check_out: entry.check_out || '',
      total: total,
      comment: entry.comment || ''
    });
  });
  
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=time-tracking-${req.user.username}.xlsx`);
  
  await workbook.xlsx.write(res);
  res.end();
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

app.listen(PORT, () => {
  console.log(`Time Tracker running on http://localhost:${PORT}`);
  console.log(`GitHub OAuth: ${githubEnabled ? 'Enabled' : 'Disabled (set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to enable)'}`);
});