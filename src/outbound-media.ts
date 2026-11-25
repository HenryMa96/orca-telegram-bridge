import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Bot API upload limits: sendPhoto takes up to 10 MB, sendDocument up to 50 MB.
export const MAX_PHOTO_UPLOAD_BYTES = 10 * 1024 * 1024
export const MAX_DOCUMENT_UPLOAD_BYTES = 50 * 1024 * 1024
export const MAX_CAPTION_CHARS = 1024

export type AttachmentTarget =
  | { kind: 'file'; path: string }
  | { kind: 'url'; url: string; image: boolean }

export type OutboundAttachment = {
  caption: string
  target: AttachmentTarget
  // What the Telegram user sees in a failure line: the file name only, never the folder.
  name: string
}

// Content type by extension; a local image's signature decides the type it is sent with.
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

const IMAGE_EXT_BY_TYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp'
}

const DOCUMENT_CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation'
}

// Folders that hold credentials; any file below them is refused whatever its extension.
const SECRET_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker'])

// `![caption](target)` with an optional "title"; the target is `<...>` (spaces allowed) or a run
// without spaces, which may hold one level of balanced parentheses.
const IMAGE_REF =
  /!\[([^\]\n]*)\]\(\s*(<[^<>\n]+>|[^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const CODE_SPAN = /`[^`\n]*`/g

function lastSegment(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).at(-1) ?? p
}

/**
 * The attachment a Markdown image target names, or null when it stays text: relative paths,
 * `http:` and other schemes. UNC and `//host` paths are refused too: opening them on Windows
 * reaches out to that host.
 */
export function parseAttachmentTarget(raw: string, homeDir = os.homedir()): AttachmentTarget | null {
  const target = raw.trim()
  if (!target) return null
  if (/^https:\/\//i.test(target)) {
    let url: URL
    try {
      url = new URL(target)
    } catch {
      return null
    }
    if (!url.hostname) return null
    const image = IMAGE_CONTENT_TYPES[path.posix.extname(url.pathname).toLowerCase()] !== undefined
    return { kind: 'url', url: url.href, image }
  }
  let filePath: string
  if (/^file:/i.test(target)) {
    try {
      filePath = fileURLToPath(target)
    } catch {
      return null
    }
  } else if (/^~[\\/]/.test(target)) {
    filePath = path.join(homeDir, target.slice(2))
  } else if (/^[A-Za-z]:[\\/]/.test(target) || /^\/(?!\/)/.test(target)) {
    filePath = target
  } else {
    return null
  }
  if (/^[\\/]{2}/.test(filePath)) return null
  return { kind: 'file', path: filePath }
}

function attachmentName(target: AttachmentTarget): string {
  if (target.kind === 'file') return lastSegment(target.path)
  const url = new URL(target.url)
  const segment = lastSegment(url.pathname)
  if (!segment) return url.hostname
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * Takes the `![caption](target)` references that name a local file or an https URL out of a reply,
 * in order. Code blocks and inline code are left alone, as are references the bridge cannot send;
 * a line that held only references is dropped.
 */
export function extractAttachments(
  markdown: string,
  homeDir?: string
): { text: string; attachments: OutboundAttachment[] } {
  const attachments: OutboundAttachment[] = []
  const kept: string[] = []
  let fence: string | null = null
  for (const line of markdown.split('\n')) {
    const fenceMark = FENCE.exec(line)?.[1]
    if (fence !== null) {
      if (fenceMark && fenceMark[0] === fence[0] && fenceMark.length >= fence.length) fence = null
      kept.push(line)
      continue
    }
    if (fenceMark) {
      fence = fenceMark
      kept.push(line)
      continue
    }
    const codeSpans = Array.from(line.matchAll(CODE_SPAN), (m) => [m.index ?? 0, (m.index ?? 0) + m[0].length])
    let removed = false
    const rest = line.replace(IMAGE_REF, (match: string, caption: string, rawTarget: string, offset: number) => {
      if (codeSpans.some(([start, end]) => offset >= start && offset < end)) return match
      const target = parseAttachmentTarget(
        rawTarget.startsWith('<') ? rawTarget.slice(1, -1) : rawTarget,
        homeDir
      )
      if (!target) return match
      // Telegram counts the 1024-character caption limit in UTF-16 units; never split an emoji.
      let captionText = ''
      for (const ch of caption.trim()) {
        if (captionText.length + ch.length > MAX_CAPTION_CHARS) break
        captionText += ch
      }
      attachments.push({ caption: captionText, target, name: attachmentName(target) })
      removed = true
      return ''
    })
    if (!removed) kept.push(line)
    else if (rest.trim()) kept.push(rest.trimEnd())
  }
  const text = kept.join('\n')
  return {
    text: attachments.length > 0 ? text.replace(/\n{3,}/g, '\n\n').trim() : text,
    attachments
  }
}

/** True for paths under a credentials folder (`.ssh`, `.aws`, ...) or files named `.env*`. */
export function isSecretPath(filePath: string): boolean {
  const parts = filePath.split(/[\\/]+/).filter(Boolean).map((part) => part.toLowerCase())
  if (parts.at(-1)?.startsWith('.env')) return true
  return parts.some(
    (part, i) => SECRET_DIRS.has(part) || (part === '.config' && parts[i + 1] === 'gcloud')
  )
}

/** The image type a file's first bytes show (PNG, JPEG, GIF, WEBP), or null. */
export function detectImageType(data: Buffer): string | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  const head = data.subarray(0, 12).toString('latin1')
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif'
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp'
  return null
}

export type AttachmentFs = {
  realpath(p: string): Promise<string>
  stat(p: string): Promise<{ isFile(): boolean; size: number }>
  // The first `bytes` bytes of the file (fewer when it is shorter).
  readHead(p: string, bytes: number): Promise<Buffer>
  readFile(p: string): Promise<Buffer>
}

const nodeFs: AttachmentFs = {
  realpath: (p) => fsp.realpath(p),
  stat: (p) => fsp.stat(p),
  async readHead(p, bytes) {
    const handle = await fsp.open(p, 'r')
    try {
      const buf = Buffer.alloc(bytes)
      const { bytesRead } = await handle.read(buf, 0, bytes, 0)
      return buf.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  },
  readFile: (p) => fsp.readFile(p)
}

export type AttachmentProblem = 'missing' | 'unreadable' | 'too_large' | 'not_allowed' | 'not_image'

export type LocalAttachment = {
  method: 'photo' | 'document'
  realPath: string
  filename: string
  contentType: string
  data: Buffer
}

export type LoadAttachmentResult =
  | { ok: true; file: LocalAttachment }
  | { ok: false; problem: AttachmentProblem; realPath?: string }

function fsProblem(err: unknown): AttachmentProblem {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable'
}

/**
 * Reads a local file the bot asked to attach, after the checks: not under a credentials folder
 * (before and after resolving symlinks), an allowed extension, a regular file within 50 MB, and
 * for image extensions an image signature, which sets the content type and the file extension.
 * Images over 10 MB go out as documents.
 */
export async function loadLocalAttachment(
  filePath: string,
  fsApi: AttachmentFs = nodeFs
): Promise<LoadAttachmentResult> {
  if (isSecretPath(filePath)) return { ok: false, problem: 'not_allowed' }
  let realPath: string
  try {
    realPath = await fsApi.realpath(filePath)
  } catch (err) {
    return { ok: false, problem: fsProblem(err) }
  }
  if (isSecretPath(realPath)) return { ok: false, problem: 'not_allowed', realPath }
  let filename = lastSegment(realPath)
  const ext = path.extname(filename).toLowerCase()
  const isImage = IMAGE_CONTENT_TYPES[ext] !== undefined
  let contentType = isImage ? IMAGE_CONTENT_TYPES[ext] : DOCUMENT_CONTENT_TYPES[ext]
  if (!contentType) return { ok: false, problem: 'not_allowed', realPath }
  let data: Buffer
  try {
    const stat = await fsApi.stat(realPath)
    if (!stat.isFile()) return { ok: false, problem: 'not_allowed', realPath }
    if (stat.size > MAX_DOCUMENT_UPLOAD_BYTES) return { ok: false, problem: 'too_large', realPath }
    if (isImage) {
      const detected = detectImageType(await fsApi.readHead(realPath, 12))
      if (!detected) return { ok: false, problem: 'not_image', realPath }
      if (detected !== contentType) {
        contentType = detected
        filename = `${filename.slice(0, filename.length - ext.length)}${IMAGE_EXT_BY_TYPE[detected]}`
      }
    }
    data = await fsApi.readFile(realPath)
  } catch (err) {
    return { ok: false, problem: fsProblem(err), realPath }
  }
  // The file may have grown since stat.
  if (data.length > MAX_DOCUMENT_UPLOAD_BYTES) return { ok: false, problem: 'too_large', realPath }
  const method = isImage && data.length <= MAX_PHOTO_UPLOAD_BYTES ? 'photo' : 'document'
  return { ok: true, file: { method, realPath, filename, contentType, data } }
}
