import { Request, Response, NextFunction } from 'express'
import { logger } from '../utils/logger'
import { getBook, listBooks, saveBook } from '../services/chapter.service'
import {
  cancelChapterTask,
  getChapterTask,
  getRunningTaskId,
  listChapterTasks,
  pauseChapterTask,
  resumeChapterTask,
  startChapterTask,
} from '../services/chapterTask.service'

/**
 * 小说章节批量合成接口
 * - POST /upload            上传整本 txt（原始二进制），解析出章节列表
 * - GET  /books             已上传的小说
 * - GET  /:bookId/chapters  分页取章节列表
 * - POST /:bookId/start     按章节范围开始批量合成
 * - GET  /tasks             任务列表
 * - GET  /task/:id          单个任务进度
 * - POST /task/:id/pause    暂停
 * - POST /task/:id/resume   继续（已生成的章节自动跳过）
 * - POST /task/:id/cancel   取消
 */

/** 音色/语速等参数格式校验，避免把非法值传给 Edge-TTS */
function formatVoiceParams(body: any) {
  const positivePercent = (value: unknown, fallback: string) => {
    if (typeof value !== 'string' || !value) return fallback
    return value
  }
  const positiveHz = (value: unknown, fallback: string) => {
    if (typeof value !== 'string' || !value) return fallback
    return value
  }
  return {
    voice: String(body?.voice || 'zh-CN-YunxiNeural'),
    pitch: positiveHz(body?.pitch, '+0Hz'),
    rate: positivePercent(body?.rate, '+0%'),
    volume: positivePercent(body?.volume, '+0%'),
  }
}

export async function uploadBook(req: Request, res: Response, next: NextFunction) {
  try {
    const buffer = req.body as Buffer
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
      res.status(400).json({ code: 400, success: false, message: '没有收到文件内容' })
      return
    }
    const rawName = req.headers['x-book-name']
    let fileName = 'book.txt'
    if (typeof rawName === 'string' && rawName) {
      try {
        fileName = decodeURIComponent(rawName)
      } catch {
        fileName = rawName
      }
    }

    const parsed = await saveBook(fileName, buffer)
    logger.info(
      `Uploaded book ${parsed.bookId}: ${parsed.chapters.length} chapters, ${parsed.totalChars} chars`
    )
    res.json({
      code: 200,
      success: true,
      data: {
        bookId: parsed.bookId,
        fileName: parsed.fileName,
        chapterCount: parsed.chapters.length,
        totalChars: parsed.totalChars,
        /** 前 50 章预览，完整列表走 /:bookId/chapters 分页接口 */
        chapters: parsed.chapters.slice(0, 50).map((c) => ({
          index: c.index,
          volumeTitle: c.volumeTitle,
          volumeName: c.volumeName,
          title: c.title,
          charCount: c.charCount,
        })),
      },
    })
  } catch (error) {
    next(error)
  }
}

export async function getBooks(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ code: 200, success: true, data: await listBooks() })
  } catch (error) {
    next(error)
  }
}

export async function getBookChapters(req: Request, res: Response, next: NextFunction) {
  try {
    const book = await getBook(req.params.bookId)
    if (!book) {
      res.status(404).json({ code: 404, success: false, message: '找不到这本小说' })
      return
    }
    const from = Math.max(1, parseInt(String(req.query.from || '1'), 10) || 1)
    const size = Math.min(500, Math.max(1, parseInt(String(req.query.size || '100'), 10) || 100))
    const to = Math.min(book.chapters.length, from + size - 1)
    res.json({
      code: 200,
      success: true,
      data: {
        bookId: book.bookId,
        fileName: book.fileName,
        chapterCount: book.chapters.length,
        totalChars: book.totalChars,
        from,
        to,
        chapters: book.chapters.slice(from - 1, to).map((c) => ({
          index: c.index,
          volumeTitle: c.volumeTitle,
          volumeName: c.volumeName,
          title: c.title,
          charCount: c.charCount,
        })),
      },
    })
  } catch (error) {
    next(error)
  }
}

export async function startTask(req: Request, res: Response, next: NextFunction) {
  try {
    const bookId = String(req.params.bookId)
    const { from, to } = req.body || {}
    const { voice, pitch, rate, volume } = formatVoiceParams(req.body)
    const task = await startChapterTask({
      bookId,
      from: parseInt(String(from), 10) || 1,
      to: parseInt(String(to), 10) || Number.MAX_SAFE_INTEGER,
      voice,
      pitch,
      rate,
      volume,
    })
    res.json({ code: 200, success: true, data: task })
  } catch (error) {
    // 业务错误（如已有任务在跑）直接返回 400，便于前端提示
    const message = (error as Error).message
    logger.warn(`startTask failed: ${message}`)
    res.status(400).json({ code: 400, success: false, message })
  }
}

export async function getTasks(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json({
      code: 200,
      success: true,
      data: { runningTaskId: getRunningTaskId(), tasks: listChapterTasks() },
    })
  } catch (error) {
    next(error)
  }
}

export async function getTask(req: Request, res: Response, next: NextFunction) {
  try {
    const task = getChapterTask(String(req.params.id))
    if (!task) {
      res.status(404).json({ code: 404, success: false, message: '找不到任务' })
      return
    }
    res.json({ code: 200, success: true, data: task })
  } catch (error) {
    next(error)
  }
}

export async function pauseTask(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ code: 200, success: true, data: pauseChapterTask(String(req.params.id)) })
  } catch (error) {
    res.status(400).json({ code: 400, success: false, message: (error as Error).message })
  }
}

export async function resumeTask(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ code: 200, success: true, data: await resumeChapterTask(String(req.params.id)) })
  } catch (error) {
    res.status(400).json({ code: 400, success: false, message: (error as Error).message })
  }
}

export async function cancelTask(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ code: 200, success: true, data: cancelChapterTask(String(req.params.id)) })
  } catch (error) {
    res.status(400).json({ code: 400, success: false, message: (error as Error).message })
  }
}
