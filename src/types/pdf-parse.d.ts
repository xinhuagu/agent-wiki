declare module "pdf-parse" {
  interface PDFData {
    text: string;
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: unknown;
    version: string;
  }
  interface PDFOptions {
    /** Max pages to parse. 0 = all pages (default). */
    max?: number;
    /** Custom page render function. Return empty string to skip a page. */
    pagerender?: (pageData: { pageIndex: number; getTextContent: () => Promise<any> }) => Promise<string>;
  }
  export default function parse(buffer: Buffer, options?: PDFOptions): Promise<PDFData>;
}
