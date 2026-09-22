import dotenv from 'dotenv'
import { resolve, join, relative, isAbsolute } from 'path'

dotenv.config({
  path: [
    resolve(__dirname, '..', '..', '.env'),
    resolve(__dirname, '..', '..', '..', '..', '.env'),
  ],
})
export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
}

// 项目根目录：本文件位于 packages/backend/dist/config（编译后）或 packages/backend/src/config（tsx 开发），向上四级即项目根
export const ROOT_DIR = join(__dirname, '..', '..', '..', '..')

// 音频(mp3)输出到项目根 audio 目录，字幕(srt)输出到项目根 Str 目录
export const AUDIO_DIR = join(ROOT_DIR, 'audio')
export const SRT_DIR = join(ROOT_DIR, 'Str')
// 上传的小说原文（按章节批量合成时使用，保留原文便于中断后继续）
export const BOOKS_DIR = join(ROOT_DIR, 'books')
export const AUDIO_CACHE_DIR = join(AUDIO_DIR, '.cache')
export const PUBLIC_DIR = join(__dirname, '..', '..', 'public')
export const ALLOWED_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.srt'])

/**
 * 字幕路径映射：把音频目录内的 .mp3 路径映射为字幕目录内同名的 .srt 路径。
 * 不在音频目录内的路径退化为同级替换，避免出现 `..` 相对路径
 */
export function srtPathFor(audioPath: string): string {
  const rel = relative(AUDIO_DIR, audioPath)
  const target = rel && !rel.startsWith('..') && !isAbsolute(rel) ? join(SRT_DIR, rel) : audioPath
  return target.replace(/\.mp3$/i, '.srt')
}

export const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY
export const MODEL_NAME = process.env.MODEL_NAME

export const STATIC_DOMAIN = process.env.NODE_ENV === 'development' ? 'http://localhost:3000' : ''

export const RATE_LIMIT_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW || '0') || 10
export const RATE_LIMIT = parseInt(process.env.RATE_LIMIT || '0') || 1e6

export const EDGE_API_LIMIT = parseInt(process.env.EDGE_API_LIMIT || '3') || 3

export const PORT = parseInt(process.env.PORT || '3000') || 3000

export const REGISTER_OPENAI_TTS = process.env.REGISTER_OPENAI_TTS || false

export const REGISTER_KOKORO = process.env.REGISTER_KOKORO || false
export const TTS_KOKORO_URL = process.env.TTS_KOKORO_URL || 'http://localhost:8880/v1'

export const LIMIT_TEXT_LENGTH = parseInt(process.env.LIMIT_TEXT_LENGTH || '0')
export const LIMIT_TEXT_LENGTH_ERROR_MESSAGE = process.env.LIMIT_TEXT_LENGTH_ERROR_MESSAGE
export const USE_HELMET = process.env.USE_HELMET === 'true' || false
export const USE_LIMIT = process.env.USE_LIMIT === 'true' || false
export const DIRECT_GEN_LIMIT = process.env.DIRECT_GEN_LIMIT || 200
