/**
 * Input/output helpers: reading local files, fetching example data, strict CSV
 * parsing/serialisation and browser downloads.
 *
 * Design rules that this module enforces for the whole toolkit:
 *  - No silent defaults. A missing or unparseable value raises an error that
 *    names the row/column, it never becomes 0.
 *  - CSV is always written WITH a header row, and always read BY header name.
 *    Column order is never used as application logic.
 *  - Filenames are labels for humans. Nothing in this project parses a filename
 *    to decide what a file means.
 */

/** Number of decimal places used when writing metres to CSV/JSON. 1 mm. */
export const DEFAULT_COORDINATE_DECIMALS = 3;

/**
 * Read a File (from an <input type="file">) as UTF-8 text.
 * @param {File} file
 * @returns {Promise<string>}
 */
export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new Error(`Could not read "${file.name}": ${reader.error?.message ?? 'unknown error'}`));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(file, 'utf-8');
  });
}

/**
 * Fetch a text resource relative to the page, with an explicit error message.
 * @param {string} url
 * @returns {Promise<string>}
 */
export async function fetchText(url) {
  let response;
  try {
    response = await fetch(url, { cache: 'no-store' });
  } catch (cause) {
    throw new Error(
      `Network error while loading "${url}". If you opened this page with the ` +
        `file:// protocol, serve the repository over HTTP instead ` +
        `(python3 -m http.server 8000).`,
      { cause }
    );
  }
  if (!response.ok) {
    throw new Error(`Failed to load "${url}": HTTP ${response.status} ${response.statusText}`);
  }
  return response.text();
}

/**
 * Fetch and parse JSON with a message that points at the file on failure.
 * @param {string} url
 * @returns {Promise<unknown>}
 */
export async function fetchJson(url) {
  const text = await fetchText(url);
  return parseJson(text, url);
}

/**
 * JSON.parse with a source label in the error message.
 * @param {string} text
 * @param {string} sourceLabel
 * @returns {unknown}
 */
export function parseJson(text, sourceLabel = 'input') {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new Error(`"${sourceLabel}" is not valid JSON: ${cause.message}`, { cause });
  }
}

/**
 * Parse a number that must be present and finite.
 * @param {unknown} value
 * @param {string} label used in the error message
 * @returns {number}
 */
export function parseStrictNumber(value, label) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} is not a finite number.`);
    return value;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is missing or empty; this toolkit does not substitute a default.`);
  }
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} is not a number: "${value}".`);
  }
  return parsed;
}

/**
 * Parse RFC4180-ish CSV: comma separated, optional double-quoted fields with
 * doubled quotes for escaping, LF or CRLF line endings.
 *
 * Rows are returned as objects keyed by header name. A ragged row is an error,
 * not something to pad with empty strings.
 *
 * @param {string} text
 * @param {string} sourceLabel used in error messages
 * @returns {{headers: string[], rows: Array<Record<string,string>>}}
 */
export function parseCsv(text, sourceLabel = 'CSV') {
  const lines = splitCsvLines(text);
  if (lines.length === 0) {
    throw new Error(`${sourceLabel} is empty.`);
  }

  const headers = splitCsvLine(lines[0].text, sourceLabel, lines[0].number).map((h) => h.trim());
  if (headers.length === 0 || headers.some((h) => h === '')) {
    throw new Error(`${sourceLabel} line ${lines[0].number}: header row contains an empty column name.`);
  }
  const duplicate = firstDuplicate(headers);
  if (duplicate !== null) {
    throw new Error(`${sourceLabel} line ${lines[0].number}: duplicate column name "${duplicate}".`);
  }

  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const fields = splitCsvLine(lines[i].text, sourceLabel, lines[i].number);
    if (fields.length !== headers.length) {
      throw new Error(
        `${sourceLabel} line ${lines[i].number}: expected ${headers.length} columns ` +
          `(${headers.join(', ')}) but found ${fields.length}.`
      );
    }
    const row = {};
    headers.forEach((header, index) => {
      row[header] = fields[index];
    });
    row.__line = lines[i].number;
    rows.push(row);
  }
  return { headers, rows };
}

/**
 * Require that a CSV provides at least the given columns.
 * @param {string[]} headers
 * @param {string[]} required
 * @param {string} sourceLabel
 */
export function requireCsvColumns(headers, required, sourceLabel = 'CSV') {
  const missing = required.filter((name) => !headers.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `${sourceLabel} is missing required column(s): ${missing.join(', ')}. ` +
        `Found: ${headers.join(', ')}.`
    );
  }
}

/**
 * Serialise rows to CSV using an explicit header list.
 * @param {string[]} headers
 * @param {Array<Record<string, string|number>>} rows
 * @returns {string} text ending with a final newline
 */
export function toCsv(headers, rows) {
  if (!Array.isArray(headers) || headers.length === 0) {
    throw new Error('toCsv requires a non-empty header list.');
  }
  const out = [headers.map(escapeCsvField).join(',')];
  for (const row of rows) {
    out.push(headers.map((header) => escapeCsvField(row[header])).join(','));
  }
  return `${out.join('\n')}\n`;
}

/**
 * Format a number for file output with a fixed number of decimals, then strip
 * trailing zeros so that "30.000" becomes "30". Keeps files readable and
 * diff-friendly without losing millimetre resolution.
 * @param {number} value
 * @param {number} decimals
 * @returns {string}
 */
export function formatFixed(value, decimals = DEFAULT_COORDINATE_DECIMALS) {
  if (!Number.isFinite(value)) {
    throw new Error(`Refusing to write a non-finite number to a file: ${value}`);
  }
  const fixed = value.toFixed(decimals);
  const trimmed = fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
  // A tiny negative value rounds to the string "-0"; write plain "0" instead.
  return trimmed === '-0' ? '0' : trimmed;
}

/**
 * Round a number to a fixed number of decimals, returning a number (for JSON).
 * @param {number} value
 * @param {number} decimals
 * @returns {number}
 */
export function roundTo(value, decimals = DEFAULT_COORDINATE_DECIMALS) {
  if (!Number.isFinite(value)) {
    throw new Error(`Refusing to write a non-finite number to a file: ${value}`);
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Trigger a browser download of a text payload.
 * @param {string} filename
 * @param {string} text
 * @param {string} mimeType
 */
export function downloadText(filename, text, mimeType = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick; revoking synchronously can cancel the download in
  // some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Download a JSON document, pretty-printed.
 * @param {string} filename
 * @param {unknown} value
 */
export function downloadJson(filename, value) {
  downloadText(filename, `${JSON.stringify(value, null, 2)}\n`, 'application/json;charset=utf-8');
}

/**
 * Make a string safe to use as a filename component. Purely cosmetic - no part
 * of this toolkit reads meaning back out of a filename.
 * @param {string} value
 * @returns {string}
 */
export function sanitizeFilenamePart(value) {
  const cleaned = String(value).trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned === '' ? 'untitled' : cleaned;
}

// --- internal helpers -------------------------------------------------------

/**
 * Split text into non-empty lines, remembering the original 1-based line number
 * so that parse errors can point at the real file location.
 */
function splitCsvLines(text) {
  const raw = text.split(/\r\n|\n|\r/);
  const lines = [];
  raw.forEach((line, index) => {
    if (line.trim() === '') return; // blank lines are ignored, not an error
    lines.push({ text: line, number: index + 1 });
  });
  return lines;
}

function splitCsvLine(line, sourceLabel, lineNumber) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      if (current.trim() !== '') {
        throw new Error(
          `${sourceLabel} line ${lineNumber}: unexpected quote in the middle of a field.`
        );
      }
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (inQuotes) {
    throw new Error(`${sourceLabel} line ${lineNumber}: unterminated quoted field.`);
  }
  fields.push(current);
  return fields;
}

function escapeCsvField(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function firstDuplicate(values) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}
