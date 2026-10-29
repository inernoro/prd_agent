import * as XLSX from 'xlsx';
import type { ProductPermissionSnapshot, ProductPermissionWorkbook } from '@/services/real/productPermissions';

const IDENTITY_COLUMNS = ['用户ID', '账号', '姓名', '菜单可见'];
const LIMIT = 4 * 1024 * 1024;
const text = (value: unknown) => value == null ? '' : String(value).trim();
function flag(value: unknown, position: string): boolean {
  if (value === 1 || value === true || value === '1') return true;
  if (value === 0 || value === false || value === '0') return false;
  throw new Error(position + '必须填写1或0，不能留空。');
}

export function snapshotWorkbook(snapshot: ProductPermissionSnapshot): ProductPermissionWorkbook {
  return { schemaVersion: 1, expectedRevision: snapshot.revision, sheets: snapshot.menus.map((menu) => ({
    menu: menu.key, rows: snapshot.users.map((user) => ({
      userId: user.userId, username: user.username, displayName: user.displayName,
      visible: user.menus.includes(menu.key),
      functions: Object.fromEntries(menu.functions.map((key) => [key, user.permissions.includes(key)])),
    })),
  })) };
}

export function writePermissionWorkbook(data: ProductPermissionWorkbook, metadata: ProductPermissionSnapshot): XLSX.WorkBook {
  const book = XLSX.utils.book_new();
  for (const menu of metadata.menus) {
    const rows = data.sheets.find((sheet) => sheet.menu === menu.key)?.rows ?? [];
    const values = [
      ['产品管理权限覆盖导入', menu.label],
      ['协议版本', 1, '配置版本', data.expectedRevision],
      ['每表名单保持一致；1允许、0禁止；整本覆盖未列人员；MAP管理员始终全可见。'],
      [...IDENTITY_COLUMNS, ...menu.functions.map((key) => metadata.functions[key])],
      ...rows.map((row) => [row.userId, row.username, row.displayName, Number(row.visible), ...menu.functions.map((key) => Number(row.functions[key]))]),
    ];
    const sheet = XLSX.utils.aoa_to_sheet(values);
    sheet['!cols'] = [{ wch: 34 }, { wch: 24 }, { wch: 18 }, { wch: 18 }, ...menu.functions.map(() => ({ wch: 30 }))];
    sheet['!autofilter'] = { ref: XLSX.utils.encode_range({ r: 3, c: 0 }, { r: rows.length + 3, c: IDENTITY_COLUMNS.length + menu.functions.length - 1 }) };
    XLSX.utils.book_append_sheet(book, sheet, menu.label);
  }
  return book;
}

export function readPermissionWorkbook(buffer: ArrayBuffer, metadata: ProductPermissionSnapshot): ProductPermissionWorkbook {
  if (buffer.byteLength > LIMIT) throw new Error('权限文件不能超过4MB。');
  const book = XLSX.read(buffer, { type: 'array', cellFormula: true, sheetRows: 5005 });
  if (book.SheetNames.length !== metadata.menus.length || metadata.menus.some((m) => !book.SheetNames.includes(m.label))) throw new Error('必须包含全部菜单分表，不能增删或重命名分表。');
  let revision: string | undefined;
  const sheets = metadata.menus.map((menu) => {
    const sheet = book.Sheets[menu.label];
    const range = XLSX.utils.decode_range(sheet['!fullref'] ?? sheet['!ref'] ?? 'A1');
    if (range.e.r > 5003 || range.e.c !== IDENTITY_COLUMNS.length + menu.functions.length - 1) throw new Error(menu.label + '表超出人员上限或列数不正确。');
    for (const [key, cell] of Object.entries(sheet)) if (!key.startsWith('!') && cell.f) throw new Error(menu.label + '表不能包含公式，请填写明确的1或0。');
    const values = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', blankrows: true });
    if (text(values[0]?.[0]) !== '产品管理权限覆盖导入' || text(values[0]?.[1]) !== menu.label || values[1]?.[1] !== 1 || text(values[1]?.[0]) !== '协议版本' || text(values[1]?.[2]) !== '配置版本') throw new Error(menu.label + '表的模板标识不正确。');
    const current = text(values[1]?.[3]);
    if (!current || (revision != null && revision !== current)) throw new Error('各分表配置版本必须一致，请重新导出模板。');
    revision = current;
    const headers = [...IDENTITY_COLUMNS, ...menu.functions.map((key) => metadata.functions[key])];
    if (headers.some((header, i) => text(values[3]?.[i]) !== header)) throw new Error(menu.label + '表列名不正确，请重新导出模板。');
    const rows = values.slice(4).filter((row) => row.some((value) => text(value) !== '')).map((row, index) => {
      if (![row[0], row[1], row[2]].some((v) => text(v))) throw new Error(menu.label + '表第' + (index + 5) + '行缺少人员标识。');
      return { userId: text(row[0]), username: text(row[1]), displayName: text(row[2]), visible: flag(row[3], menu.label + '菜单可见列'),
        functions: Object.fromEntries(menu.functions.map((key, i) => [key, flag(row[i + 4], menu.label + '功能列')])) };
    });
    if (!rows.length) throw new Error(menu.label + '表不能为空；关闭权限请填写0。');
    return { menu: menu.key, rows };
  });
  return { schemaVersion: 1, expectedRevision: revision!, sheets };
}

export function downloadPermissionWorkbook(data: ProductPermissionWorkbook, metadata: ProductPermissionSnapshot) {
  XLSX.writeFile(writePermissionWorkbook(data, metadata), '产品管理权限.xlsx', { bookType: 'xlsx' });
}
