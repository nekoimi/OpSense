export const REPORT_BRAND = 'OpSense';
export const REPORT_WATERMARK = 'OpSense 版权所有';

export function reportCopyrightNotice(generatedAt: string): string {
  const date = new Date(generatedAt);
  const year = Number.isNaN(date.getTime()) ? new Date().getFullYear() : date.getFullYear();
  return `© ${year} ${REPORT_BRAND}. 保留所有权利。`;
}
