import { Application } from 'express'
import express from 'express'

interface StaticConfig {
  audioDir: string
  srtDir: string
  publicDir: string
}

export function configureStaticFiles(
  app: Application,
  { audioDir, srtDir, publicDir }: StaticConfig
): void {
  // 音频(mp3)与字幕(srt)分别托管，扩展名不同，挂同一层根路径不会冲突
  app.use(express.static(audioDir))
  if (srtDir) app.use(express.static(srtDir))
  app.use(express.static(publicDir))
}
