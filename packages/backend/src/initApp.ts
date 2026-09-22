import { ensureDir } from './utils'
import { AUDIO_DIR, SRT_DIR, PUBLIC_DIR, BOOKS_DIR } from './config'

export async function initApp() {
  await ensureDir(AUDIO_DIR)
  await ensureDir(SRT_DIR)
  await ensureDir(PUBLIC_DIR)
  await ensureDir(BOOKS_DIR)
}
