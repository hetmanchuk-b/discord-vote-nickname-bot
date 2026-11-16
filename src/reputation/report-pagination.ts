export const REPORT_PAGE_SIZE = 15;
// Frozen reports retain their original layout so old public buttons stay valid.
export function reportPageSize(report: { pageSize?: number }): number {
  return report.pageSize ?? REPORT_PAGE_SIZE;
}
export function reportPageCount(report: { entryCount: number; pageSize?: number }): number {
  return Math.max(1, Math.ceil(report.entryCount / reportPageSize(report)));
}
