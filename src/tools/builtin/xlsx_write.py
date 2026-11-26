"""
name: xlsx_write
description: Create or overwrite an .xlsx (Microsoft Excel) file from tabular data. Accepts a JSON 2D array or CSV text. First row can be written as a styled bold header and frozen; columns are auto-fitted with CJK width awareness. Requires: pip install openpyxl
parameters:
  type: object
  properties:
    file: {type: string, description: Output .xlsx path (absolute or relative to cwd)}
    sheet: {type: string, description: Worksheet name. Default: Sheet1}
    rows: {type: string, description: JSON 2D array of cell values, e.g. [[name,score],[a,1]]. Mutually exclusive with csv and csv_file}
    csv: {type: string, description: CSV text to parse. Mutually exclusive with rows and csv_file}
    csv_file: {type: string, description: Path to a CSV file. Mutually exclusive with rows and csv}
    header: {type: boolean, description: Treat the first row as a header row (bold, frozen, shaded). Default: true}
    autofit: {type: boolean, description: Auto-fit column widths with CJK awareness. Default: true}
    overwrite: {type: boolean, description: Allow replacing an existing file. Default: true}
  required: [file]
"""
import csv as csvmod
import io
import json
import os
import sys


def display_width(value):
    """中文字符/全角符号按 2 个字符宽估算，用于列宽自适应"""
    s = '' if value is None else str(value)
    w = 0
    for ch in s:
        w += 2 if ord(ch) > 0x2E7F else 1
    return w


def main():
    raw = sys.stdin.read()
    try:
        args = json.loads(raw) if raw.strip() else {}
    except Exception as e:
        print('Error: failed to parse arguments as JSON: %s' % e)
        return

    out_path = args.get('file', '')
    if not out_path:
        print('Error: file parameter is required.')
        return
    if not os.path.isabs(out_path):
        out_path = os.path.join(os.getcwd(), out_path)
    if not out_path.lower().endswith('.xlsx'):
        print('Error: output file must end with .xlsx: %s' % out_path)
        return

    if os.path.exists(out_path) and not args.get('overwrite', True):
        print('Error: file already exists (set overwrite=true to replace): %s' % out_path)
        return

    sheet_name = args.get('sheet') or 'Sheet1'
    header = args.get('header', True)
    autofit = args.get('autofit', True)

    # ---- 取数据 ----
    data = None
    src = ''
    if args.get('rows') is not None:
        try:
            data = json.loads(args['rows']) if isinstance(args['rows'], str) else args['rows']
            src = 'rows'
        except Exception as e:
            print('Error: rows is not valid JSON: %s' % e)
            return
    elif args.get('csv') is not None:
        data = list(csvmod.reader(io.StringIO(args['csv'])))
        src = 'csv'
    elif args.get('csv_file'):
        p = args['csv_file'] if os.path.isabs(args['csv_file']) else os.path.join(os.getcwd(), args['csv_file'])
        if not os.path.exists(p):
            print('Error: csv_file not found: %s' % p)
            return
        with open(p, 'r', encoding='utf-8-sig', newline='') as f:
            data = list(csvmod.reader(f))
        src = 'csv_file'

    if not data:
        print('Error: no data provided. Pass rows, csv, or csv_file.')
        return
    if not isinstance(data, list) or not all(isinstance(r, (list, tuple)) for r in data):
        print('Error: data must be a 2D array of rows.')
        return

    try:
        from openpyxl import Workbook
        from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
        from openpyxl.utils import get_column_letter
    except ImportError:
        print('Error: openpyxl is not installed. Run: pip install openpyxl')
        return

    wb = Workbook()
    ws = wb.active
    ws.title = str(sheet_name)[:31]

    # ---- 归一化：转数值 ----
    def norm(v):
        if v is None:
            return None
        if isinstance(v, (int, float, bool)):
            return v
        s = str(v).strip()
        if s == '':
            return None
        # 纯数字（含小数点/负号）转数值，便于 Excel 计算
        try:
            if s.lstrip('-').replace('.', '', 1).isdigit() and s.count('.') <= 1:
                return float(s) if '.' in s else int(s)
        except Exception:
            pass
        return s

    for r in data:
        ws.append([norm(c) for c in r])

    n_cols = max((len(r) for r in data), default=0)
    n_rows = ws.max_row

    # ---- 表头样式 ----
    if header and n_rows >= 1:
        head_font = Font(bold=True, size=11)
        head_fill = PatternFill('solid', fgColor='E8EEF7')
        thin = Side(style='thin', color='B0B7C3')
        border = Border(left=thin, right=thin, top=thin, bottom=thin)
        for c in range(1, n_cols + 1):
            cell = ws.cell(row=1, column=c)
            cell.font = head_font
            cell.fill = head_fill
            cell.alignment = Alignment(horizontal='center', vertical='center')
            cell.border = border
        ws.freeze_panes = 'A2'

    # ---- 列宽 ----
    if autofit and n_cols:
        for c in range(1, n_cols + 1):
            width = 8
            for r in range(1, n_rows + 1):
                v = ws.cell(row=r, column=c).value
                if v is None:
                    continue
                w = display_width(v) + 2
                if w > width:
                    width = w
            ws.column_dimensions[get_column_letter(c)].width = min(width, 60)

    out_dir = os.path.dirname(out_path)
    if out_dir and not os.path.isdir(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    try:
        wb.save(out_path)
    except Exception as e:
        print('Error: failed to save workbook: %s' % e)
        return

    size_kb = round(os.path.getsize(out_path) / 1024.0, 1)
    print('Saved: %s' % out_path)
    print('Size: %s KB | sheet: %s | rows: %d | cols: %d | source: %s | header: %s'
          % (size_kb, ws.title, n_rows, n_cols, src, 'yes' if header else 'no'))


if __name__ == '__main__':
    main()
