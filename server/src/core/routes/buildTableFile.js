const localeCopy = require('../../locales/zh-CN/generated/core/routes/buildTableFile');
const express = require('express');
const router = express.Router();
const { LIMITS, buildWorkbookBuffer } = require('../../utils/excelFile');

/**
 * Build an Excel or CSV file from the same headers + rows contract.
 * Input:  { format: 'xlsx' | 'csv', headers: [{key,label}], rows: [{}], sheetName }
 * Output: { status: 'success', fileBase64, extension, mimeType }
 */
router.post('/buildTableFile', async (req, res) => {
  try {
    if (!req.admin) {
      return res.status(403).json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    }

    const headers = req.body.headers || [];
    const rows = req.body.rows || [];
    const sheetName = req.body.sheetName || 'Sheet1';
    const requestedFormat = String(req.body.format || 'xlsx').toLowerCase();
    const format = requestedFormat === 'excel' ? 'xlsx' : requestedFormat;

    if (!headers.length) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_d864121fe4 });
    }
    if (format !== 'xlsx' && format !== 'csv') {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_96b9b6d201 });
    }

    const headerLabels = headers.map(h =>
      typeof h === 'object' ? (h.label || h.key || '') : String(h)
    );
    const headerKeys = headers.map(h =>
      typeof h === 'object' ? (h.key || h.label || '') : String(h)
    );

    const dataRows = rows.map(row =>
      headerKeys.map(key => {
        const value = row[key];
        return value == null ? '' : value;
      })
    );

    const sheetData = [headerLabels, ...dataRows];
    const buffer = format === 'csv'
      ? buildCsvBuffer(sheetData)
      : await buildWorkbookBuffer(sheetName, sheetData);
    const base64 = buffer.toString('base64');

    res.json({
      status: 'success',
      fileBase64: base64,
      extension: format,
      mimeType: format === 'csv'
        ? 'text/csv; charset=utf-8'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
  } catch (e) {
    if (req.logger) req.logger.warn('Table file build rejected', { code: e.code || 'build_failed', error: e.message });
    res.json({ status: 'error', message: e.code === 'invalid_workbook' ? e.message : localeCopy.copy_8e15f97927 });
  }
});

function buildCsvBuffer(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    const error = new Error(localeCopy.copy_3e4128b733);
    error.code = 'invalid_workbook';
    throw error;
  }
  if (rows.length > LIMITS.maxRows) {
    const error = new Error(localeCopy.copy_d16a0093f5);
    error.code = 'invalid_workbook';
    throw error;
  }
  let totalCells = 0;
  const csvLines = rows.map((row) => row.map((value) => {
    let text = String(value == null ? '' : value);
    totalCells += 1;
    if (row.length > LIMITS.maxColumns || totalCells > LIMITS.maxCells || text.length > LIMITS.maxCellLength) {
      const error = new Error(localeCopy.copy_55061c833a);
      error.code = 'invalid_workbook';
      throw error;
    }
    if (/^[=+\-@]/.test(text)) text = "'" + text;
    if (/[",\r\n]/.test(text)) text = '"' + text.replace(/"/g, '""') + '"';
    return text;
  }).join(','));
  return Buffer.from('\uFEFF' + csvLines.join('\r\n'), 'utf8');
}

module.exports = router;
module.exports.buildCsvBuffer = buildCsvBuffer;
