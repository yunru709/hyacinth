"""
name: docx_read
description: Read the text content of a .docx (Microsoft Word) file. Extracts paragraphs, headings, tables, and lists. Returns plain text with structure preserved. Requires: pip install python-docx
parameters:
  type: object
  properties:
    file: {type: string, description: Path to the .docx file (absolute or relative to cwd)}
    mode: {type: string, description: Output mode: text (plain text, default), paragraphs (one per line with style info), or raw (all elements with types)}
    max_chars: {type: number, description: Maximum characters to return. Default: 50000. Truncates with summary if exceeded.}
  required: [file]
"""
import json
import os
import sys

def main():
    args = json.loads(sys.stdin.read())
    file_path = args.get('file', '')
    mode = args.get('mode', 'text')
    max_chars = int(args.get('max_chars', 50000))

    if not file_path:
        print('Error: file parameter is required.')
        return

    # Resolve path
    if not os.path.isabs(file_path):
        file_path = os.path.join(os.getcwd(), file_path)

    if not os.path.exists(file_path):
        print(f'Error: File not found: {file_path}')
        return

    if not file_path.lower().endswith('.docx'):
        print(f'Error: File does not appear to be a .docx file: {file_path}')
        return

    try:
        from docx import Document
    except ImportError:
        print('Error: python-docx is not installed. Run: pip install python-docx')
        return

    try:
        doc = Document(file_path)
    except Exception as e:
        print(f'Error: Failed to open document: {e}')
        return

    parts = []

    if mode == 'text':
        # Continuous text with structure markers
        for element in doc.iter_inner_content():
            if hasattr(element, 'text') and element.text:
                t = element.text.strip()
                if t:
                    parts.append(t)
        result = '\n\n'.join(parts)

    elif mode == 'paragraphs':
        for i, para in enumerate(doc.paragraphs):
            if para.text.strip():
                style = para.style.name if para.style else 'Normal'
                parts.append(f'[{i}] ({style}) {para.text.strip()}')

        result = '\n'.join(parts)

    elif mode == 'raw':
        # Paragraphs
        parts.append(f'=== Paragraphs: {len(doc.paragraphs)} ===')
        for i, para in enumerate(doc.paragraphs):
            if para.text.strip():
                parts.append(f'P{i}: {para.text.strip()}')

        # Tables
        parts.append(f'\n=== Tables: {len(doc.tables)} ===')
        for ti, table in enumerate(doc.tables):
            parts.append(f'\nTable {ti}: ({len(table.rows)} rows x {len(table.columns)} cols)')
            for ri, row in enumerate(table.rows):
                cells = [cell.text.strip() for cell in row.cells]
                parts.append(f'  Row{ri}: | ' + ' | '.join(cells) + ' |')

        result = '\n'.join(parts)

    else:
        print(f'Error: Unknown mode "{mode}". Use text, paragraphs, or raw.')
        return

    # Truncate if needed
    if len(result) > max_chars:
        total_chars = len(result)
        result = result[:max_chars]
        result += f'\n\n... (truncated at {max_chars} chars, {total_chars} total)'

    if not result.strip():
        print('(empty document)')
    else:
        print(result)

if __name__ == '__main__':
    main()
