import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { BOOKS_DIR } from '../config'
import { ensureDir, safeFileName } from '../utils'
import { logger } from '../utils/logger'

/**
 * 章节识别与小说文件管理
 *
 * 目标：把「一个 txt = 一个 mp3」变成「一个 txt = 每章一个 mp3」。
 * 章节标题的常见形态（以《蛊真人》校对版实测为准）：
 *   第一卷              ← 卷标题（独占一行）
 *   魔性不改            ← 卷名（紧随卷标题的第一个非空行）
 *   第一节：纵身亡魔心仍不悔   ← 节标题（同一标题常连续出现两次，需去重）
 */

export interface Chapter {
  /** 全书连续序号，从 1 开始（文件名前缀用它，保证跨卷唯一且可排序） */
  index: number
  /** 卷标题，如「第一卷」；卷之前的「序」等为空 */
  volumeTitle: string
  /** 卷名，如「魔性不改」；识别不到时为空 */
  volumeName: string
  /** 节标题，如「第一节：纵身亡魔心仍不悔」 */
  title: string
  /** 正文字符数（不含标题，不含空白行） */
  charCount: number
  /** 实际送去合成的文本（正文，不含标题；标题只用于命名，默认不朗读） */
  text: string
}

export interface ParsedBook {
  bookId: string
  /** 上传时的原始文件名（带扩展名），如 `蛊真人错别字修改版4.0.txt` */
  fileName: string
  /**
   * 存放这本小说产物的文件夹名（取原始 txt 文件名去掉扩展名，已做非法字符处理）。
   * 章节批量合成的 mp3 放在 `audio/<folderName>/`，字幕放在 `Str/<folderName>/`
   */
  folderName: string
  filePath: string
  /** 全书字符数 */
  totalChars: number
  chapters: Chapter[]
}

/** 从 bookId 还原文件夹名：bookId 形如「书名-内容hash8」 */
export function bookFolderNameFromId(bookId: string): string {
  return bookId.replace(/-[0-9a-f]{8}$/i, '') || 'book'
}

/**
 * 章节号白名单：阿拉伯数字 + 中文小写/大写数字 + 亿、〇、两。
 * 参考 Reader(TextBook.cpp) 的 IsChapter()：`第` 与单位字之间的字符必须**全部**是这些，
 * 才能排除正文里「他翻到第三章」这类叙述句
 */
const CN_NUM = '0-9零一二三四五六七八九十百千万亿两〇壹贰叁肆伍陆柒捌玖拾佰仟萬億'
/** 章节单位：章 / 节 / 部 / 回 */
const CHAPTER_UNITS = '章节部回'
/** 单位之后必须紧跟的分隔符：空白、制表、全角空格、NBSP、半角/全角冒号（或直接行尾） */
const SEPARATOR_HEAD_RE = /^[\s\u3000\u00A0:：]/
/** 疑似叙述句的结尾标点，宽松模式下用来排除正文行 */
const SENTENCE_END_RE = /[。！？；]$/

// 卷：第一卷 / 第1卷 / 第两百三十卷（卷只作为分组信息，本身不生成音频）
const VOLUME_RE = new RegExp(`^第([${CN_NUM}]{1,12})卷(.*)$`)
// 节 / 章 / 部 / 回：第一节：xxx / 第一章 xxx / 第1回
const CHAPTER_RE = new RegExp(`^第([${CN_NUM}]{1,12})([${CHAPTER_UNITS}])(.*)$`)
// 卷外的独立篇章：序 / 楔子 / 番外 / 后记 等
const SPECIAL_RE = /^(序章|序言|序|前言|引子|楔子|后记|尾声|终章|番外|完本感言|作者的话)/

const MAX_TITLE_LENGTH = 60
const MAX_VOLUME_NAME_LENGTH = 30

/** 极短正文（多为重复标题或空节）不单独成章的阈值 */
const MIN_CHAPTER_CHARS = 10

/**
 * 单位字之后是否是合法结尾：行尾、空白、或冒号分隔。
 * 这是从 Reader 的默认章节规则里学到的关键约束——`第一章少年` 严格模式下不认，
 * 因为「章」后面既不是空白也不是冒号（正文里的「第三章的敌人」同理会被挡掉）
 */
function isUnitBoundary(rest: string): boolean {
  if (!rest) return true
  return SEPARATOR_HEAD_RE.test(rest)
}

export interface ParseOptions {
  /**
   * 宽松模式：不要求单位后有分隔符，仅靠"行首 + 行号白名单 + 行不长"判定。
   * 用于「第一章少年」这类紧凑体例；默认关闭，避免把正文叙述句误判成章节
   */
  relaxed?: boolean
  /** 自定义章节标题正则（源码字符串，不含首尾斜杠），用于非常规目录体例 */
  customRegex?: string
}

/**
 * 解析小说文本为章节列表。
 * 纯函数，便于单测与复用。
 */
export function parseChapters(
  raw: string,
  options: ParseOptions = {}
): { chapters: Chapter[]; totalChars: number } {
  const { relaxed = false, customRegex } = options
  let extraRe: RegExp | null = null
  if (customRegex) {
    try {
      // 允许 "/pattern/flags" 或裸 pattern 两种写法；去掉 g 标志，避免 test() 的 lastIndex 副作用
      const parsed = /^\/(.+)\/([a-z]*)$/.exec(customRegex)
      const source = parsed ? parsed[1] : customRegex
      const flags = (parsed ? parsed[2] : '').replace('g', '')
      extraRe = new RegExp(source, flags)
    } catch (err) {
      logger.warn(`Invalid customRegex ${customRegex}: ${(err as Error).message}`)
    }
  }

  /** 标题候选判定：默认要求单位后有分隔符；宽松模式再退一步看"像不像标题行" */
  const acceptHeading = (line: string, rest: string): boolean => {
    if (isUnitBoundary(rest)) return true
    if (!relaxed) return false
    return line.length <= 40 && !SENTENCE_END_RE.test(line)
  }

  const lines = raw.split(/\r?\n/)
  const chapters: Chapter[] = []

  let volumeTitle = ''
  let volumeName = ''
  let expectingVolumeName = false
  let current: { title: string; lines: string[] } | null = null

  const flush = () => {
    if (!current) return
    const body = normalizeBody(current.lines)
    const charCount = body.replace(/\s/g, '').length
    // 重复标题造成的空节直接丢弃，不占用序号
    if (charCount < MIN_CHAPTER_CHARS) {
      logger.warn(`Skip near-empty chapter "${current.title}" (${charCount} chars)`)
      current = null
      return
    }
    chapters.push({
      index: chapters.length + 1,
      volumeTitle,
      volumeName,
      title: current.title,
      charCount,
      text: body,
    })
    current = null
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    const line = rawLine.trim()

    // 自定义正则优先（非常规目录体例，如「1. 标题」「Chapter 1」）
    if (extraRe && extraRe.test(line)) {
      expectingVolumeName = false
      if (current && current.title === line && normalizeBody(current.lines) === '') continue
      flush()
      current = { title: line.slice(0, MAX_TITLE_LENGTH), lines: [] }
      continue
    }

    // 1) 卷标题（卷只作为分组，本身不生成音频）
    const volumeMatch = VOLUME_RE.exec(line)
    if (
      volumeMatch &&
      line.length <= MAX_VOLUME_NAME_LENGTH &&
      (relaxed || isUnitBoundary(volumeMatch[2]))
    ) {
      flush()
      volumeTitle = line
      volumeName = ''
      expectingVolumeName = true
      continue
    }

    // 2) 节标题：行首「第<数字白名单><章节部回>」且单位后是分隔符或行尾
    const chapterMatch = CHAPTER_RE.exec(line)
    const isChapterHeading = !!chapterMatch && acceptHeading(line, chapterMatch[3])
    const isSpecialHeading = SPECIAL_RE.test(line) && line.length <= MAX_TITLE_LENGTH
    if (line.length <= MAX_TITLE_LENGTH && (isChapterHeading || isSpecialHeading)) {
      expectingVolumeName = false
      // 同一标题连续出现（epub 转换常见）且当前节还没有正文 → 视为重复，跳过
      if (current && current.title === line && normalizeBody(current.lines) === '') {
        continue
      }
      flush()
      let title: string = line
      // 「序：不是走向成功，」这类非标准标题常被 epub 转成两行，
      // 标题以未完成标点结尾时，把紧随的短续行并回标题
      if (SPECIAL_RE.test(line) && /[，,、：:—\-…]$/.test(line)) {
        const next = nextNonEmptyLine(lines, i)
        if (next && next.value.length <= 20 && !SENTENCE_END_RE.test(next.value)) {
          title = line + next.value
          i = next.index
        }
      }
      current = { title, lines: [] }
      continue
    }

    // 3) 卷名：卷标题之后紧随的第一个非空行
    if (expectingVolumeName) {
      if (line) {
        volumeName = line.length <= MAX_VOLUME_NAME_LENGTH ? line : ''
        expectingVolumeName = false
      }
      continue
    }

    // 4) 正文
    if (current) current.lines.push(rawLine)
  }
  flush()

  const totalChars = chapters.reduce((sum, c) => sum + c.charCount, 0)
  return { chapters, totalChars }
}

/** 找第 i 行之后的第一行非空内容 */
function nextNonEmptyLine(lines: string[], i: number): { value: string; index: number } | null {
  for (let k = i + 1; k < lines.length; k++) {
    const value = lines[k].trim()
    if (value) return { value, index: k }
  }
  return null
}

/** 正文清理：去掉行尾空白，把连续空行压成一个换行 */
function normalizeBody(lines: string[]): string {
  const out: string[] = []
  let blank = false
  for (const line of lines) {
    const trimmed = line.replace(/[\s\u3000]+$/, '')
    if (!trimmed.trim()) {
      if (out.length && !blank) {
        out.push('')
        blank = true
      }
      continue
    }
    out.push(trimmed.trim())
    blank = false
  }
  while (out.length && !out[out.length - 1]) out.pop()
  return out.join('\n')
}

/**
 * 生成章节的音频文件名（不含目录）：
 *   0001_第一卷_第一节：纵身亡魔心仍不悔.mp3
 * 序号为全书序号，4 位补零，保证目录内按名排序即按阅读顺序
 */
export function chapterFileName(chapter: Pick<Chapter, 'index' | 'volumeTitle' | 'title'>): string {
  const seq = String(chapter.index).padStart(4, '0')
  const parts = [seq, chapter.volumeTitle, chapter.title].filter((p) => !!p)
  // safeFileName 会替换 Windows 非法字符与空白；序号前缀保证不会重名
  const name = safeFileName(parts.join('_')).slice(0, 120)
  return `${name}.mp3`
}

/** bookId：文件名 + 内容哈希，便于识别同一本书的不同版本 */
function makeBookId(fileName: string, buffer: Buffer): string {
  const hash = crypto.createHash('md5').update(buffer).digest('hex').slice(0, 8)
  // 放宽到 80：bookId 里带着原始文件名，去掉尾部 hash 就能还原文件夹名
  return `${safeFileName(path.parse(fileName).name).slice(0, 80)}-${hash}`
}

/** 上传时记录的元信息，保证「文件夹名 = 用户拖入的 txt 文件名」不受 bookId 截断影响 */
interface BookMeta {
  /** 用户拖入时的原始文件名（含扩展名），如 `Demo.txt` */
  fileName: string
  /** 产物文件夹名，如 `Demo` */
  folderName: string
  uploadedAt: number
}

function metaPathFor(bookId: string): string {
  return path.join(BOOKS_DIR, `${bookId}.meta.json`)
}

async function readBookMeta(bookId: string): Promise<BookMeta | null> {
  try {
    const raw = await fs.readFile(metaPathFor(bookId), 'utf8')
    const meta = JSON.parse(raw) as BookMeta
    return meta?.folderName ? meta : null
  } catch {
    return null
  }
}

/** 产物文件夹名：取用户拖入的 txt 文件名去掉扩展名 */
export function bookFolderNameFromFile(fileName: string): string {
  return safeFileName(path.parse(fileName).name.trim()) || 'book'
}

/** 保存上传的小说原文（重复上传同名同内容文件直接复用） */
export async function saveBook(fileName: string, buffer: Buffer): Promise<ParsedBook> {
  await ensureDir(BOOKS_DIR)
  const bookId = makeBookId(fileName, buffer)
  const filePath = path.join(BOOKS_DIR, `${bookId}.txt`)

  const exists = await fs
    .access(filePath)
    .then(() => true)
    .catch(() => false)
  if (!exists) {
    await fs.writeFile(filePath, buffer)
    logger.info(`Saved book: ${filePath} (${buffer.length} bytes)`)
  }
  // 记录原始文件名，之后（包括服务重启后）都能用它当产物文件夹名
  await fs
    .writeFile(
      metaPathFor(bookId),
      JSON.stringify(
        {
          fileName,
          folderName: bookFolderNameFromFile(fileName),
          uploadedAt: Date.now(),
        } satisfies BookMeta,
        null,
        2
      )
    )
    .catch((err) => logger.warn(`Failed to write book meta: ${(err as Error).message}`))

  const parsed = await parseBookFile(filePath, fileName)
  return { ...parsed, bookId }
}

/** 读取并解析已保存的小说；解析结果做内存缓存，避免每次请求都解析几十兆文本 */
const parseCache = new Map<string, ParsedBook>()

export async function parseBookFile(filePath: string, displayName?: string): Promise<ParsedBook> {
  const cached = parseCache.get(filePath)
  if (cached) return cached

  const buffer = await fs.readFile(filePath)
  const raw = buffer.toString('utf8')

  // 粗略的编码检查：GBK 文本按 UTF-8 解码会出现大量替换字符
  const badChars = (raw.match(/\uFFFD/g) || []).length
  if (badChars > raw.length * 0.001) {
    throw new Error(
      `文件「${displayName || path.basename(filePath)}」不是 UTF-8 编码（检测到 ${badChars} 个乱码字符），请先用记事本另存为 UTF-8 后再试`
    )
  }

  const started = Date.now()
  const { chapters, totalChars } = parseChapters(raw)
  const bookId = path.parse(filePath).name
  // 优先用上传时记录的原始文件名当文件夹名；老文件没有 meta 时按 bookId 还原
  const meta = await readBookMeta(bookId)
  const parsed: ParsedBook = {
    bookId,
    fileName: displayName || meta?.fileName || path.basename(filePath),
    folderName: meta?.folderName || bookFolderNameFromId(bookId),
    filePath,
    totalChars,
    chapters,
  }
  parseCache.set(filePath, parsed)
  logger.info(
    `Parsed book ${bookId}: ${chapters.length} chapters, ${totalChars} chars in ${
      Date.now() - started
    }ms`
  )
  return parsed
}

/** 列出已保存的小说 */
export async function listBooks(): Promise<
  { bookId: string; fileName: string; chapters: number; totalChars: number }[]
> {
  await ensureDir(BOOKS_DIR)
  const files = (await fs.readdir(BOOKS_DIR)).filter((f) => f.toLowerCase().endsWith('.txt'))
  const books = []
  for (const file of files) {
    try {
      const parsed = await parseBookFile(path.join(BOOKS_DIR, file))
      books.push({
        bookId: parsed.bookId,
        fileName: parsed.fileName,
        chapters: parsed.chapters.length,
        totalChars: parsed.totalChars,
      })
    } catch (err) {
      logger.warn(`Skip unparsable book ${file}: ${(err as Error).message}`)
    }
  }
  return books
}

/** 按 bookId 取回已解析的书 */
export async function getBook(bookId: string): Promise<ParsedBook | null> {
  const safeId = safeFileName(bookId)
  const filePath = path.join(BOOKS_DIR, `${safeId}.txt`)
  const exists = await fs
    .access(filePath)
    .then(() => true)
    .catch(() => false)
  if (!exists) return null
  return parseBookFile(filePath)
}
