import { downloadCSV, toCSV } from '@/lib/csv';

export function downloadListCsv(filename: string, headers: string[], rows: string[][]) {
  downloadCSV(filename, toCSV(headers, rows));
}
