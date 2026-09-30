/* =========================================================
   tests/helpers/syntheticPdf.mjs — минимальный корректный PDF для тестов.
   Только синтетический текст («Synthetic page N of M»), без реальных данных.
   Работает и в node, и в браузере (e2e): возвращает Uint8Array.
   ========================================================= */

export function makeTestPdf(pageCount = 3, { width = 595, height = 842 } = {}) {
  const objs = [];
  const pageIds = Array.from({ length: pageCount }, (_, i) => 4 + i * 2);
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let i = 0; i < pageCount; i++) {
    const shade = (0.3 + (0.5 * i) / Math.max(1, pageCount - 1)).toFixed(2);
    const stream = [
      `BT /F1 34 Tf 60 ${height - 110} Td (Synthetic page ${i + 1} of ${pageCount}) Tj ET`,
      `BT /F1 14 Tf 60 ${height - 150} Td (LexLife test document - no personal data) Tj ET`,
      `0.2 ${shade} 0.8 rg 60 ${height - 420} 470 220 re f`,
      `1 1 1 rg BT /F1 90 Tf 270 ${height - 350} Td (${i + 1}) Tj ET`,
    ].join('\n');
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out); // только ASCII: длины в байтах = длинам строк
}
