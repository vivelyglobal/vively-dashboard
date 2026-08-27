export function parseCsvText(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const rows = [];
  lines.forEach((line) => {
    if (!line.trim()) return;
    const vals = []; let v = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && q && line[i + 1] === '"') { v += '"'; i++; }
      else if (ch === '"') q = !q;
      else if (ch === ',' && !q) { vals.push(v); v = ''; }
      else v += ch;
    }
    vals.push(v);
    rows.push(vals);
  });
  return rows;
}
