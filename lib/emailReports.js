/**
 * Email Reports Module
 * Handles monthly report generation and email sending
 */

const nodemailer = require('nodemailer');
const ExcelReport = require('./excelReport');

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

class EmailReports {
  constructor(db) {
    this.db = db;
    this.transporter = null;
    this.enabled = false;
    this.excelReport = new ExcelReport(db);
    
    this._initializeTransporter();
  }
  
  /**
   * Initialize the email transporter if SMTP is configured
   */
  _initializeTransporter() {
    const { SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_PORT } = process.env;
    
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
      console.log('📧 Email reports disabled (SMTP not configured)');
      return;
    }
    
    const port = parseInt(SMTP_PORT) || 465;
    
    this.transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: port,
      secure: port === 465,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS
      }
    });
    
    // Verify connection on startup
    this.transporter.verify((error) => {
      if (error) {
        console.error('❌ SMTP connection error:', error.message);
        this.enabled = false;
      } else {
        console.log('✅ SMTP server ready to send emails');
        this.enabled = true;
      }
    });
    
    this.enabled = true;
  }
  
  /**
   * Check if email is enabled
   */
  isEnabled() {
    return this.enabled && this.transporter !== null;
  }
  
  /**
   * Send monthly report email to a user
   */
  async sendReportToUser(user, year, month) {
    if (!this.isEnabled()) {
      console.log(`📧 Email not configured, skipping report for user ${user.username}`);
      return { success: false, reason: 'email_not_configured' };
    }
    
    if (!user.email) {
      console.log(`📧 No email address for user ${user.username}, skipping report`);
      return { success: false, reason: 'no_email' };
    }
    
    try {
      const reportBuffer = await this.excelReport.generateMonthlyReport(user.id, year, month);
      
      if (!reportBuffer) {
        console.log(`📧 No entries for user ${user.username} in ${year}-${month}, skipping`);
        return { success: false, reason: 'no_entries' };
      }
      
      const monthName = MONTH_NAMES[month - 1];
      
      await this.transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: user.email,
        subject: `Time Tracking Report - ${monthName} ${year}`,
        html: this._generateEmailHtml(user.username, monthName, year),
        attachments: [
          {
            filename: `time-tracking-${year}-${String(month).padStart(2, '0')}.xlsx`,
            content: reportBuffer,
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          }
        ]
      });
      
      console.log(`📧 Monthly report sent to ${user.email}`);
      return { success: true };
    } catch (err) {
      console.error(`📧 Failed to send report to ${user.email}:`, err.message);
      return { success: false, reason: 'send_failed', error: err.message };
    }
  }
  
  /**
   * Generate HTML email content
   */
  _generateEmailHtml(username, monthName, year) {
    return `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1f2937;">Your Monthly Time Tracking Report</h2>
        <p>Hi ${username},</p>
        <p>Please find attached your time tracking report for <strong>${monthName} ${year}</strong>.</p>
        <p style="color: #6b7280; font-size: 14px; margin-top: 32px;">
          Best regards,<br>
          Time Tracker
        </p>
      </div>
    `;
  }
  
  /**
   * Send monthly reports to all users with activity in the previous month
   */
  async sendAllMonthlyReports() {
    const now = new Date();
    let year = now.getFullYear();
    let month = now.getMonth(); // 0-indexed, so this is already "previous month"
    
    if (month === 0) {
      month = 12;
      year -= 1;
    }
    
    console.log(`📧 Generating monthly reports for ${year}-${String(month).padStart(2, '0')}...`);
    
    const usersWithActivity = this._getUsersWithActivity(year, month);
    console.log(`📧 Found ${usersWithActivity.length} users with activity`);
    
    let sent = 0;
    let skipped = 0;
    const details = [];
    
    for (const user of usersWithActivity) {
      const result = await this.sendReportToUser(user, year, month);
      if (result.success) {
        sent++;
      } else {
        skipped++;
      }
      details.push({ user: user.username, email: user.email, ...result });
    }
    
    console.log(`📧 Monthly reports complete: ${sent} sent, ${skipped} skipped`);
    return { sent, skipped, details };
  }
  
  /**
   * Get all users who have entries in a specific month
   */
  _getUsersWithActivity(year, month) {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = `${year}-${String(month).padStart(2, '0')}-31`;
    
    return this.db.prepare(`
      SELECT DISTINCT u.id, u.username, u.email
      FROM users u
      INNER JOIN entries e ON u.id = e.user_id
      WHERE e.date >= ? AND e.date <= ?
    `).all(startDate, endDate);
  }
  
  /**
   * Get a user by ID
   */
  getUser(userId) {
    return this.db.prepare('SELECT id, username, email FROM users WHERE id = ?').get(userId);
  }
  
  /**
   * Check if monthly reports should be sent (1st of month at 8:00 AM)
   */
  shouldSendMonthlyReports() {
    const now = new Date();
    return now.getDate() === 1 && now.getHours() === 8 && now.getMinutes() === 0;
  }
  
  /**
   * Start the scheduler for automatic monthly reports
   */
  startScheduler() {
    setInterval(() => {
      if (this.shouldSendMonthlyReports()) {
        this.sendAllMonthlyReports();
      }
    }, 60000); // Check every minute
    
    console.log('📧 Monthly report scheduler started');
  }
}

module.exports = EmailReports;
