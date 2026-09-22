import fs from 'fs/promises'
import path from 'path'
import { EdgeSchema } from '../schema/generate'
import { EdgeTTS } from '../lib/node-edge-tts/edge-tts-fixed'
import { fileExist, readJson, safeRunWithRetry } from '../utils'
import { srtPathFor } from '../config'

export async function runEdgeTTS({
  text,
  pitch,
  volume,
  voice,
  rate,
  output,
  outputType = 'file',
}: Omit<EdgeSchema, 'useLLM'> & { output: string; outputType?: string }) {
  const lang = /([a-zA-Z]{2,5}-[a-zA-Z]{2,5}\b)/.exec(voice)?.[1]
  const tts = new EdgeTTS({
    voice,
    lang,
    outputFormat: 'audio-24khz-96kbitrate-mono-mp3',
    saveSubtitles: true,
    pitch,
    rate,
    volume,
    timeout: 30_000,
  })
  console.log(`run with nodejs edge-tts service...`)
  if (outputType === 'file') {
    await tts.ttsPromise(text, { audioPath: output, outputType })
    return {
      audio: output,
      srt: srtPathFor(output),
      file: '',
    }
  }
  return tts.ttsPromise(text, { audioPath: output, outputType: outputType as any })
}
/**
 * 分段合成失败后的重试间隔基数。
 * Edge 接口的 1006 断连多半是短时限流，间隔太短（默认 200ms）重试几乎必然再失败，
 * 这里调大到 1s 起，5 次尝试合计等待约 10s，实测能明显提高成功率
 */
const EDGE_RETRY_BASE_DELAY_MS = Number(process.env.EDGE_RETRY_BASE_DELAY_MS || 1000)

export const generateSingleVoice = async (
  params: Omit<EdgeSchema, 'useLLM'> & { output: string }
) => {
  let result: TTSResult = {
    audio: '',
    srt: '',
  }
  await safeRunWithRetry(
    async () => {
      result = (await runEdgeTTS({ ...params })) as TTSResult
    },
    { retries: 5, baseDelayMs: EDGE_RETRY_BASE_DELAY_MS }
  )
  return result!
}
export const generateSingleVoiceStream = async (
  params: Omit<EdgeSchema, 'useLLM'> & { output: string; outputType?: string }
) => {
  return runEdgeTTS({ ...params, outputType: 'stream' })
}

// 定义字幕数据的类型
interface Subtitle {
  part: string // 字幕文本
  start: number // 开始时间（毫秒）
  end: number // 结束时间（毫秒）
}

/**
 * 将毫秒转换为 SRT 时间格式（HH:MM:SS,MMM）
 * @param ms 毫秒数
 * @returns 格式化的时间字符串
 */
function formatTime(ms: number): string {
  const hours = Math.floor(ms / 3600000)
    .toString()
    .padStart(2, '0')
  const minutes = Math.floor((ms % 3600000) / 60000)
    .toString()
    .padStart(2, '0')
  const seconds = Math.floor((ms % 60000) / 1000)
    .toString()
    .padStart(2, '0')
  const milliseconds = (ms % 1000).toString().padStart(3, '0')
  return `${hours}:${minutes}:${seconds},${milliseconds}`
}

/**
 * 将字幕 JSON 数据转换为 SRT 格式字符串
 * @param subtitles 字幕数组
 * @returns SRT 格式的字符串
 */
function convertToSrt(subtitles: Subtitle[]): string {
  let srtContent = ''

  subtitles.forEach((subtitle, index) => {
    const startTime = formatTime(subtitle.start)
    const endTime = formatTime(subtitle.end)

    srtContent += `${index + 1}\n`
    srtContent += `${startTime} --> ${endTime}\n`
    srtContent += `${subtitle.part}\n\n`
  })

  return srtContent
}

export const jsonToSrt = async (jsonPath: string) => {
  const json = await readJson<any>(jsonPath)
  const srtResult = convertToSrt(json)
  return srtResult
}

export const generateSrt = async (jsonPath: string, srtPath: string, deleteJson = false) => {
  if (await fileExist(srtPath)) {
    console.log(`SRT file already exists at ${srtPath}`)
    return
  }
  try {
    const srtTxt = await jsonToSrt(jsonPath)
    // 字幕目录(项目根 Str)可能还不存在，写入前先确保父目录已创建
    await fs.mkdir(path.dirname(srtPath), { recursive: true })
    await fs.writeFile(srtPath, srtTxt, 'utf8')
    console.log(`SRT file created at ${srtPath}`)
    if (deleteJson) await fs.unlink(jsonPath)
    return srtPath
  } catch (err) {
    console.error(`Error reading JSON file at ${jsonPath}:`, err)
    return
  }
}
