export function pdfViewerUrl(url: string, page: number): string {
  return `${url.split("#", 1)[0]}#page=${Math.max(1, page)}&view=FitH&navpanes=0`;
}
