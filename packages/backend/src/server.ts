import { createApp } from './app'
import { AUDIO_DIR, SRT_DIR, PUBLIC_DIR, RATE_LIMIT, RATE_LIMIT_WINDOW, PORT } from './config'
import { initApp } from './initApp'
import { ttsPluginManager } from './tts/pluginManager'
import { logger } from './utils/logger'

// 兜底：未捕获的错误只记录日志，避免长时间生成的服务直接退出
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception (server kept alive): ${err.stack || err.message}`)
})
process.on('unhandledRejection', (reason) => {
  logger.error(
    `Unhandled rejection (server kept alive): ${reason instanceof Error ? reason.stack : String(reason)}`
  )
})

const app = createApp({
  isDev: process.env.NODE_ENV === 'development',
  rateLimit: RATE_LIMIT,
  rateLimitWindow: RATE_LIMIT_WINDOW,
  audioDir: AUDIO_DIR,
  srtDir: SRT_DIR,
  publicDir: PUBLIC_DIR,
})

app.listen(PORT, async () => {
  // 确保项目根 audio / Str 目录存在，否则首次生成会写入失败
  await initApp()
  await ttsPluginManager.initializeEngines()
  // 全部为 ASCII 输出：Windows 控制台默认代码页下中文会乱码
  console.log(`Server running on port ${PORT}`)
  console.log(`Audio dir: ${AUDIO_DIR}`)
  console.log(`Subtitle dir: ${SRT_DIR}`)
  console.log('--------------------------------------------------')
  console.log(`Full novel (chapter by chapter): http://localhost:${PORT}/chapter`)
  console.log(`>>> Open this in your browser: http://localhost:${PORT} <<<`)
})
