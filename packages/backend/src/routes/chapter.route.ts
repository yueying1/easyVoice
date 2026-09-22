import { Router } from 'express'
import express from 'express'
import {
  cancelTask,
  getBookChapters,
  getBooks,
  getTask,
  getTasks,
  pauseTask,
  resumeTask,
  startTask,
  uploadBook,
} from '../controllers/chapter.controller'

const router = Router()

// 上传整本 txt：用原始二进制接收，避免几十兆文本被 JSON 转义放大（全局 json limit 是 20mb）
router.post('/upload', express.raw({ type: '*/*', limit: '100mb' }), uploadBook)

router.get('/books', getBooks)
router.get('/tasks', getTasks)
router.get('/task/:id', getTask)
router.post('/task/:id/pause', pauseTask)
router.post('/task/:id/resume', resumeTask)
router.post('/task/:id/cancel', cancelTask)

router.get('/:bookId/chapters', getBookChapters)
router.post('/:bookId/start', startTask)

export default router
