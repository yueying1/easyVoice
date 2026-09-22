import { Application } from 'express'
import ttsRoutes from './tts.route'
import chapterRoutes from './chapter.route'
import history from 'connect-history-api-fallback'
import { healthHandler } from '../middleware/health.middleware'

export function setupRoutes(app: Application): void {
  app.use('/api/v1/tts', ttsRoutes)
  app.use('/api/v1/chapter', chapterRoutes)
  app.use('/api/health', healthHandler)
  app.use(history())
}
