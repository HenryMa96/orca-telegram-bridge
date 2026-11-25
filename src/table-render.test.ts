import { assert, test } from 'orca/testing'
import { exceedsTelegramPhotoLimits, renderTableToPng, type ExtractedTable } from './table-render'

const table = (cols: number, rows: number): ExtractedTable => ({
  headers: Array.from({ length: cols }, (_, c) => `H${c}`),
  rows: Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => `r${r}c${c}`))
})

test('a table too tall for Telegram sendPhoto keeps its markdown instead of becoming an image', async () => {
  // 200 rows of >= 66 px each pass Telegram's width + height <= 10000 limit whatever Python measures.
  const tall = table(2, 200)
  assert.equal(exceedsTelegramPhotoLimits(tall), true)
  assert.equal(await renderTableToPng(tall), null)
})

test('an ordinary table is still eligible for an image', () => {
  assert.equal(exceedsTelegramPhotoLimits(table(3, 10)), false)
  assert.equal(exceedsTelegramPhotoLimits(table(6, 40)), false)
})
