import { toast } from '../ui/overlay.js';

/* ============================================================
   XLSX — read and write .xlsx with no libraries and no CDN.
   An .xlsx is a ZIP of XML. We read the ZIP central directory
   and inflate with the browser's own DecompressionStream, then
   parse the sheet XML. Writing goes the other way, using STORED
   (uncompressed) entries so no compressor is needed.
   ============================================================ */

/* -------------------------------- ZIP read -------------------------------- */
export async function unzip(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const u8 = new Uint8Array(arrayBuffer);

  /* end-of-central-directory: scan backwards for the signature */
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file (no ZIP directory found).');

  const count = dv.getUint16(eocd + 10, true);
  let ptr = dv.getUint32(eocd + 16, true);
  const out = {};
  const dec = new TextDecoder();

  for (let n = 0; n < count; n++) {
    if (dv.getUint32(ptr, true) !== 0x02014b50) break;
    const method = dv.getUint16(ptr + 10, true);
    const compSize = dv.getUint32(ptr + 20, true);
    const fnLen = dv.getUint16(ptr + 28, true);
    const exLen = dv.getUint16(ptr + 30, true);
    const cmLen = dv.getUint16(ptr + 32, true);
    const local = dv.getUint32(ptr + 42, true);
    const name = dec.decode(u8.subarray(ptr + 46, ptr + 46 + fnLen));
    ptr += 46 + fnLen + exLen + cmLen;

    const lfnLen = dv.getUint16(local + 26, true);
    const lexLen = dv.getUint16(local + 28, true);
    const start = local + 30 + lfnLen + lexLen;
    const raw = u8.subarray(start, start + compSize);

    if (method === 0) out[name] = dec.decode(raw);
    else if (method === 8) out[name] = dec.decode(await inflateRaw(raw));
    /* any other method is skipped — Excel only ever writes 0 or 8 */
  }
  return out;
}

export async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined')
    throw new Error('This browser cannot unzip .xlsx files. Please save the sheet as CSV and import that instead.');
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ------------------------------ sheet parsing ------------------------------ */
export const colIndex = (ref) => {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
};

export const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
export const serialToDate = (v) => new Date(EXCEL_EPOCH + Math.round(v * 86400000));
export const DATE_FMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

export function parseStyles(xml) {
  if (!xml) return new Set();
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const dateIds = new Set(DATE_FMT_IDS);
  doc.querySelectorAll('numFmt').forEach((f) => {
    const code = f.getAttribute('formatCode') || '';
    if (/[ymdhs]/i.test(code) && !/(\[|General)/i.test(code.slice(0, 2))) dateIds.add(+f.getAttribute('numFmtId'));
  });
  const xfs = doc.querySelector('cellXfs');
  const isDate = new Set();
  if (xfs) Array.from(xfs.children).forEach((xf, i) => {
    if (dateIds.has(+xf.getAttribute('numFmtId'))) isDate.add(i);
  });
  return isDate;
}

/* returns { sheets: [{name, rows}] } — rows are arrays of primitives */
export async function readXlsx(file) {
  const files = await unzip(await file.arrayBuffer());
  const parser = new DOMParser();

  const shared = [];
  if (files['xl/sharedStrings.xml']) {
    const doc = parser.parseFromString(files['xl/sharedStrings.xml'], 'application/xml');
    doc.querySelectorAll('si').forEach((si) => {
      shared.push(Array.from(si.querySelectorAll('t')).map((t) => t.textContent).join(''));
    });
  }
  const dateStyles = parseStyles(files['xl/styles.xml']);

  /* sheet order + names from the workbook, paths from its rels */
  const rels = {};
  if (files['xl/_rels/workbook.xml.rels']) {
    parser.parseFromString(files['xl/_rels/workbook.xml.rels'], 'application/xml')
      .querySelectorAll('Relationship').forEach((r) => { rels[r.getAttribute('Id')] = r.getAttribute('Target'); });
  }
  const sheetDefs = [];
  if (files['xl/workbook.xml']) {
    parser.parseFromString(files['xl/workbook.xml'], 'application/xml')
      .querySelectorAll('sheets > sheet').forEach((s) => {
        const rid = s.getAttribute('r:id') || s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
        let target = rels[rid] || '';
        if (target && !target.startsWith('/')) target = 'xl/' + target.replace(/^\.?\//, '');
        sheetDefs.push({ name: s.getAttribute('name'), path: target.replace(/^\//, '') });
      });
  }
  if (!sheetDefs.length) sheetDefs.push({ name: 'Sheet1', path: 'xl/worksheets/sheet1.xml' });

  const sheets = [];
  sheetDefs.forEach((def) => {
    const xml = files[def.path] || files[def.path.replace('xl/', 'xl/worksheets/')];
    if (!xml) return;
    const doc = parser.parseFromString(xml, 'application/xml');
    const rows = [];
    doc.querySelectorAll('sheetData > row').forEach((r) => {
      const rowIdx = +r.getAttribute('r') - 1;
      const arr = rows[rowIdx] || (rows[rowIdx] = []);
      r.querySelectorAll('c').forEach((c) => {
        const ref = c.getAttribute('r') || '';
        const ci = ref ? colIndex(ref) : arr.length;
        const t = c.getAttribute('t');
        let val = null;
        if (t === 's') {
          const v = c.querySelector('v');
          val = v ? shared[+v.textContent] : null;
        } else if (t === 'inlineStr') {
          val = Array.from(c.querySelectorAll('is t')).map((x) => x.textContent).join('');
        } else {
          const v = c.querySelector('v');
          if (v != null) {
            const raw = v.textContent;
            if (t === 'str' || t === 'e') val = raw;
            else {
              const nv = parseFloat(raw);
              const s = c.getAttribute('s');
              val = (!isNaN(nv) && s != null && dateStyles.has(+s)) ? serialToDate(nv) : (isNaN(nv) ? raw : nv);
            }
          }
        }
        arr[ci] = val;
      });
    });
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    sheets.push({ name: def.name, rows });
  });
  return { sheets };
}

/* -------------------------------- ZIP write -------------------------------- */
export const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* files: [{name, text}] — written STORED, which every unzipper accepts */
export function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  files.forEach((f) => {
    const nameBytes = enc.encode(f.name);
    const data = enc.encode(f.text);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); lv.setUint16(6, 0, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, 0, true); lv.setUint16(12, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true); lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true); cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);

    parts.push(local, data);
    central.push(cd);
    offset += local.length + data.length;
  });

  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...parts, ...central, end], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export const xmlEsc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const colLetter = (n) => { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; } return s; };

/* rows: array of arrays of strings. Header row is bolded. */
export function buildXlsx(sheetName, rows) {
  const sheetRows = rows.map((row, ri) => {
    const cells = row.map((val, ci) => {
      if (val == null || val === '') return '';
      const ref = colLetter(ci) + (ri + 1);
      if (typeof val === 'number') return `<c r="${ref}"><v>${val}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${ri === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlEsc(val)}</t></is></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join('');

  const widths = (rows[0] || []).map((h, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${Math.min(46, Math.max(14, String(h || '').length + 6))}" customWidth="1"/>`).join('');

  const files = [
    { name: '[Content_Types].xml', text:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: '_rels/.rels', text:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', text:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', text:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', text:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>` },
    { name: 'xl/worksheets/sheet1.xml', text:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${widths}</cols><sheetData>${sheetRows}</sheetData></worksheet>` }
  ];
  return makeZip(files);
}

export function downloadXlsx(sheetName, rows, filename) {
  const blob = buildXlsx(sheetName, rows);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 400);
  toast('Downloaded ' + filename);
}
