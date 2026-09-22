import axios from 'axios'

const DEV_URL = 'http://localhost:3000/api/v1/chapter'
const PROD_URL = import.meta.env.VITE_API_URL
  ? String(import.meta.env.VITE_API_URL).replace(/\/tts\/?$/, '/chapter')
  : '/api/v1/chapter'
const baseURL = import.meta.env.MODE === 'development' ? DEV_URL : PROD_URL

const api = axios.create({
  baseURL,
  timeout: 60000,
})

export interface ChapterSummary {
  index: number
  volumeTitle: string
  volumeName: string
  title: string
  charCount: number
}

export interface BookInfo {
  bookId: string
  fileName: string
  chapterCount: number
  totalChars: number
  chapters: ChapterSummary[]
}

export interface ChapterItem {
  index: number
  title: string
  volumeTitle: string
  fileName: string
  charCount: number
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed'
  error?: string
  srtMissing?: boolean
  durationMs?: number
  segmentDone?: number
  segmentTotal?: number
  segmentPercent?: number
  attempt?: number
}

export interface ChapterTaskInfo {
  id: string
  bookId: string
  bookName: string
  /** 产物文件夹名（txt 文件名去掉扩展名）：mp3 在 audio/<folderName>/，字幕在 Str/<folderName>/ */
  folderName: string
  voice: string
  status: 'pending' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed'
  items: ChapterItem[]
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

interface Wrapper<T> {
  code: number
  success: boolean
  message?: string
  data: T
}

/** 上传整本 txt（原始二进制，避免几十兆文本被 JSON 转义放大） */
export const uploadBook = async (file: File, onProgress?: (percent: number) => void) => {
  const res = await api.post<Wrapper<BookInfo>>('/upload', file, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-book-name': encodeURIComponent(file.name),
    },
    // 几十兆文件 + 解析，不能按默认 60s 超时
    timeout: 0,
    onUploadProgress: (e) => {
      if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100))
    },
  })
  if (!res.data?.success) throw new Error(res.data?.message || '解析小说失败')
  return res.data.data
}

export const getBooks = async () => {
  const res = await api.get<Wrapper<{ bookId: string; fileName: string; chapters: number }[]>>(
    '/books'
  )
  return res.data.data
}

export const getBookChapters = async (bookId: string, from = 1, size = 50) => {
  const res = await api.get<
    Wrapper<{
      bookId: string
      fileName: string
      chapterCount: number
      totalChars: number
      from: number
      to: number
      chapters: ChapterSummary[]
    }>
  >(`/${encodeURIComponent(bookId)}/chapters`, { params: { from, size } })
  return res.data.data
}

export const startChapterTask = async (
  bookId: string,
  params: { from: number; to: number; voice: string; rate?: string; pitch?: string; volume?: string }
) => {
  const res = await api.post<Wrapper<ChapterTaskInfo>>(`/${encodeURIComponent(bookId)}/start`, params)
  if (!res.data?.success) throw new Error(res.data?.message || '启动失败')
  return res.data.data
}

export const getChapterTasks = async () => {
  const res = await api.get<Wrapper<{ runningTaskId: string | null; tasks: ChapterTaskInfo[] }>>(
    '/tasks'
  )
  return res.data.data
}

export const getChapterTask = async (taskId: string) => {
  const res = await api.get<Wrapper<ChapterTaskInfo>>(`/task/${encodeURIComponent(taskId)}`)
  return res.data.data
}

export const pauseChapterTask = async (taskId: string) => {
  const res = await api.post<Wrapper<ChapterTaskInfo>>(`/task/${encodeURIComponent(taskId)}/pause`)
  return res.data.data
}

export const resumeChapterTask = async (taskId: string) => {
  const res = await api.post<Wrapper<ChapterTaskInfo>>(`/task/${encodeURIComponent(taskId)}/resume`)
  return res.data.data
}

export const cancelChapterTask = async (taskId: string) => {
  const res = await api.post<Wrapper<ChapterTaskInfo>>(`/task/${encodeURIComponent(taskId)}/cancel`)
  return res.data.data
}
