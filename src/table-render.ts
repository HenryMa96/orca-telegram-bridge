import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

export type ExtractedTable = {
  headers: string[]
  rows: string[][]
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((c) => c.trim())
}

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return false
  const cells = splitTableRow(trimmed)
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c))
}

function cleanCellText(raw: string): string {
  return raw
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .trim()
}

export function extractTablesFromMarkdown(md: string): {
  textWithMarkers: string
  tables: ExtractedTable[]
} {
  const lines = md.split(/\r?\n/)
  const outLines: string[] = []
  const tables: ExtractedTable[] = []
  let inFence = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim().startsWith('```')) {
      inFence = !inFence
      outLines.push(line)
      continue
    }

    if (
      !inFence &&
      line.includes('|') &&
      lines[i + 1] !== undefined &&
      isTableSeparatorLine(lines[i + 1])
    ) {
      const headers = splitTableRow(line).map(cleanCellText)
      const rows: string[][] = []
      let j = i + 2
      while (
        j < lines.length &&
        lines[j].trim().includes('|') &&
        !lines[j].trim().startsWith('```') &&
        !(lines[j + 1] !== undefined && isTableSeparatorLine(lines[j + 1]))
      ) {
        rows.push(splitTableRow(lines[j]).map(cleanCellText))
        j++
      }

      if (headers.length >= 2 && rows.length >= 1) {
        tables.push({ headers, rows })
        outLines.push(`📊 **表格 ${tables.length}**（见下方图片）`)
        i = j - 1
        continue
      }
    }

    outLines.push(line)
  }

  return { textWithMarkers: outLines.join('\n'), tables }
}

const PYTHON_RENDER_SCRIPT = `
import io, json, os, sys
from PIL import Image, ImageDraw, ImageFont

data = json.loads(sys.stdin.buffer.read().decode("utf-8"))
headers = data.get("headers", [])
rows = data.get("rows", [])
if not headers:
    sys.exit(1)

def pick_font(paths, size):
    for p in paths:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()

font_reg = pick_font([
    r"C:\\Windows\\Fonts\\msyh.ttc",
    r"C:\\Windows\\Fonts\\simhei.ttf",
    "/System/Library/Fonts/PingFang.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
], 26)
font_bold = pick_font([
    r"C:\\Windows\\Fonts\\msyhbd.ttc",
    r"C:\\Windows\\Fonts\\msyh.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
], 27)

pad_x, pad_y, line_gap = 24, 16, 8
max_col_w, min_col_w, outer_pad = 440, 100, 18

def wrap_text(text, font, max_w):
    if not text:
        return [""]
    lines = []
    for para in str(text).split("\\n"):
        cur = ""
        for ch in para:
            cand = cur + ch
            if font.getlength(cand) <= max_w or not cur:
                cur = cand
            else:
                lines.append(cur)
                cur = ch
        lines.append(cur)
    return lines

ncols = len(headers)
col_widths = [min_col_w] * ncols
for c in range(ncols):
    w = int(font_bold.getlength(str(headers[c]))) + pad_x * 2
    for r in rows:
        cell = str(r[c]) if c < len(r) else ""
        w = max(w, int(font_reg.getlength(cell)) + pad_x * 2)
    col_widths[c] = max(min_col_w, min(max_col_w + pad_x * 2, w))

wrapped_headers = [wrap_text(headers[c], font_bold, col_widths[c] - pad_x * 2) for c in range(ncols)]
wrapped_rows = [[wrap_text(r[c] if c < len(r) else "", font_reg, col_widths[c] - pad_x * 2) for c in range(ncols)] for r in rows]

line_h = 34
header_lines = max(len(l) for l in wrapped_headers)
header_h = header_lines * line_h + (header_lines - 1) * line_gap + pad_y * 2
row_heights = []
for wr in wrapped_rows:
    ml = max(len(l) for l in wr)
    row_heights.append(ml * line_h + (ml - 1) * line_gap + pad_y * 2)

table_w = sum(col_widths)
table_h = header_h + sum(row_heights)
img_w = table_w + outer_pad * 2
img_h = table_h + outer_pad * 2
if img_w + img_h > 10000 or max(img_w, img_h) > 20 * min(img_w, img_h):
    sys.exit(3)

img = Image.new("RGB", (img_w, img_h), "#F8FAFC")
draw = ImageDraw.Draw(img)
x0, y0 = outer_pad, outer_pad

draw.rounded_rectangle([x0, y0, x0 + table_w, y0 + table_h], radius=14, fill="#FFFFFF", outline="#CBD5E1", width=2)
draw.rounded_rectangle([x0, y0, x0 + table_w, y0 + header_h], radius=14, fill="#EEF2FF")
draw.rectangle([x0, y0 + 14, x0 + table_w, y0 + header_h], fill="#EEF2FF")
draw.line([x0, y0 + header_h, x0 + table_w, y0 + header_h], fill="#CBD5E1", width=2)

cx = x0
for c in range(ncols):
    if c > 0:
        draw.line([cx, y0, cx, y0 + table_h], fill="#E2E8F0", width=1)
    cy = y0 + pad_y
    for line in wrapped_headers[c]:
        draw.text((cx + pad_x, cy), line, font=font_bold, fill="#1E293B")
        cy += line_h + line_gap
    cx += col_widths[c]

ry = y0 + header_h
for idx, wr in enumerate(wrapped_rows):
    rh = row_heights[idx]
    if idx % 2 == 1:
        draw.rectangle([x0 + 1, ry + 1, x0 + table_w - 1, ry + rh - 1], fill="#F8FAFC")
    draw.line([x0, ry, x0 + table_w, ry], fill="#E2E8F0", width=1)
    cx = x0
    for c in range(ncols):
        if c > 0:
            draw.line([cx, ry, cx, ry + rh], fill="#E2E8F0", width=1)
        cy = ry + pad_y
        for line in wr[c]:
            draw.text((cx + pad_x, cy), line, font=font_reg, fill="#334155")
            cy += line_h + line_gap
        cx += col_widths[c]
    ry += rh

draw.rounded_rectangle([x0, y0, x0 + table_w, y0 + table_h], radius=14, outline="#CBD5E1", width=2)

buf = io.BytesIO()
img.save(buf, format="PNG", optimize=True)
if buf.tell() > 10 * 1024 * 1024:
    sys.exit(3)
sys.stdout.buffer.write(buf.getvalue())
`

// Telegram sendPhoto rejects width + height > 10000, a side ratio > 20 or > 10 MB; the script exits
// with this code when the measured image breaks those limits.
const PHOTO_LIMIT_EXIT_CODE = 3

/**
 * Lower bounds of the script's layout (row >= 66 px, column 100..488 px, 18 px outer padding): true
 * when Telegram would reject the image for certain, so Python need not run.
 */
export function exceedsTelegramPhotoLimits(table: ExtractedTable): boolean {
  const cols = table.headers.length
  const minHeight = 66 * (table.rows.length + 1) + 36
  const minWidth = 100 * cols + 36
  const maxWidth = 488 * cols + 36
  return minWidth + minHeight > 10000 || minHeight > 20 * maxWidth
}

function getPythonCandidates(): { cmd: string; prefixArgs: string[] }[] {
  if (process.platform !== 'win32') {
    return [
      { cmd: 'python3', prefixArgs: [] },
      { cmd: 'python', prefixArgs: [] }
    ]
  }
  const home = os.homedir()
  const candidates = [
    { cmd: 'python3', prefixArgs: [] },
    { cmd: path.join('C:\\Python311', 'python3.exe'), prefixArgs: [] },
    { cmd: path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe'), prefixArgs: [] },
    { cmd: 'py', prefixArgs: ['-3'] }
  ]
  return candidates
}

function runPythonRender(cmd: string, prefixArgs: string[], jsonInput: string): Promise<Buffer | null> {
  return new Promise<Buffer | null>((resolve, reject) => {
    const child = spawn(cmd, [...prefixArgs, '-c', PYTHON_RENDER_SCRIPT], {
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Table render timed out'))
    }, 10_000)

    child.stdout.on('data', (c: Buffer) => stdout.push(c))
    child.stderr.on('data', (c: Buffer) => stderr.push(c))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const out = Buffer.concat(stdout)
      if (code === 0 && out.length > 0) {
        resolve(out)
      } else if (code === PHOTO_LIMIT_EXIT_CODE) {
        resolve(null)
      } else {
        reject(new Error(Buffer.concat(stderr).toString('utf8') || `exit ${code}`))
      }
    })
    // Python without Pillow exits before reading a large payload; that EPIPE must not crash the worker.
    child.stdin.on('error', () => {})
    child.stdin.write(jsonInput, 'utf8')
    child.stdin.end()
  })
}

export async function renderTableToPng(table: ExtractedTable): Promise<Buffer | null> {
  if (exceedsTelegramPhotoLimits(table)) return null
  const payload = JSON.stringify(table)
  for (const { cmd, prefixArgs } of getPythonCandidates()) {
    try {
      return await runPythonRender(cmd, prefixArgs, payload)
    } catch {
      // Try next python candidate.
    }
  }
  return null
}
