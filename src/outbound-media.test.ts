import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assert, test } from 'orca/testing'
import {
  extractAttachments,
  isSecretPath,
  loadLocalAttachment,
  MAX_PHOTO_UPLOAD_BYTES,
  type AttachmentFs
} from './outbound-media'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)])

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-outbound-'))
  try {
    await run(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

// A file system holding one file, seen through `links` (requested path -> real path).
function fakeFs(file: { path: string; data: Buffer; size?: number }, links: Record<string, string> = {}): AttachmentFs {
  return {
    async realpath(p) {
      const real = links[p] ?? p
      if (real !== file.path) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return real
    },
    async stat() {
      return { isFile: () => true, size: file.size ?? file.data.length }
    },
    async readHead(_p, bytes) {
      return file.data.subarray(0, bytes)
    },
    async readFile() {
      return file.data
    }
  }
}

test('Windows, POSIX, file:// and ~/ targets become attachments in order; their lines leave the text', () => {
  const fileUrl = pathToFileURL(path.join(os.tmpdir(), 'b.pdf')).href
  const md = [
    'Here you go.',
    '',
    '![CPU](C:\\Users\\me\\cpu.png)',
    '![Report](/home/me/report.pdf "Q3")',
    `![B](${fileUrl})`,
    '![Notes](~/notes.md)',
    '',
    'Bye.'
  ].join('\n')
  const { text, attachments } = extractAttachments(md, '/home/me')
  assert.equal(text, 'Here you go.\n\nBye.')
  assert.deepEqual(
    attachments.map((a) => [a.caption, a.target, a.name]),
    [
      ['CPU', { kind: 'file', path: 'C:\\Users\\me\\cpu.png' }, 'cpu.png'],
      ['Report', { kind: 'file', path: '/home/me/report.pdf' }, 'report.pdf'],
      ['B', { kind: 'file', path: path.join(os.tmpdir(), 'b.pdf') }, 'b.pdf'],
      ['Notes', { kind: 'file', path: path.join('/home/me', 'notes.md') }, 'notes.md']
    ]
  )
})

test('an angle-bracket target keeps a path with spaces; without brackets it stays text', () => {
  const md = '![Q3 report](<C:/Users/me/My Docs/q3 report.pdf>)\n![Broken](C:/Users/me/My Docs/x.pdf)'
  const { text, attachments } = extractAttachments(md)
  assert.deepEqual(attachments.map((a) => a.target), [{ kind: 'file', path: 'C:/Users/me/My Docs/q3 report.pdf' }])
  assert.equal(attachments[0].name, 'q3 report.pdf')
  assert.equal(text, '![Broken](C:/Users/me/My Docs/x.pdf)')
})

test('relative paths, http URLs, plain links, UNC paths and code stay as text', () => {
  const md = [
    '![Chart](charts/cpu.png)',
    '![Old](http://example.com/a.png)',
    'See [the report](/home/me/report.pdf).',
    '![Share](//server/share/a.png)',
    '![Share2](\\\\server\\share\\a.png)',
    'Use `![x](/tmp/a.png)` to attach.',
    '```',
    '![Example](/tmp/example.png)',
    '```'
  ].join('\n')
  const { text, attachments } = extractAttachments(md)
  assert.deepEqual(attachments, [])
  assert.equal(text, md)
})

test('https URLs are attachments: image extensions as photos, anything else as documents', () => {
  const { text, attachments } = extractAttachments(
    'Look: ![Logo](https://example.com/a/logo.PNG?v=2) and ![Sheet](https://example.com/q3.xlsx)'
  )
  assert.equal(text, 'Look:  and')
  assert.deepEqual(
    attachments.map((a) => [a.target, a.name]),
    [
      [{ kind: 'url', url: 'https://example.com/a/logo.PNG?v=2', image: true }, 'logo.PNG'],
      [{ kind: 'url', url: 'https://example.com/q3.xlsx', image: false }, 'q3.xlsx']
    ]
  )
})

test('a caption is cut to 1024 UTF-16 units without splitting an emoji', () => {
  const caption = `${'a'.repeat(1023)}😀tail`
  const { attachments } = extractAttachments(`![${caption}](/tmp/a.png)`)
  assert.equal(attachments[0].caption, 'a'.repeat(1023))
})

test('credential folders and .env files are secret, case-insensitively, on both path styles', () => {
  for (const p of [
    'C:\\Users\\me\\.ssh\\id_rsa.txt',
    '/home/me/.AWS/config.txt',
    '/home/me/.config/gcloud/creds.csv',
    'C:/work/.env.local',
    '/srv/app/.env',
    '/home/me/.kube/config.md'
  ]) {
    assert.equal(isSecretPath(p), true, p)
  }
  for (const p of ['/home/me/.config/app/a.csv', '/home/me/env.txt', 'C:\\Users\\me\\report.pdf']) {
    assert.equal(isSecretPath(p), false, p)
  }
})

test('a symlink that resolves into .ssh is refused although its own path looks harmless', async () => {
  const real = '/home/me/.ssh/backup.pdf'
  const result = await loadLocalAttachment(
    '/home/me/docs/report.pdf',
    fakeFs({ path: real, data: Buffer.from('%PDF') }, { '/home/me/docs/report.pdf': real })
  )
  assert.deepEqual(result, { ok: false, problem: 'not_allowed', realPath: real })
})

test('local files: PNG photo, PDF document, signature checks, and refusals by reason', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'cpu.png'), PNG)
    await fs.writeFile(path.join(dir, 'mislabeled.jpg'), PNG)
    await fs.writeFile(path.join(dir, 'fake.png'), 'not an image')
    await fs.writeFile(path.join(dir, 'report.pdf'), '%PDF-1.4')
    await fs.writeFile(path.join(dir, 'id_rsa'), 'key')
    await fs.writeFile(path.join(dir, 'tool.exe'), 'MZ')
    await fs.mkdir(path.join(dir, 'folder.pdf'))

    const photo = await loadLocalAttachment(path.join(dir, 'cpu.png'))
    assert.ok(photo.ok)
    assert.deepEqual(
      photo.ok && [photo.file.method, photo.file.filename, photo.file.contentType, photo.file.data.equals(PNG)],
      ['photo', 'cpu.png', 'image/png', true]
    )

    // The signature, not the extension, sets the type; the name follows it.
    const mislabeled = await loadLocalAttachment(path.join(dir, 'mislabeled.jpg'))
    assert.deepEqual(mislabeled.ok && [mislabeled.file.filename, mislabeled.file.contentType], ['mislabeled.png', 'image/png'])

    const pdf = await loadLocalAttachment(path.join(dir, 'report.pdf'))
    assert.deepEqual(pdf.ok && [pdf.file.method, pdf.file.contentType], ['document', 'application/pdf'])

    const problems = await Promise.all(
      ['fake.png', 'id_rsa', 'tool.exe', 'folder.pdf', 'gone.pdf'].map(async (name) => {
        const result = await loadLocalAttachment(path.join(dir, name))
        return result.ok ? 'ok' : result.problem
      })
    )
    assert.deepEqual(problems, ['not_image', 'not_allowed', 'not_allowed', 'not_allowed', 'missing'])
  })
})

test('a file over 50 MB is refused before it is read; an image over 10 MB goes out as a document', async () => {
  const reads: string[] = []
  const huge = fakeFs({ path: '/data/big.pdf', data: Buffer.alloc(0), size: 51 * 1024 * 1024 })
  const tooLarge = await loadLocalAttachment('/data/big.pdf', {
    ...huge,
    readHead: async () => {
      reads.push('head')
      return Buffer.alloc(0)
    },
    readFile: async () => {
      reads.push('file')
      return Buffer.alloc(0)
    }
  })
  assert.deepEqual(tooLarge, { ok: false, problem: 'too_large', realPath: '/data/big.pdf' })
  assert.deepEqual(reads, [])

  const bigPng = Buffer.concat([PNG, Buffer.alloc(MAX_PHOTO_UPLOAD_BYTES)])
  const big = await loadLocalAttachment('/data/big.png', fakeFs({ path: '/data/big.png', data: bigPng }))
  assert.deepEqual(big.ok && [big.file.method, big.file.contentType], ['document', 'image/png'])
})
