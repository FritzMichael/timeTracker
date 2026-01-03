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
   * Each month gets its own sheet with all days of the month
   * @param {number} userId - The user ID
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @param {object} options - Optional settings
   * @returns {Promise<Buffer>} Excel file buffer
   */
  async generateReport(userId, startDate, endDate, options = {}) {
    const stmt = this.db.prepare(`
      SELECT * FROM entries 
      WHERE user_id = ? AND date >= ? AND date <= ? 
      ORDER BY date ASC
    `);
    const entries = stmt.all(userId, startDate, endDate);

    const workbook = new ExcelJS.Workbook();
    
    // Get all months in the date range
    const months = this._getMonthsInRange(startDate, endDate);
    
    // Create entries map for quick lookup
    const entriesMap = new Map();
    entries.forEach(entry => {
      entriesMap.set(entry.date, entry);
    });

    // Create a sheet for each month
    for (const monthInfo of months) {
      await this._createMonthSheet(workbook, monthInfo, entriesMap);
    }

    // If no sheets were created (no months in range), create empty workbook
    if (workbook.worksheets.length === 0) {
      const worksheet = workbook.addWorksheet('No Data');
      worksheet.addRow(['No data available for the selected period']);
    }

    // Generate buffer
    const buffer = await workbook.xlsx.writeBuffer();
    return buffer;
  }

  /**
   * Create a worksheet for a specific month
   * @param {ExcelJS.Workbook} workbook - The workbook
   * @param {object} monthInfo - Month information {year, month, monthName}
   * @param {Map} entriesMap - Map of date -> entry data
   */
  async _createMonthSheet(workbook, monthInfo, entriesMap) {
    const { year, month, monthName } = monthInfo;
    const worksheet = workbook.addWorksheet(`${monthName} ${year}`);

    // Add title
    worksheet.mergeCells('A1:F1');
    worksheet.getCell('A1').value = `Time Tracking Report - ${monthName} ${year}`;
    worksheet.getCell('A1').font = { bold: true, size: 14 };
    worksheet.addRow([]);

    // Add headers
    const headerRow = worksheet.addRow(['Date', 'Weekday', 'Check In', 'Check Out', 'Total Hours', 'Comment']);
    headerRow.font = { bold: true };

    // Set column widths
    worksheet.columns = [
      { key: 'date', width: 12 },
      { key: 'weekday', width: 12 },
      { key: 'check_in', width: 12 },
      { key: 'check_out', width: 12 },
      { key: 'total', width: 12 },
      { key: 'comment', width: 40 }
    ];

    let totalMinutesMonth = 0;
    const daysInMonth = new Date(year, month, 0).getDate();
    
    // Add a row for each day of the month
    for (let day = 1; day <= daysInMonth; day++) {
      const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const dateObj = new Date(year, month - 1, day);
      const weekday = this._getWeekdayName(dateObj.getDay());
      const isWeekend = dateObj.getDay() === 0 || dateObj.getDay() === 6; // Sunday = 0, Saturday = 6
      
      const entry = entriesMap.get(date);
      
      let checkIn = '';
      let checkOut = '';
      let total = '';
      let comment = '';
      let minutes = 0;

      if (entry) {
        checkIn = entry.check_in || '';
        checkOut = entry.check_out || '';
        comment = entry.comment || '';
        
        if (entry.check_in && entry.check_out) {
          const [inH, inM] = entry.check_in.split(':').map(Number);
          const [outH, outM] = entry.check_out.split(':').map(Number);
          minutes = (outH * 60 + outM) - (inH * 60 + inM);
          totalMinutesMonth += minutes;
          const hours = Math.floor(minutes / 60);
          const mins = minutes % 60;
          total = `${hours}:${mins.toString().padStart(2, '0')}`;
        }
      } else if (isWeekend) {
        // For weekends without data, show "---"
        checkIn = '---';
        checkOut = '---';
      }

      worksheet.addRow([date, weekday, checkIn, checkOut, total, comment]);
    }

    // Add summary row
    worksheet.addRow([]);
    const totalHours = Math.floor(totalMinutesMonth / 60);
    const totalMins = totalMinutesMonth % 60;
    const summaryRow = worksheet.addRow(['TOTAL', '', '', '', `${totalHours}:${totalMins.toString().padStart(2, '0')}`, '']);
    summaryRow.font = { bold: true };
  }

  /**
   * Get weekday name from day number
   * @param {number} dayNum - Day number (0 = Sunday, 1 = Monday, etc.)
   * @returns {string} Weekday name
   */
  _getWeekdayName(dayNum) {
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return weekdays[dayNum];
  }

  /**
   * Get all months within a date range
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @returns {Array} Array of month objects {year, month, monthName}
   */
  _getMonthsInRange(startDate, endDate) {
    const months = [];
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                        'July', 'August', 'September', 'October', 'November', 'December'];
    
    const start = new Date(startDate + 'T00:00:00');
    const end = new Date(endDate + 'T23:59:59');
    
    let current = new Date(start.getFullYear(), start.getMonth(), 1);
    
    while (current <= end) {
      months.push({
        year: current.getFullYear(),
        month: current.getMonth() + 1,
        monthName: monthNames[current.getMonth()]
      });
      
      // Move to next month
      current.setMonth(current.getMonth() + 1);
    }
    
    return months;
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

    return this.generateReport(userId, startDate, endDate);
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

module.exports = ExcelReport;
