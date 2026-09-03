#!/usr/bin/env python3
"""pdf_to_md.py — PDF 转 Markdown（pdftotext 优先 / pypdf 回退 + 结构化后处理）

用法：python3 pdf_to_md.py 输入.pdf [输出.md]
输出：Markdown 文件 + stdout 统计（页数/字符数/结构计数）

结构化规则：
- 页眉页脚剔除：跨页重复的首/尾行
- 连字符断词合并：word-\\n → word
- 标题映射：数字编号（1. / 1.1 / 1.1.2 / 第X章）→ 对应 # 级；全大写短行 → ## 
- 列表规范化：-/*/•/· → -；数字. → 保留有序
- 表格检测：连续 ≥2 行按 2+ 空格切出一致列数 → Markdown 表格
- 段落合并：跨行硬换行按语言规则合并（中文直连，英文空格）
"""
import re
import subprocess
import sys
from pathlib import Path

HEADING_RE = re.compile(r'^(\d+(?:\.\d+)*)[.、\s]+\S')
ZH_HEADING_RE = re.compile(r'^第[一二三四五六七八九十百\d]+[章节部分篇][\s、.：:]?\S')
LIST_RE = re.compile(r'^([-*•·●○]|\d{1,3}[.)、])\s+')


def extract_text(pdf_path: str) -> tuple:
    """返回 (text, engine)。pdftotext 优先（布局保真），pypdf 回退。"""
    try:
        r = subprocess.run(['pdftotext', '-layout', pdf_path, '-'],
                           capture_output=True, text=True, timeout=120)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout, 'pdftotext'
    except FileNotFoundError:
        pass
    try:
        from pypdf import PdfReader
        reader = PdfReader(pdf_path)
        chunks = []
        for page in reader.pages:
            t = page.extract_text() or ''
            chunks.append(t)
            chunks.append('\f')
        return ''.join(chunks), 'pypdf'
    except Exception as e:
        print(f'错误：文本提取失败（{e}）。若为扫描版 PDF（无文本层）需先 OCR，本技能不支持。',
              file=sys.stderr)
        sys.exit(2)


def _norm(s: str) -> str:
    """归一化：数字→#，空白折叠。页脚常含页码（Footer 1 / 2），归一化后跨页可匹配。"""
    return re.sub(r'\s+', ' ', re.sub(r'\d+', '#', s)).strip()


def strip_headers_footers(pages: list) -> list:
    """剔除跨页重复首行/尾行（页眉/页脚）。归一化（数字→#）后出现于 ≥ 一半页面的首/尾行视为页眉/脚。"""
    n = len(pages)
    if n < 2:
        return pages
    from collections import Counter
    def edge_norms(getter):
        c = Counter()
        for p in pages:
            lines = [l for l in p.split('\n') if l.strip()]
            if lines and getter(lines):
                c[_norm(getter(lines))] += 1
        return {k for k, v in c.items() if v >= max(2, (n + 1) // 2)}
    heads = edge_norms(lambda ls: ls[0])
    tails = edge_norms(lambda ls: ls[-1])
    out = []
    for p in pages:
        lines = [l for l in p.split('\n') if l.strip()]
        if not lines:
            continue
        if _norm(lines[0]) in heads:
            lines = lines[1:]
        if lines and _norm(lines[-1]) in tails:
            lines = lines[:-1]
        out.append('\n'.join(lines))
    return out


def heading_level(line: str) -> int:
    """返回标题级别（0 = 非标题）。"""
    m = HEADING_RE.match(line)
    if m:
        return min(m.group(1).count('.') + 1, 6)
    if ZH_HEADING_RE.match(line):
        return 1
    if len(line) <= 60 and line == line.upper() and re.search(r'[A-Z]{3}', line) and not LIST_RE.match(line):
        return 2
    return 0


def join_hyphenated(pages: list) -> list:
    """连字符断词合并：英文词尾 - 接下行 → 拼回一个词。"""
    out = []
    for p in pages:
        p = re.sub(r'([A-Za-z])-\n([a-z])', r'\1\2', p)
        out.append(p)
    return out


def looks_table(line: str) -> bool:
    return len(re.split(r'\s{2,}', line.strip())) >= 3


def render_table(block: list) -> str:
    """-layout 多空格对齐块转 Markdown 表格。列空格数不规则时用表头列起始位置对齐切分。"""
    rows = [re.split(r'\s{2,}', l.strip()) for l in block]
    ncols = len(rows[0])
    if ncols >= 2 and all(len(r) == ncols for r in rows):
        cells = rows
    else:
        # 位置对齐法：用表头各列起始位置切每行（alpha 1 中间单空格也能正确分列）
        cuts = [m.start() for m in re.finditer(r'\S+', block[0])]
        # 合并过近切点（<2 字符距）
        merged = [cuts[0]]
        for c in cuts[1:]:
            if c - merged[-1] >= 2:
                merged.append(c)
        if len(merged) < 2:
            return None
        cells = []
        for l in block:
            row = []
            for j, c in enumerate(merged):
                end = merged[j + 1] if j + 1 < len(merged) else len(l)
                cell = l[c:end].strip()
                if not cell:
                    return None
                row.append(cell)
            cells.append(row)
        ncols = len(merged)
    md = ['| ' + ' | '.join(cells[0]) + ' |',
          '|' + '---|' * ncols]
    for r in cells[1:]:
        md.append('| ' + ' | '.join(r) + ' |')
    return '\n'.join(md)


def is_chinese(s: str) -> bool:
    return bool(re.search(r'[\u4e00-\u9fff]', s))


def merge_paragraphs(text: str) -> str:
    """段落内硬换行合并：中文直连；英文前行未终结且后行小写/继续词开头时空格连接。"""
    lines = text.split('\n')
    out = []
    buf = ''
    def flush():
        nonlocal buf
        if buf.strip():
            out.append(buf.strip())
        buf = ''
    for line in lines:
        s = line.strip()
        if not s:
            flush()
            continue
        if heading_level(s) or LIST_RE.match(s) or s.startswith('#') or s.startswith('|'):
            flush()
            out.append(s)
            continue
        if looks_table(s):
            flush()
            out.append(s)
            continue
        if not buf:
            buf = s
            continue
        # 合并条件：前行未以句末标点收尾
        if re.search(r'[.。！？；;:!?]$', buf) or (is_chinese(buf) is False and s[0].isupper() and re.search(r'[.!?]$', buf)):
            flush()
            buf = s
        else:
            buf += ('' if is_chinese(buf[-1:]) or is_chinese(s[0]) else ' ') + s
    flush()
    return '\n\n'.join(out)


def convert(text: str) -> tuple:
    stats = {'h': 0, 'li': 0, 'tbl': 0, 'suspect': 0, 'del': 0}
    pages = text.split('\f')
    before = sum(len(p) for p in pages)
    pages = [p for p in pages if p is not None]
    pages = strip_headers_footers(pages)
    after = sum(len(p) for p in pages)
    stats['del'] = before - after
    pages = join_hyphenated(pages)
    body = '\n\n'.join(p for p in pages if p.strip())

    lines = body.split('\n')
    # 文档主标题启发：全文首行、较短、无句尾标点、非编号章节（编号标题走下方映射）→ 提升为 # 
    hasDocTitle = False
    if lines:
        first = lines[0].strip()
        if (first and len(first) <= 80 and not heading_level(first)
                and not LIST_RE.match(first) and not looks_table(first)
                and not re.search(r'[.。！？;；,，]$', first)):
            lines[0] = '# ' + first
            stats['h'] += 1
            hasDocTitle = True
    md = []
    i = 0
    while i < len(lines):
        line = lines[i].rstrip()
        s = line.strip()
        if not s:
            i += 1
            continue
        lvl = heading_level(s)
        if lvl and len(s) <= 90:
            if hasDocTitle:
                lvl = min(lvl + 1, 6)  # 有文档主标题时编号章节整体降一级
            num = re.match(r'^(\d+(?:\.\d+)*)', s)
            title = re.sub(r'^(\d+(?:\.\d+)*[.、\s]+|第[一二三四五六七八九十百\d]+[章节部分篇][\s、.：:]?)', '', s)
            md.append('#' * lvl + ' ' + (num.group(1) + ' ' if num else '') + title)
            stats['h'] += 1
            i += 1
            continue
        if looks_table(s):
            # 块收集：首行 ≥3 段触发；后续行 ≥2 段也纳入（表格正文列常挤在一起）
            block = []
            while i < len(lines):
                cur = lines[i].strip()
                segs = len(re.split(r'\s{2,}', cur))
                if segs >= 3 or (block and segs >= 2):
                    block.append(cur)
                    i += 1
                else:
                    break
            if len(block) >= 2:
                t = render_table(block)
                if t:
                    md.append(t)
                    stats['tbl'] += 1
                    continue
                # 列对齐不规则（自动转换有错列风险）：保留原文并计数，由 Agent 按原文人工转表格
                stats['suspect'] += 1
                md.append('\n'.join(block))
                continue
        m = LIST_RE.match(s)
        if m:
            marker = m.group(1)
            item = LIST_RE.sub('', s)
            if re.match(r'^\d', marker):
                md.append(f'{marker.rstrip(")、.")}. {item}')
            else:
                md.append(f'- {item}')
            stats['li'] += 1
            i += 1
            continue
        md.append(line)
        i += 1
    merged = merge_paragraphs('\n'.join(md))
    # 列表块连续化：相邻列表项间的空行收掉（紧凑列表）
    merged = re.sub(r'\n\n(?=(- |\d{1,3}\. ))', '\n', merged)
    return merged, stats


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    pdf = Path(sys.argv[1]).expanduser().resolve()
    if not pdf.exists():
        print(f'错误：文件不存在：{pdf}', file=sys.stderr)
        sys.exit(2)
    out = Path(sys.argv[2]).expanduser().resolve() if len(sys.argv) > 2 else pdf.with_suffix('.md')

    text, engine = extract_text(str(pdf))
    npages = text.count('\f') + (0 if text.endswith('\f') else 1)
    if len(text.strip()) < 10:
        print('错误：PDF 几乎无文本（疑似扫描版/图片型），需先 OCR，本技能不支持。', file=sys.stderr)
        sys.exit(3)

    md, stats = convert(text)
    out.write_text(md, encoding='utf-8')
    print(f'已转换：{pdf.name} → {out}')
    print(f'引擎={engine} 页数≈{npages} 提取字符={len(text)} 输出字符={len(md)}')
    print(f'结构：标题 {stats["h"]} / 列表 {stats["li"]} / 表格 {stats["tbl"]} / 疑似表格待润色 {stats["suspect"]} / 剔除页眉脚字符 {max(0, stats["del"])}')
    if stats['suspect']:
        print(f'注意：{stats["suspect"]} 处多空格对齐块列不规则，已保留原文（未自动转表格）——请按原文人工转成 Markdown 表格。')
    print('下一步建议：read 输出文件抽查标题层级与表格列对齐；扫描签名/多栏复杂版面需人工润色。')


if __name__ == '__main__':
    main()
