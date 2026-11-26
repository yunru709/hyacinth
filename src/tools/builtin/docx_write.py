"""
name: docx_write
description: Create or overwrite a .docx (Microsoft Word) file from Markdown content. Supports headings (# ## ### ####), body paragraphs with Chinese first-line indent, bullet and ordered lists, tables, bold/italic/inline-code, page size preset. Writes with real Word Heading styles so the navigation pane, automatic table of contents and PDF bookmarks work. Requires: pip install python-docx
parameters:
  type: object
  properties:
    file: {type: string, description: Output .docx path (absolute or relative to cwd)}
    markdown: {type: string, description: Markdown text to convert. Mutually exclusive with markdown_file}
    markdown_file: {type: string, description: Path to a Markdown file to convert. Mutually exclusive with markdown}
    title: {type: string, description: Optional centered document title inserted before the content}
    font_cn: {type: string, description: Chinese body font name. Default: 宋体}
    font_heading_cn: {type: string, description: Chinese heading font name. Default: 黑体}
    font_size: {type: number, description: Body font size in points. Default: 12}
    line_spacing: {type: number, description: Line spacing as a multiple. Default: 1.5}
    indent_chars: {type: number, description: First-line indent measured in Chinese characters. Default: 2}
    page: {type: string, description: Page preset, a4 or letter. Default: a4}
  required: [file]
"""
import json
import os
import re
import sys


def set_run_font(run, cn_font, size_pt, bold=False, italic=False, mono=False):
    """统一设置中西文字体（中文必须写 rFonts/eastAsia，否则 Word 用西文字体渲染中文）"""
    from docx.shared import Pt
    from docx.oxml.ns import qn
    run.font.size = Pt(size_pt)
    run.font.bold = bold
    run.font.italic = italic
    if mono:
        run.font.name = 'Consolas'
        run._element.rPr.rFonts.set(qn('w:eastAsia'), cn_font)
    else:
        run.font.name = 'Times New Roman'
        run._element.rPr.rFonts.set(qn('w:eastAsia'), cn_font)


INLINE_PATTERN = re.compile(r'(\*\*.+?\*\*|\*[^*\n]+?\*|`[^`\n]+?`)')


def add_inline(paragraph, text, cn_font, size_pt):
    """把 **粗体** / *斜体* / `代码` 拆成多个 run"""
    pos = 0
    for m in INLINE_PATTERN.finditer(text):
        if m.start() > pos:
            set_run_font(paragraph.add_run(text[pos:m.start()]), cn_font, size_pt)
        token = m.group(0)
        if token.startswith('**'):
            set_run_font(paragraph.add_run(token[2:-2]), cn_font, size_pt, bold=True)
        elif token.startswith('`'):
            set_run_font(paragraph.add_run(token[1:-1]), cn_font, size_pt - 0.5, mono=True)
        else:
            set_run_font(paragraph.add_run(token[1:-1]), cn_font, size_pt, italic=True)
        pos = m.end()
    if pos < len(text):
        set_run_font(paragraph.add_run(text[pos:]), cn_font, size_pt)


def is_table_sep(line):
    s = line.strip()
    if not s.startswith('|'):
        return False
    body = s.strip('|').strip()
    return bool(body) and all(re.fullmatch(r':?-{1,}:?', c.strip()) for c in body.split('|'))


def split_row(line):
    s = line.strip()
    if s.startswith('|'):
        s = s[1:]
    if s.endswith('|'):
        s = s[:-1]
    return [c.strip() for c in s.split('|')]


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
    if not out_path.lower().endswith('.docx'):
        print('Error: output file must end with .docx: %s' % out_path)
        return

    md_text = args.get('markdown')
    md_file = args.get('markdown_file')
    if md_text is None and md_file:
        p = md_file if os.path.isabs(md_file) else os.path.join(os.getcwd(), md_file)
        if not os.path.exists(p):
            print('Error: markdown_file not found: %s' % p)
            return
        with open(p, 'r', encoding='utf-8') as f:
            md_text = f.read()
    if md_text is None:
        print('Error: either markdown or markdown_file is required.')
        return

    font_cn = args.get('font_cn') or '宋体'
    font_heading_cn = args.get('font_heading_cn') or '黑体'
    font_size = float(args.get('font_size') or 12)
    line_spacing = float(args.get('line_spacing') or 1.5)
    indent_chars = float(args.get('indent_chars') if args.get('indent_chars') is not None else 2)
    page = (args.get('page') or 'a4').lower()
    title = args.get('title') or ''

    try:
        from docx import Document
        from docx.shared import Pt, Cm, RGBColor
        from docx.enum.text import WD_ALIGN_PARAGRAPH
        from docx.oxml.ns import qn
    except ImportError:
        print('Error: python-docx is not installed. Run: pip install python-docx')
        return

    doc = Document()

    # ---- 全局样式 ----
    normal = doc.styles['Normal']
    normal.font.name = 'Times New Roman'
    normal.font.size = Pt(font_size)
    normal._element.rPr.rFonts.set(qn('w:eastAsia'), font_cn)
    normal.paragraph_format.line_spacing = line_spacing

    # 标题样式：默认是蓝色西文，改成黑色中文黑体，否则导航窗格好看但正文难看
    for lvl, size in ((1, font_size + 3), (2, font_size + 1), (3, font_size + 0.5), (4, font_size)):
        try:
            st = doc.styles['Heading %d' % lvl]
            st.font.name = 'Times New Roman'
            st.font.size = Pt(size)
            st.font.bold = True
            st.font.color.rgb = RGBColor(0, 0, 0)
            st._element.rPr.rFonts.set(qn('w:eastAsia'), font_heading_cn)
        except KeyError:
            pass

    # ---- 页面 ----
    if page == 'letter':
        margins = (Cm(2.54), Cm(2.54), Cm(2.54), Cm(2.54))
    else:
        margins = (Cm(2.54), Cm(2.54), Cm(3.0), Cm(2.6))
    for s in doc.sections:
        s.top_margin, s.bottom_margin, s.left_margin, s.right_margin = margins

    # ---- 可选标题 ----
    if title:
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_after = Pt(18)
        set_run_font(p.add_run(title), font_heading_cn, font_size + 6, bold=True)

    lines = md_text.replace('\r\n', '\n').replace('\r', '\n').split('\n')
    i = 0
    n = len(lines)

    while i < n:
        line = lines[i]
        stripped = line.strip()

        # 空行
        if not stripped:
            i += 1
            continue

        # 代码块
        if stripped.startswith('```'):
            i += 1
            while i < n and not lines[i].strip().startswith('```'):
                p = doc.add_paragraph()
                pf = p.paragraph_format
                pf.line_spacing = 1.0
                pf.space_after = Pt(0)
                pf.left_indent = Cm(0.74)
                set_run_font(p.add_run(lines[i]), font_cn, font_size - 1, mono=True)
                i += 1
            i += 1
            continue

        # 表格
        if stripped.startswith('|') and i + 1 < n and is_table_sep(lines[i + 1]):
            header = split_row(lines[i])
            i += 2
            rows = []
            while i < n and lines[i].strip().startswith('|'):
                rows.append(split_row(lines[i]))
                i += 1
            cols = max([len(header)] + [len(r) for r in rows]) if rows else len(header)
            table = doc.add_table(rows=1, cols=cols)
            table.style = 'Table Grid'
            for ci in range(cols):
                cell = table.rows[0].cells[ci]
                cell.text = ''
                para = cell.paragraphs[0]
                txt = header[ci] if ci < len(header) else ''
                set_run_font(para.add_run(txt), font_heading_cn, font_size - 1, bold=True)
            for r in rows:
                cells = table.add_row().cells
                for ci in range(cols):
                    cells[ci].text = ''
                    para = cells[ci].paragraphs[0]
                    txt = r[ci] if ci < len(r) else ''
                    add_inline(para, txt, font_cn, font_size - 1)
            doc.add_paragraph()
            continue

        # 标题
        m = re.match(r'^(#{1,6})\s+(.*)$', stripped)
        if m:
            lvl = min(len(m.group(1)), 4)
            h = doc.add_heading(level=lvl)
            h.paragraph_format.space_before = Pt(12)
            h.paragraph_format.space_after = Pt(6)
            add_inline(h, m.group(2).strip(), font_heading_cn, font_size + (3 if lvl == 1 else 1 if lvl == 2 else 0.5 if lvl == 3 else 0))
            for r in h.runs:
                r.font.bold = True
            i += 1
            continue

        # 水平线
        if re.fullmatch(r'[-*_]{3,}', stripped):
            i += 1
            continue

        # 引用
        if stripped.startswith('>'):
            p = doc.add_paragraph()
            pf = p.paragraph_format
            pf.line_spacing = line_spacing
            pf.left_indent = Cm(0.74)
            pf.space_after = Pt(4)
            add_inline(p, stripped.lstrip('>').strip(), font_cn, font_size)
            for r in p.runs:
                r.font.italic = True
            i += 1
            continue

        # 无序列表
        m = re.match(r'^[-*+]\s+(.*)$', stripped)
        if m:
            p = doc.add_paragraph(style='List Bullet')
            p.paragraph_format.line_spacing = line_spacing
            p.paragraph_format.space_after = Pt(3)
            add_inline(p, m.group(1), font_cn, font_size)
            i += 1
            continue

        # 有序列表
        m = re.match(r'^\d+[.)]\s+(.*)$', stripped)
        if m:
            p = doc.add_paragraph(style='List Number')
            p.paragraph_format.line_spacing = line_spacing
            p.paragraph_format.space_after = Pt(3)
            add_inline(p, m.group(1), font_cn, font_size)
            i += 1
            continue

        # 正文：连续非空行合并为一段（硬换行按 Markdown 语义视作空格）
        buf = [stripped]
        i += 1
        while i < n:
            nxt = lines[i].strip()
            if (not nxt or nxt.startswith('#') or nxt.startswith('|') or nxt.startswith('>')
                    or nxt.startswith('```') or re.match(r'^[-*+]\s+', nxt)
                    or re.match(r'^\d+[.)]\s+', nxt) or re.fullmatch(r'[-*_]{3,}', nxt)):
                break
            buf.append(nxt)
            i += 1
        p = doc.add_paragraph()
        pf = p.paragraph_format
        pf.line_spacing = line_spacing
        pf.space_after = Pt(6)
        if indent_chars > 0:
            pf.first_line_indent = Pt(indent_chars * font_size)
        add_inline(p, ' '.join(buf), font_cn, font_size)

    out_dir = os.path.dirname(out_path)
    if out_dir and not os.path.isdir(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    try:
        doc.save(out_path)
    except Exception as e:
        print('Error: failed to save document: %s' % e)
        return

    size_kb = round(os.path.getsize(out_path) / 1024.0, 1)
    heads = sum(1 for l in lines if re.match(r'^#{1,4}\s', l.strip()))
    paras = sum(1 for l in lines if l.strip() and not l.strip().startswith(('#', '|', '>', '```'))
                and not re.match(r'^[-*+]\s+', l.strip()) and not re.match(r'^\d+[.)]\s+', l.strip()))
    print('Saved: %s' % out_path)
    print('Size: %s KB | headings: %d | paragraphs: %d | page: %s | body font: %s %spt'
          % (size_kb, heads, paras, page, font_cn, font_size))


if __name__ == '__main__':
    main()
