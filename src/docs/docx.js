import { makeZip, xmlEsc } from '../lib/xlsx.js';
import { esc } from '../ui/dom.js';
import { toast } from '../ui/overlay.js';

/* ============================================================
   DOCX writer — same trick as the XLSX one. A .docx is a ZIP of
   XML, and makeZip() already writes ZIPs, so Word documents come
   out of the browser with no library and no CDN.

   Blocks: {t:'h1'|'h2'|'h3'|'p'|'table'|'break'|'space', ...}
   ============================================================ */

export const DOC_FONT_LATIN = 'Calibri';
export const DOC_FONT_EAST  = 'Malgun Gothic';   /* so Korean renders on Windows and Mac */

export function wRun(text, opt) {
  opt = opt || {};
  const props = [];
  if (opt.bold) props.push('<w:b/><w:bCs/>');
  if (opt.italic) props.push('<w:i/>');
  if (opt.size) props.push(`<w:sz w:val="${opt.size * 2}"/><w:szCs w:val="${opt.size * 2}"/>`);
  if (opt.color) props.push(`<w:color w:val="${opt.color}"/>`);
  const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : '';
  /* keep manual line breaks */
  const parts = String(text == null ? '' : text).split('\n');
  const body = parts.map((s, i) => (i ? '<w:br/>' : '') + `<w:t xml:space="preserve">${xmlEsc(s)}</w:t>`).join('');
  return `<w:r>${rPr}${body}</w:r>`;
}

export function wPara(runs, opt) {
  opt = opt || {};
  const p = [];
  if (opt.align) p.push(`<w:jc w:val="${opt.align}"/>`);
  const before = opt.before == null ? 0 : opt.before;
  const after = opt.after == null ? 120 : opt.after;
  p.push(`<w:spacing w:before="${before}" w:after="${after}" w:line="264" w:lineRule="auto"/>`);
  if (opt.indent) p.push(`<w:ind w:left="${opt.indent}"/>`);
  if (opt.keepNext) p.push('<w:keepNext/>');
  if (opt.border) p.push('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr>');
  const pPr = `<w:pPr>${p.join('')}</w:pPr>`;
  return `<w:p>${pPr}${Array.isArray(runs) ? runs.join('') : runs}</w:p>`;
}

export function wCell(text, opt) {
  opt = opt || {};
  const shade = opt.shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${opt.shade}"/>` : '';
  return `<w:tc><w:tcPr><w:tcW w:w="${opt.width || 0}" w:type="${opt.width ? 'dxa' : 'auto'}"/>${shade}
    <w:tcMar><w:top w:w="80" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar>
    </w:tcPr>${wPara(wRun(text, { bold: opt.bold, size: opt.size || 10 }), { after: 0 })}</w:tc>`;
}

export function wTable(rows, opt) {
  opt = opt || {};
  const widths = opt.widths || [];
  const borders = `<w:tblBorders>
    ${['top','left','bottom','right','insideH','insideV'].map((s) =>
      `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`).join('')}
  </w:tblBorders>`;
  const body = rows.map((row, ri) => `<w:tr>${row.map((cell, ci) =>
    wCell(cell, { width: widths[ci], bold: opt.headerRow && ri === 0, shade: opt.headerRow && ri === 0 ? 'F2F2F2' : null, size: opt.size })
  ).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>${borders}<w:tblLayout w:type="fixed"/></w:tblPr>${body}</w:tbl>`;
}

export function blocksToXml(blocks) {
  return blocks.map((b) => {
    if (!b) return '';
    if (b.t === 'break') return `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
    if (b.t === 'space') return wPara(wRun(''), { after: b.after || 120 });
    if (b.t === 'table') return wTable(b.rows, { widths: b.widths, headerRow: b.headerRow, size: b.size });
    if (b.t === 'h1') return wPara(wRun(b.text, { bold: true, size: 18 }), { align: 'center', before: 120, after: 240 });
    if (b.t === 'h2') return wPara(wRun(b.text, { bold: true, size: 12 }), { before: 240, after: 100, keepNext: true });
    if (b.t === 'h3') return wPara(wRun(b.text, { bold: true, size: 10.5 }), { before: 160, after: 80, keepNext: true });
    if (b.t === 'sub') return wPara(wRun(b.text, { size: 10.5, color: '595959' }), { align: 'center', after: 200 });
    return wPara(wRun(b.text, { size: 10.5, bold: b.bold }), { after: b.after == null ? 120 : b.after, indent: b.indent });
  }).join('');
}

export function buildDocx(blocks, title) {
  const sectPr = `<w:sectPr>
    <w:pgSz w:w="11906" w:h="16838"/>
    <w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/>
  </w:sectPr>`;

  const files = [
    { name: '[Content_Types].xml', text:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>` },
    { name: '_rels/.rels', text:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>` },
    { name: 'docProps/core.xml', text:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xmlEsc(title || 'Agreement')}</dc:title><dc:creator>VIVELY Dashboard</dc:creator></cp:coreProperties>` },
    { name: 'word/_rels/document.xml.rels', text:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'word/styles.xml', text:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${DOC_FONT_LATIN}" w:hAnsi="${DOC_FONT_LATIN}" w:eastAsia="${DOC_FONT_EAST}" w:cs="${DOC_FONT_LATIN}"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>` },
    { name: 'word/document.xml', text:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${blocksToXml(blocks)}${sectPr}</w:body></w:document>` }
  ];
  return makeZip(files);
}

export function downloadDocx(blocks, filename, title) {
  const blob = buildDocx(blocks, title);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 400);
  toast('Downloaded ' + filename);
}

/* the same blocks rendered for the on-screen preview */
export function blocksToHtml(blocks) {
  return blocks.map((b) => {
    if (!b) return '';
    if (b.t === 'break') return '<div class="doc-break"></div>';
    if (b.t === 'space') return '<div style="height:10px"></div>';
    if (b.t === 'table') return `<table class="doc-table"><tbody>${b.rows.map((r, ri) =>
      `<tr>${r.map((c) => `<${b.headerRow && ri === 0 ? 'th' : 'td'}>${esc(c).replace(/\n/g, '<br>')}</${b.headerRow && ri === 0 ? 'th' : 'td'}>`).join('')}</tr>`).join('')}</tbody></table>`;
    if (b.t === 'h1') return `<h1 class="doc-h1">${esc(b.text)}</h1>`;
    if (b.t === 'sub') return `<p class="doc-sub">${esc(b.text)}</p>`;
    if (b.t === 'h2') return `<h2 class="doc-h2">${esc(b.text)}</h2>`;
    if (b.t === 'h3') return `<h3 class="doc-h3">${esc(b.text)}</h3>`;
    return `<p class="doc-p${b.bold ? ' b' : ''}"${b.indent ? ' style="margin-left:16px"' : ''}>${esc(b.text).replace(/\n/g, '<br>')}</p>`;
  }).join('');
}

export function blocksToText(blocks) {
  return blocks.map((b) => {
    if (!b) return '';
    if (b.t === 'break') return '\n\n———\n';
    if (b.t === 'space') return '';
    if (b.t === 'table') return b.rows.map((r) => r.join('\t')).join('\n');
    return b.text || '';
  }).filter(Boolean).join('\n\n');
}
