// csv-fast: a fast drop-in for csv-reader 1.0.0.
// Reads a CSV text once, left to right, and answers {columns, rows, errors}
// exactly as csv-reader 1.0.0 does. The reference builds every field one
// character at a time; this reader instead slices whole fields out of the
// text and only walks characters where the broken-row policy forces it
// (a stray CR, a quoted field, a line break inside quotes).
// Two accelerations: (1) a record with no quote and no stray CR is one
// slice + String.split(',') — the common case; (2) plain fields are scanned
// by an inlined loop with no per-field call. Quoted fields are found with
// indexOf('"'), segments are appended with a two-indexOf line-break test
// that keeps whole slices intact whenever there is nothing to translate.
//
// Policy (csv-reader 1.0.0):
// - U+FEFF at the very start is dropped.
// - A record ends at LF or CRLF; a line left with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (error stray_cr).
// - A field that opens with a quote runs to the next quote that is not
//   doubled ("" inside it is one quote; each CRLF or lone CR inside it is
//   read as LF); what follows its closing quote, up to the next comma or
//   line break, is appended as it stands (error quote_junk, when the field
//   ends); a quote that never closes is a literal character and the text
//   after it is read again as unquoted (error unterminated_quote).
// - A quote inside an unquoted field is a literal character.
// - Fields stay strings, never trimmed or converted.
// - columns is the first record when header is true, else null; rows holds
//   the records after it, each padded with "" (short_row, with fields: its
//   count) or cut (long_row, with extra: the cut fields) to the first
//   record's width.
// - Each error is {code, line, row}, in the order met; line the 1-based
//   line its record starts on, row its record's index in rows (null for
//   the header).
const COMMA = 44, LF = 10, CR = 13, QUOTE = 34, BOM = 0xfeff;
const AT_COMMA = 0, AT_BREAK = 1, AT_END = 2;
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const n = text.length;
  let pos = text.charCodeAt(0) === BOM ? 1 : 0;
  let line = 1;
  let recordLine = 1;
  let recordRow = null;
  let uValue = '', uEnded = AT_END, uAdded = 0;
  function appendSeg(value, a, b) {
    const ni = text.indexOf('\n', a);
    const ri = text.indexOf('\r', a);
    if ((ni === -1 || ni >= b) && (ri === -1 || ri >= b)) return value + text.slice(a, b);
    let out = value, start = a, i = a;
    while (i < b) {
      const ch = text.charCodeAt(i);
      if (ch === CR) { out += text.slice(start, i) + '\n'; line += 1; i += text.charCodeAt(i + 1) === LF ? 2 : 1; start = i; }
      else if (ch === LF) { out += text.slice(start, i) + '\n'; line += 1; i += 1; start = i; }
      else i += 1;
    }
    return out + text.slice(start, b);
  }
  function scanUnquoted(startValue) {
    let value = startValue, added = 0, seg = pos;
    for (;;) {
      let i = pos, ch = 0;
      while (i < n) { ch = text.charCodeAt(i); if (ch === COMMA || ch === LF || ch === CR) break; i += 1; }
      if (i >= n) { value += text.slice(seg); added += n - seg; pos = n; uValue = value; uEnded = AT_END; uAdded = added; return; }
      if (ch === COMMA) { value += text.slice(seg, i); added += i - seg; pos = i + 1; uValue = value; uEnded = AT_COMMA; uAdded = added; return; }
      if (ch === LF) { value += text.slice(seg, i); added += i - seg; pos = i + 1; line += 1; uValue = value; uEnded = AT_BREAK; uAdded = added; return; }
      if (text.charCodeAt(i + 1) === LF) { value += text.slice(seg, i); added += i - seg; pos = i + 2; line += 1; uValue = value; uEnded = AT_BREAK; uAdded = added; return; }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      value += text.slice(seg, i); added += i - seg; pos = i + 1; seg = pos;
    }
  }
  let qValue = '', qEnded = AT_END;
  function scanQuoted() {
    const open = pos, openLine = line;
    let value = '', scan = pos + 1, seg = scan, closed = false;
    while (true) {
      const q = text.indexOf('"', scan);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === QUOTE) { value = appendSeg(value, seg, q); value += '"'; scan = q + 2; seg = scan; continue; }
      value = appendSeg(value, seg, q); pos = q + 1; closed = true; break;
    }
    if (!closed) {
      pos = open + 1; line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      scanUnquoted('"'); qValue = uValue; qEnded = uEnded; return;
    }
    if (pos >= n) { qValue = value; qEnded = AT_END; return; }
    const d = text.charCodeAt(pos);
    if (d === COMMA) { pos += 1; qValue = value; qEnded = AT_COMMA; return; }
    if (d === LF) { pos += 1; line += 1; qValue = value; qEnded = AT_BREAK; return; }
    if (d === CR && text.charCodeAt(pos + 1) === LF) { pos += 2; line += 1; qValue = value; qEnded = AT_BREAK; return; }
    scanUnquoted(value);
    if (uAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    qValue = uValue; qEnded = uEnded;
  }
  while (pos < n) {
    let c = text.charCodeAt(pos);
    while (c === LF || (c === CR && text.charCodeAt(pos + 1) === LF)) {
      pos += c === LF ? 1 : 2; line += 1;
      if (pos >= n) break;
      c = text.charCodeAt(pos);
    }
    if (pos >= n) break;
    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    // Fast path: a record with no quote and no stray CR is one slice + split.
    const lineEnd = text.indexOf('\n', pos);
    const end = lineEnd === -1 ? n : lineEnd;
    let contentEnd = end;
    if (lineEnd !== -1 && lineEnd > pos && text.charCodeAt(lineEnd - 1) === CR) contentEnd = lineEnd - 1;
    const qi = text.indexOf('"', pos);
    if (qi === -1 || qi >= end) {
      const ri = text.indexOf('\r', pos);
      if (ri === -1 || ri >= contentEnd) {
        const fields = text.slice(pos, contentEnd).split(',');
        line += 1;
        pos = lineEnd === -1 ? n : lineEnd + 1;
        if (width < 0) width = fields.length;
        if (header && columns === null) { columns = fields; continue; }
        if (fields.length < width) {
          errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
          while (fields.length < width) fields.push('');
        } else if (fields.length > width) {
          errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
        }
        rows.push(fields);
        continue;
      }
    }
    const fields = [];
    let quoted = false, ended;
    for (;;) {
      if (text.charCodeAt(pos) === QUOTE) { quoted = true; scanQuoted(); fields.push(qValue); ended = qEnded; }
      else {
        quoted = false;
        // Inlined unquoted scan (plain field): direct slice, no function call.
        let value = '', seg = pos, e = AT_END;
        for (;;) {
          let i = pos, ch = 0;
          while (i < n) { ch = text.charCodeAt(i); if (ch === COMMA || ch === LF || ch === CR) break; i += 1; }
          if (i >= n) { value = value === '' ? text.slice(seg) : value + text.slice(seg); pos = n; e = AT_END; break; }
          if (ch === COMMA) { value = value === '' ? text.slice(seg, i) : value + text.slice(seg, i); pos = i + 1; e = AT_COMMA; break; }
          if (ch === LF) { value = value === '' ? text.slice(seg, i) : value + text.slice(seg, i); pos = i + 1; line += 1; e = AT_BREAK; break; }
          if (text.charCodeAt(i + 1) === LF) { value = value === '' ? text.slice(seg, i) : value + text.slice(seg, i); pos = i + 2; line += 1; e = AT_BREAK; break; }
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          value = value === '' ? text.slice(seg, i) : value + text.slice(seg, i); pos = i + 1; seg = pos;
        }
        fields.push(value);
        ended = e;
      }
      if (ended !== AT_COMMA) break;
    }
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    if (width < 0) width = fields.length;
    if (header && columns === null) { columns = fields; continue; }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
