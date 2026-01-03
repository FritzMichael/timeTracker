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
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

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

// Email configuration (optional - only if SMTP/Resend is configured)
const emailEnabled = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS;
let emailTransporter = null;

if (emailEnabled) {
  emailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 465,
    secure: process.env.SMTP_PORT === '465' || parseInt(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  
  // Verify connection on startup
  emailTransporter.verify((error) => {
    if (error) {
      console.error('❌ SMTP connection error:', error.message);
    } else {
      console.log('✅ SMTP server ready to send emails');
    }
  });
}

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
    const today = new Date().toISOString().split('T')[0];
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
  try {
    const today = new Date().toISOString().split('T')[0];
    const now = new Date().toTimeString().slice(0, 5);
    
    // Check current status
    const stmt = db.prepare('SELECT * FROM entries WHERE user_id = ? AND date = ? ORDER BY id DESC LIMIT 1');
    const entry = stmt.get(req.user.id, today);
    
    // If no entry today or already checked out -> check in
    if (!entry || entry.check_out) {
      const insertStmt = db.prepare('INSERT INTO entries (user_id, date, check_in) VALUES (?, ?, ?)');
      const result = insertStmt.run(req.user.id, today, now);
      
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

// ============ MONTHLY EMAIL REPORTS ============

// Generate Excel report for a specific user and month
async function generateMonthlyReport(userId, year, month) {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = `${year}-${String(month).padStart(2, '0')}-31`;
  
  const stmt = db.prepare(`
    SELECT * FROM entries 
    WHERE user_id = ? AND date >= ? AND date <= ? 
    ORDER BY date ASC
  `);
  const entries = stmt.all(userId, startDate, endDate);
  
  if (entries.length === 0) {
    return null; // No entries for this month
  }
  
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Time Tracking');
  
  // Add title
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                      'July', 'August', 'September', 'October', 'November', 'December'];
  worksheet.mergeCells('A1:E1');
  worksheet.getCell('A1').value = `Time Tracking Report - ${monthNames[month - 1]} ${year}`;
  worksheet.getCell('A1').font = { bold: true, size: 14 };
  worksheet.addRow([]);
  
  // Add headers
  const headerRow = worksheet.addRow(['Date', 'Check In', 'Check Out', 'Total Hours', 'Comment']);
  headerRow.font = { bold: true };
  
  worksheet.columns = [
    { key: 'date', width: 12 },
    { key: 'check_in', width: 12 },
    { key: 'check_out', width: 12 },
    { key: 'total', width: 12 },
    { key: 'comment', width: 40 }
  ];
  
  let totalMinutesMonth = 0;
  
  entries.forEach(entry => {
    let total = '';
    let minutes = 0;
    if (entry.check_in && entry.check_out) {
      const [inH, inM] = entry.check_in.split(':').map(Number);
      const [outH, outM] = entry.check_out.split(':').map(Number);
      minutes = (outH * 60 + outM) - (inH * 60 + inM);
      totalMinutesMonth += minutes;
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      total = `${hours}:${mins.toString().padStart(2, '0')}`;
    }
    
    worksheet.addRow([
      entry.date,
      entry.check_in || '',
      entry.check_out || '',
      total,
      entry.comment || ''
    ]);
  });
  
  // Add summary row
  worksheet.addRow([]);
  const totalHours = Math.floor(totalMinutesMonth / 60);
  const totalMins = totalMinutesMonth % 60;
  const summaryRow = worksheet.addRow(['TOTAL', '', '', `${totalHours}:${totalMins.toString().padStart(2, '0')}`, '']);
  summaryRow.font = { bold: true };
  
  // Generate buffer
  const buffer = await workbook.xlsx.writeBuffer();
  return buffer;
}

// Send monthly report email to a user
async function sendMonthlyReportEmail(user, year, month) {
  if (!emailEnabled || !emailTransporter) {
    console.log(`📧 Email not configured, skipping report for user ${user.username}`);
    return false;
  }
  
  if (!user.email) {
    console.log(`📧 No email address for user ${user.username}, skipping report`);
    return false;
  }
  
  try {
    const reportBuffer = await generateMonthlyReport(user.id, year, month);
    
    if (!reportBuffer) {
      console.log(`📧 No entries for user ${user.username} in ${year}-${month}, skipping`);
      return false;
    }
    
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                        'July', 'August', 'September', 'October', 'November', 'December'];
    const monthName = monthNames[month - 1];
    
    await emailTransporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: user.email,
      subject: `Time Tracking Report - ${monthName} ${year}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1f2937;">Your Monthly Time Tracking Report</h2>
          <p>Hi ${user.username},</p>
          <p>Please find attached your time tracking report for <strong>${monthName} ${year}</strong>.</p>
          <p style="color: #6b7280; font-size: 14px; margin-top: 32px;">
            Best regards,<br>
            Time Tracker
          </p>
        </div>
      `,
      attachments: [
        {
          filename: `time-tracking-${year}-${String(month).padStart(2, '0')}.xlsx`,
          content: reportBuffer,
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        }
      ]
    });
    
    console.log(`📧 Monthly report sent to ${user.email}`);
    return true;
  } catch (err) {
    console.error(`📧 Failed to send report to ${user.email}:`, err.message);
    return false;
  }
}

// Send monthly reports to all active users
async function sendAllMonthlyReports() {
  const now = new Date();
  // Get previous month
  let year = now.getFullYear();
  let month = now.getMonth(); // 0-indexed, so this is already "previous month"
  
  if (month === 0) {
    month = 12;
    year -= 1;
  }
  
  console.log(`📧 Generating monthly reports for ${year}-${String(month).padStart(2, '0')}...`);
  
  // Find all users who have entries in the previous month
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = `${year}-${String(month).padStart(2, '0')}-31`;
  
  const usersWithActivity = db.prepare(`
    SELECT DISTINCT u.id, u.username, u.email
    FROM users u
    INNER JOIN entries e ON u.id = e.user_id
    WHERE e.date >= ? AND e.date <= ?
  `).all(startDate, endDate);
  
  console.log(`📧 Found ${usersWithActivity.length} users with activity`);
  
  let sent = 0;
  let skipped = 0;
  
  for (const user of usersWithActivity) {
    const success = await sendMonthlyReportEmail(user, year, month);
    if (success) {
      sent++;
    } else {
      skipped++;
    }
  }
  
  console.log(`📧 Monthly reports complete: ${sent} sent, ${skipped} skipped`);
  return { sent, skipped };
}

// Check if it's time to send monthly reports (1st of month at 8:00 AM)
function checkMonthlyReports() {
  const now = new Date();
  const day = now.getDate();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  
  // Run on the 1st of each month at 08:00
  if (day === 1 && hours === 8 && minutes === 0) {
    sendAllMonthlyReports();
  }
}

// Manual trigger endpoint for sending monthly reports
app.post('/api/admin/send-monthly-reports', requireAuth, async (req, res) => {
  try {
    const result = await sendAllMonthlyReports();
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
    
    const success = await sendMonthlyReportEmail(user, reportYear, reportMonth);
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

// Check for monthly reports every minute
setInterval(checkMonthlyReports, 60000);

// Development helper: Icon generator
app.get('/generate-icons', (req, res) => {
  res.sendFile(path.join(__dirname, 'icon-generator.html'));
});

app.listen(PORT, () => {
  console.log(`\n🕐 Time Tracker running on http://localhost:${PORT}`);
  console.log(`   GitHub OAuth: ${githubEnabled ? '✅ Enabled' : '❌ Disabled (set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to enable)'}`);
  console.log(`   Monthly Reports: ${emailEnabled ? '✅ Enabled (via ' + process.env.SMTP_HOST + ')' : '❌ Disabled (set SMTP_* variables to enable)'}`);
  console.log(`\n⚠  PWA Setup: Visit http://localhost:${PORT}/generate-icons to create icon files`);
});