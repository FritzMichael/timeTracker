/**
 * Excel Report Generation Module
 * Unified Excel report generation for time tracking data
 */

const ExcelJS = require('exceljs');

class ExcelReport {
  constructor(db) {
    this.db = db;
  }

  /**
   * Generate an Excel report for a user within a date range
   * @param {number} userId - The user ID
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @param {object} options - Optional settings
   * @returns {Promise<Buffer>} Excel file buffer
   */
  async generateReport(userId, startDate, endDate, options = {}) {
    const { includeTitle = true, title = null } = options;

    const stmt = this.db.prepare(`
      SELECT * FROM entries 
      WHERE user_id = ? AND date >= ? AND date <= ? 
      ORDER BY date ASC
    `);
    const entries = stmt.all(userId, startDate, endDate);

    if (entries.length === 0) {
      return null; // No entries for this period
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Time Tracking');

    // Add title if requested
    if (includeTitle) {
      const reportTitle = title || this._generateTitle(startDate, endDate);
      worksheet.mergeCells('A1:E1');
      worksheet.getCell('A1').value = reportTitle;
      worksheet.getCell('A1').font = { bold: true, size: 14 };
      worksheet.addRow([]);
    }

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

    let totalMinutesAll = 0;

    entries.forEach(entry => {
      let total = '';
      let minutes = 0;
      if (entry.check_in && entry.check_out) {
        const [inH, inM] = entry.check_in.split(':').map(Number);
        const [outH, outM] = entry.check_out.split(':').map(Number);
        minutes = (outH * 60 + outM) - (inH * 60 + inM);
        totalMinutesAll += minutes;
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
    const totalHours = Math.floor(totalMinutesAll / 60);
    const totalMins = totalMinutesAll % 60;
    const summaryRow = worksheet.addRow(['TOTAL', '', '', `${totalHours}:${totalMins.toString().padStart(2, '0')}`, '']);
    summaryRow.font = { bold: true };

    // Generate buffer
    const buffer = await workbook.xlsx.writeBuffer();
    return buffer;
  }

  /**
   * Generate report for a specific month
   * @param {number} userId - The user ID
   * @param {number} year - Year (e.g., 2026)
   * @param {number} month - Month (1-12)
   * @returns {Promise<Buffer>} Excel file buffer
   */
  async generateMonthlyReport(userId, year, month) {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    // Get last day of month
    const lastDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;

    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                        'July', 'August', 'September', 'October', 'November', 'December'];
    const title = `Time Tracking Report - ${monthNames[month - 1]} ${year}`;

    return this.generateReport(userId, startDate, endDate, { title });
  }

  /**
   * Generate report for a range of months
   * @param {number} userId - The user ID
   * @param {number} startYear - Start year
   * @param {number} startMonth - Start month (1-12)
   * @param {number} endYear - End year
   * @param {number} endMonth - End month (1-12)
   * @returns {Promise<Buffer>} Excel file buffer
   */
  async generateMonthRangeReport(userId, startYear, startMonth, endYear, endMonth) {
    const startDate = `${startYear}-${String(startMonth).padStart(2, '0')}-01`;
    const lastDay = new Date(endYear, endMonth, 0).getDate();
    const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-${lastDay}`;

    return this.generateReport(userId, startDate, endDate);
  }

  /**
   * Generate a title based on the date range
   */
  _generateTitle(startDate, endDate) {
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                        'July', 'August', 'September', 'October', 'November', 'December'];
    
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    const startMonth = monthNames[start.getMonth()];
    const startYear = start.getFullYear();
    const endMonth = monthNames[end.getMonth()];
    const endYear = end.getFullYear();

    if (startYear === endYear && start.getMonth() === end.getMonth()) {
      return `Time Tracking Report - ${startMonth} ${startYear}`;
    } else if (startYear === endYear) {
      return `Time Tracking Report - ${startMonth} to ${endMonth} ${startYear}`;
    } else {
      return `Time Tracking Report - ${startMonth} ${startYear} to ${endMonth} ${endYear}`;
    }
  }

  /**
   * Generate filename based on date range
   */
  static generateFilename(username, startDate, endDate) {
    const start = startDate.substring(0, 7); // YYYY-MM
    const end = endDate.substring(0, 7);
    
    if (start === end) {
      return `time-tracking-${username}-${start}.xlsx`;
    }
    return `time-tracking-${username}-${start}-to-${end}.xlsx`;
  }
}

module.exports = ExcelReport;
