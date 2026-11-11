/** 背景资料文本提取：PDF / Word / 纯文本 */
export async function extractText(buf: Buffer, filename: string): Promise<string> {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'pdf') {
    const { extractText: pdfText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await pdfText(pdf, { mergePages: true });
    return String(text);
  }
  if (ext === 'docx') {
    const mammoth = await import('mammoth');
    const r = await mammoth.extractRawText({ buffer: buf });
    return r.value;
  }
  if (['txt', 'md', 'csv'].includes(ext ?? '')) return buf.toString('utf8');
  return '';
}
