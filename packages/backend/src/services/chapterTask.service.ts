import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { AUDIO_DIR, srtPathFor } from '../config'
import { asyncSleep, fileExist } from '../utils'
import { logger } from '../utils/logger'
import { Chapter, chapterFileName, getBook } from './chapter.service'
import { generateTTSWithId } from './tts.service'

/**
 * 章节批量合成任务
 *
 * 设计要点：
 * - **串行**逐章合成，章与章之间留间隔，降低被 Edge 接口限流的概率
 * - **断点续传**：开始前检查 audio/Str 里同名文件是否已存在，存在即跳过。
 *   不依赖任何状态文件，服务重启、断电后重新点「开始」就能接着跑
 * - 单章失败只记录错误并继续，不中断整个任务
 * - 中间分段文件在每章完成后立即清理，避免上万个临时文件堆积
 */

export type ChapterItemStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed'
export type ChapterTaskStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed'

export interface ChapterTaskItem {
  index: number
  title: string
  volumeTitle: string
  fileName: string
  charCount: number
  status: ChapterItemStatus
  error?: string
  srtMissing?: boolean
  durationMs?: number
  /** 当前章内的分段进度（仅合成中可见） */
  segmentDone?: number
  segmentTotal?: number
  segmentPercent?: number
  /** 当前是第几次尝试（>1 表示正在重试） */
  attempt?: number
}

export interface ChapterTask {
  id: string
  bookId: string
  bookName: string
  /**
   * 产物文件夹名（取 txt 文件名去掉扩展名）。
   * mp3 落在 `audio/<folderName>/`，字幕落在 `Str/<folderName>/`
   */
  folderName: string
  voice: string
  pitch: string
  rate: string
  volume: string
  status: ChapterTaskStatus
  items: ChapterTaskItem[]
  total: number
  done: number
  skipped: number
  failed: number
  currentIndex: number | null
  createdAt: number
  startedAt?: number
  finishedAt?: number
  message: string
}

/** 每章合成完成后的间隔，避免连续高频请求被限流 */
const CHAPTER_INTERVAL_MS = Number(process.env.CHAPTER_INTERVAL_MS || 500)
/** 单章失败后的整章重试次数（Edge 接口偶发 1006 断连，重试通常能成功） */
const CHAPTER_MAX_ATTEMPTS = Number(process.env.CHAPTER_MAX_ATTEMPTS || 2)
/** 整章重试前的等待时间 */
const CHAPTER_RETRY_DELAY_MS = Number(process.env.CHAPTER_RETRY_DELAY_MS || 8_000)
/** 章内分段并发数：长跑时比默认的 EDGE_API_LIMIT 更保守，减少被限流 */
const SEGMENT_CONCURRENCY = Number(process.env.CHAPTER_SEGMENT_CONCURRENCY || 2)

const tasks = new Map<string, ChapterTask>()
/** 同一时刻只跑一个批量任务，避免多个任务抢 Edge 接口 */
let runningTaskId: string | null = null

export interface StartChapterTaskOptions {
  bookId: string
  /** 起始章节序号（含），1 基 */
  from: number
  /** 结束章节序号（含），1 基 */
  to: number
  voice: string
  pitch?: string
  rate?: string
  volume?: string
}

/** 创建并启动批量任务 */
export async function startChapterTask(options: StartChapterTaskOptions): Promise<ChapterTask> {
  const { bookId, voice, pitch = '+0Hz', rate = '+0%', volume = '+0%' } = options
  if (runningTaskId) {
    const running = tasks.get(runningTaskId)
    if (running && running.status === 'running') {
      throw new Error(`已有批量任务正在运行（${running.id}），请先暂停或等待完成`)
    }
    runningTaskId = null
  }

  const book = await getBook(bookId)
  if (!book) throw new Error(`找不到小说文件：${bookId}`)

  const from = Math.max(1, Math.floor(options.from || 1))
  const to = Math.min(book.chapters.length, Math.floor(options.to || book.chapters.length))
  if (to < from) throw new Error(`章节范围不合法：${from} ~ ${to}`)

  const selected = book.chapters.filter((c) => c.index >= from && c.index <= to)
  if (!selected.length) throw new Error(`章节范围内没有可合成的章节：${from} ~ ${to}`)

  const task: ChapterTask = {
    id: `chapter-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    bookId,
    bookName: book.fileName,
    folderName: book.folderName,
    voice,
    pitch,
    rate,
    volume,
    status: 'pending',
    items: selected.map((c) => ({
      index: c.index,
      title: c.title,
      volumeTitle: c.volumeTitle,
      fileName: chapterFileName(c),
      charCount: c.charCount,
      status: 'pending',
    })),
    total: selected.length,
    done: 0,
    skipped: 0,
    failed: 0,
    currentIndex: null,
    createdAt: Date.now(),
    message: '任务已创建',
  }
  tasks.set(task.id, task)
  runningTaskId = task.id

  // 立即开始，不阻塞 HTTP 响应
  void runTask(task, from, to, options)
  return task
}

/** 任务是否已被要求停止（暂停/取消）。独立函数，避免 TS 对 task.status 的控制流收窄 */
function isStopped(task: ChapterTask): boolean {
  return task.status === 'paused' || task.status === 'cancelled'
}

/** 任务主循环：串行处理每一章 */
async function runTask(
  task: ChapterTask,
  from: number,
  to: number,
  options: StartChapterTaskOptions
): Promise<void> {
  task.status = 'running'
  task.startedAt = Date.now()
  task.message = '正在合成'
  logger.info(`Chapter task ${task.id} started: ${task.bookName} [${from} ~ ${to}]`)

  try {
    const book = await getBook(task.bookId)
    if (!book) throw new Error(`找不到小说文件：${task.bookId}`)
    const { pitch = '+0Hz', rate = '+0%', volume = '+0%', voice } = options

    for (const item of task.items) {
      if (isStopped(task)) break

      const chapter = book.chapters[item.index - 1] as Chapter | undefined
      if (!chapter) {
        item.status = 'failed'
        item.error = '章节不存在（可能文件已更新，请重新上传）'
        task.failed++
        continue
      }

      // 产物统一放进以 txt 文件名命名的文件夹：audio/<书名>/xxx.mp3、Str/<书名>/xxx.srt
      const relPath = path.join(task.folderName, item.fileName)
      const mp3Path = path.join(AUDIO_DIR, relPath)
      const srtPath = srtPathFor(mp3Path)

      // 断点续传：音频和字幕都已存在则直接跳过
      if ((await fileExist(mp3Path)) && (await fileExist(srtPath))) {
        item.status = 'skipped'
        task.skipped++
        task.message = `跳过已完成：${item.fileName}`
        continue
      }

      item.status = 'running'
      task.currentIndex = item.index
      const started = Date.now()
      task.message = `正在合成第 ${item.index} 章：${item.title}`
      logger.info(`[${task.id}] synthesizing ${item.index}/${task.total}: ${item.fileName}`)

      let lastError: Error | null = null
      for (let attempt = 1; attempt <= CHAPTER_MAX_ATTEMPTS; attempt++) {
        try {
          await generateTTSWithId({
            text: chapter.text,
            voice,
            pitch,
            rate,
            volume,
            outputId: relPath,
            useCache: false,
            cleanupTmp: true,
            // 严格模式：任一分段失败就整章重来，绝不产出缺内容的音频
            strictSegments: true,
            // 长跑时降低章内并发，减少 Edge 接口 1006 断连
            segmentConcurrency: SEGMENT_CONCURRENCY,
            onSegmentProgress: (percent, handled, total) => {
              item.segmentPercent = percent
              item.segmentDone = handled
              item.segmentTotal = total
              item.attempt = attempt
              const retry = attempt > 1 ? `（第 ${attempt} 次尝试）` : ''
              task.message = `正在合成第 ${item.index} 章${retry}（${handled}/${total} 段）：${item.title}`
            },
          })
          // 短章节走 buildSegment，字幕由延迟任务生成；这里等它落盘
          const srtOk = await waitForFile(srtPath, 8_000)
          item.srtMissing = !srtOk
          if (!srtOk) {
            logger.warn(`[${task.id}] subtitle missing for ${item.fileName}`)
          }
          lastError = null
          break
        } catch (err) {
          lastError = err as Error
          logger.warn(
            `[${task.id}] chapter ${item.index} attempt ${attempt}/${CHAPTER_MAX_ATTEMPTS} failed: ${lastError.message}`
          )
          if (attempt < CHAPTER_MAX_ATTEMPTS) await asyncSleep(CHAPTER_RETRY_DELAY_MS)
        }
      }

      if (lastError) {
        item.status = 'failed'
        item.error = lastError.message
        task.failed++
        logger.error(`[${task.id}] chapter ${item.index} failed: ${item.error}`)
      } else {
        item.status = 'done'
        task.done++
      }
      item.durationMs = Date.now() - started
      item.segmentDone = undefined
      item.segmentTotal = undefined
      item.segmentPercent = undefined
      item.attempt = undefined
      // 清理残留的字幕源 json（多段章节的中间文件已在 buildSegmentList 里清掉）
      await cleanupChapterArtifacts(relPath)

      await asyncSleep(CHAPTER_INTERVAL_MS)
    }

    if (task.status === 'running') {
      task.status = 'completed'
    }
    task.message =
      task.status === 'completed'
        ? `完成：成功 ${task.done} 章，跳过 ${task.skipped} 章，失败 ${task.failed} 章`
        : task.message
  } catch (err) {
    task.status = 'failed'
    task.message = (err as Error).message
    logger.error(`Chapter task ${task.id} failed: ${task.message}`)
  } finally {
    task.finishedAt = Date.now()
    task.currentIndex = null
    if (runningTaskId === task.id) runningTaskId = null
    logger.info(
      `Chapter task ${task.id} ${task.status}: done=${task.done} skipped=${task.skipped} failed=${task.failed}`
    )
  }
}

/**
 * 删除单章合成残留的中间文件（字幕源 json、可能残留的分段目录）
 * @param relPath 相对 audio 目录的路径，含书名文件夹，如 `蛊真人/0002_xxx.mp3`
 */
async function cleanupChapterArtifacts(relPath: string): Promise<void> {
  const mp3Path = path.join(AUDIO_DIR, relPath)
  const tmpDir = path.join(AUDIO_DIR, relPath.replace(/\.mp3$/i, ''))
  await fs.rm(`${mp3Path}.json`, { force: true }).catch(() => undefined)
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
}

/** 轮询等待文件出现 */
async function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fileExist(filePath)) return true
    await asyncSleep(200)
  }
  return fileExist(filePath)
}

export function getChapterTask(taskId: string): ChapterTask | null {
  return tasks.get(taskId) || null
}

export function listChapterTasks(): ChapterTask[] {
  return Array.from(tasks.values()).sort((a, b) => b.createdAt - a.createdAt)
}

/** 暂停：当前章合成完后停下 */
export function pauseChapterTask(taskId: string): ChapterTask {
  const task = tasks.get(taskId)
  if (!task) throw new Error(`找不到任务：${taskId}`)
  if (task.status === 'running') {
    task.status = 'paused'
    task.message = '已暂停（当前章节合成完后停止）'
  }
  return task
}

/** 取消：当前章合成完后停止，不再继续 */
export function cancelChapterTask(taskId: string): ChapterTask {
  const task = tasks.get(taskId)
  if (!task) throw new Error(`找不到任务：${taskId}`)
  if (task.status === 'running' || task.status === 'paused') {
    task.status = 'cancelled'
    task.message = '已取消'
    if (runningTaskId === taskId) runningTaskId = null
  }
  return task
}

/**
 * 继续任务：把未完成的章节重新排队并接着跑。
 * 已完成（含上次运行成功/失败）的章节会重新检查磁盘文件，已存在的自动跳过
 */
export async function resumeChapterTask(taskId: string): Promise<ChapterTask> {
  const task = tasks.get(taskId)
  if (!task) throw new Error(`找不到任务：${taskId}`)
  if (task.status === 'running') return task
  if (runningTaskId) {
    const running = tasks.get(runningTaskId)
    if (running && running.status === 'running') {
      throw new Error(`已有批量任务正在运行（${running.id}），请先暂停`)
    }
  }

  const pending = task.items.filter((i) => i.status !== 'done' && i.status !== 'skipped')
  if (!pending.length) {
    task.message = '没有需要处理的章节'
    return task
  }
  // 重新扫描磁盘：之前失败的章节如果文件已存在，会被跳过
  pending.forEach((i) => {
    i.status = 'pending'
    i.error = undefined
  })
  task.status = 'pending'
  task.message = '重新排队中'
  runningTaskId = task.id

  const indices = task.items.map((i) => i.index)
  void runTask(task, Math.min(...indices), Math.max(...indices), {
    bookId: task.bookId,
    from: Math.min(...indices),
    to: Math.max(...indices),
    voice: task.voice,
    pitch: task.pitch,
    rate: task.rate,
    volume: task.volume,
  })
  return task
}

/** 当前是否有任务在跑（前端用来禁用按钮） */
export function getRunningTaskId(): string | null {
  return runningTaskId
}
