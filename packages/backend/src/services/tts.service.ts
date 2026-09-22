import path from 'path'
import fs from 'fs/promises'
import ffmpeg from 'fluent-ffmpeg'
import { AUDIO_DIR, STATIC_DOMAIN, EDGE_API_LIMIT, srtPathFor } from '../config'
import { logger } from '../utils/logger'
import { getPrompt } from '../llm/prompt/generateSegment'
import { ensureDir, generateId, getLangConfig, readJson } from '../utils'
import { openai } from '../utils/openai'
import { splitText } from './text.service'
import { generateSingleVoice, generateSrt } from './edge-tts.service'
import { EdgeSchema } from '../schema/generate'
import { MapLimitController } from '../controllers/concurrency.controller'
import audioCacheInstance from './audioCache.service'
import { mergeSubtitleFiles, SubtitleFile, SubtitleFiles } from '../utils/subtitle'
import taskManager, { Task } from '../utils/taskManager'
import { handleSrt } from './tts.stream.service'

// 错误消息枚举
export enum ErrorMessages {
  ENG_MODEL_INVALID_TEXT = 'English model cannot process non-English text',
  API_FETCH_FAILED = 'Failed to fetch TTS parameters from API',
  INVALID_API_RESPONSE = 'Invalid API response: no TTS parameters returned',
  PARAMS_PARSE_FAILED = 'Failed to parse TTS parameters',
  INVALID_PARAMS_FORMAT = 'Invalid TTS parameters format',
  TTS_GENERATION_FAILED = 'TTS generation failed',
  INCOMPLETE_RESULT = 'Incomplete TTS result',
}

/** ffmpeg 拼接单章音频的超时上限，超时即视为失败，避免批量任务卡死在一个章节上 */
const CONCAT_TIMEOUT_MS = Number(process.env.CONCAT_TIMEOUT_MS || 180_000)

/**
 * 生成文本转语音 (TTS) 的音频和字幕
 */
export async function generateTTS(params: Required<EdgeSchema>, task?: Task): Promise<TTSResult> {
  const { text, pitch, voice, rate, volume, useLLM } = params
  // 检查缓存
  const cacheKey = taskManager.generateTaskId({ text, pitch, voice, rate, volume })
  const cache = await audioCacheInstance.getAudio(cacheKey)
  if (cache) {
    logger.info(`Cache hit: ${voice} ${text.slice(0, 10)}`)
    return cache
  }

  const segment: Segment = { id: generateId(`${useLLM ? 'aigen-' : voice}`, text), text }
  const { lang, voiceList } = await getLangConfig(segment.text)
  logger.debug(`Language detected lang: `, lang)
  validateLangAndVoice(lang, voice)

  let result: TTSResult
  if (useLLM) {
    result = await generateWithLLM(segment, voiceList, lang, task)
  } else {
    result = await generateWithoutLLM(
      segment,
      {
        text,
        pitch,
        voice,
        rate,
        volume,
        output: segment.id,
      },
      task
    )
  }

  // 验证结果并缓存
  validateTTSResult(result, segment.id)
  logger.info(`Generated audio succeed: `, result)
  if (result.partial) {
    logger.warn(`Partial result detected, some splits generated audio failed!`)
  } else {
    await audioCacheInstance.setAudio(cacheKey, { ...params, ...result })
  }
  return result
}

/**
 * 使用 LLM 生成 TTS
 */
async function generateWithLLM(
  segment: Segment,
  voiceList: VoiceConfig[],
  lang: string,
  task?: Task
): Promise<TTSResult> {
  const { text, id } = segment
  const { length, segments } = splitText(text.trim())
  const formatLlmSegments = (llmSegments: any) =>
    llmSegments
      .filter((segment: any) => segment.text)
      .map((segment: any) => ({
        ...segment,
        voice: segment.name,
      }))
  if (length <= 1) {
    const prompt = getPrompt(lang, voiceList, segments[0])
    // logger.debug(`Prompt for LLM: ${prompt}`)
    const llmResponse = await fetchLLMSegment(prompt)
    let llmSegments = llmResponse?.result || llmResponse?.segments || []
    if (!Array.isArray(llmSegments)) {
      task?.endTask?.(task.id)
      throw new Error(
        'LLM response is not an array, please switch to Edge TTS mode or use another model'
      )
    }
    const result = await buildSegmentList(segment, formatLlmSegments(llmSegments), task)
    task?.updateProgress?.(task.id, 100)
    return result
  } else {
    logger.info('Splitting text into multiple segments:', segments.length)
    let finalSegments = []
    let count = 0
    const getProgress = () => {
      return Number(((count / segments.length) * 100).toFixed(2))
    }
    for (let seg of segments) {
      count++
      const prompt = getPrompt(lang, voiceList, seg)
      // logger.debug(`Prompt for LLM: ${prompt}`)
      const llmResponse = await fetchLLMSegment(prompt)
      let llmSegments = llmResponse?.result || llmResponse?.segments || []
      if (!Array.isArray(llmSegments)) {
        throw new Error(
          'LLM response is not an array, please switch to Edge TTS mode or use another model'
        )
      }
      const result = await buildSegmentList(
        { ...segment, id: `[segments:${count}]${segment.id}` },
        formatLlmSegments(llmSegments)
      )
      task?.updateProgress?.(task.id, getProgress())
      finalSegments.push(result)
    }
    return await buildFinal(finalSegments, id)
  }
}
const buildFinal = async (finalSegments: TTSResult[], id: string) => {
  const subtitleFiles: SubtitleFiles = await Promise.all(
    finalSegments.map((file) => {
      const base = path.basename(file.audio)
      const jsonPath = path.resolve(AUDIO_DIR, base.replace('.mp3', ''), 'all_splits.mp3.json')
      return readJson<SubtitleFile>(jsonPath)
    })
  )

  const mergedJson = mergeSubtitleFiles(subtitleFiles)
  const finalDir = path.resolve(AUDIO_DIR, id.replace('.mp3', ''))
  await ensureDir(finalDir)
  const finalJson = path.resolve(finalDir, '[merged]all_splits.mp3.json')
  await fs.writeFile(finalJson, JSON.stringify(mergedJson, null, 2))
  await generateSrt(finalJson, srtPathFor(path.resolve(AUDIO_DIR, id)))
  const fileList = finalSegments.map((segment) =>
    path.resolve(AUDIO_DIR, path.parse(segment.audio).base)
  )
  const outputFile = path.resolve(AUDIO_DIR, id)
  await concatDirAudio({ inputDir: finalDir, fileList, outputFile })
  return {
    audio: `${STATIC_DOMAIN}/${id}`,
    srt: `${STATIC_DOMAIN}/${id.replace('.mp3', '.srt')}`,
  }
}
/**
 * 不使用 LLM 生成 TTS
 */
async function generateWithoutLLM(
  segment: Segment,
  params: TTSParams,
  task?: Task,
  options: GenerateOptions = {}
): Promise<TTSResult> {
  const { text, pitch, voice, rate, volume } = params
  const { length, segments } = splitText(text)

  if (length <= 1) {
    return buildSegment(segment, params)
  } else {
    const buildSegments = segments.map((segment) => ({ ...params, text: segment }))
    let result = await buildSegmentList(segment, buildSegments, task, options)
    task?.updateProgress?.(task.id, 100)
    return result
  }
}

export interface GenerateOptions {
  /** 是否使用分段音频缓存（章节批量合成时建议关闭，避免命中已清理的旧分段路径） */
  useCache?: boolean
  /** 合成完成后是否删除分段临时目录（章节批量合成时开启，避免上万个中间文件堆积） */
  cleanupTmp?: boolean
  /** 严格模式：任一分段失败就整章判失败，避免静默产出缺内容的音频 */
  strictSegments?: boolean
  /** 章内分段并发数（默认 EDGE_API_LIMIT；批量长跑时调低更稳，减少被限流断连） */
  segmentConcurrency?: number
  /** 分段进度回调（批量合成时用于显示「第 n/N 段」） */
  onSegmentProgress?: (percent: number, handled: number, total: number) => void
}

/**
 * 用指定的输出文件名生成音频与字幕（章节批量合成用，绕开按文本自动命名的逻辑）
 * @param params.outputId 输出文件名，如 `0002_第一卷_第一节：纵身亡魔心仍不悔.mp3`
 */
export async function generateTTSWithId(
  params: Omit<Required<EdgeSchema>, 'useLLM'> & { outputId: string } & GenerateOptions
): Promise<TTSResult> {
  const {
    text,
    pitch,
    voice,
    rate,
    volume,
    outputId,
    useCache = false,
    cleanupTmp = false,
    strictSegments = false,
    segmentConcurrency,
    onSegmentProgress,
  } = params
  const segment: Segment = { id: outputId, text }
  const result = await generateWithoutLLM(
    segment,
    { text, pitch, voice, rate, volume, output: outputId },
    undefined,
    { useCache, cleanupTmp, strictSegments, segmentConcurrency, onSegmentProgress }
  )
  validateTTSResult(result, outputId)
  return result
}

/**
 * 生成单个片段的音频和字幕
 */
async function buildSegment(
  segment: Segment,
  params: TTSParams,
  dir: string = ''
): Promise<TTSResult> {
  const { id, text } = segment
  const { pitch, voice, rate, volume } = params
  const output = path.resolve(AUDIO_DIR, dir, id)
  const result = await generateSingleVoice({
    text,
    pitch,
    voice,
    rate,
    volume,
    output,
  })
  logger.info('Generated single segment:', result)
  setTimeout(() => {
    handleSrt(output, false)
  }, 200)
  return {
    audio: `${STATIC_DOMAIN}/${path.join(dir, id)}`,
    srt: `${STATIC_DOMAIN}/${path.join(dir, id.replace('.mp3', '.srt'))}`,
  }
}

/**
 * 生成多个片段并合并的 TTS
 */
async function buildSegmentList(
  segment: Segment,
  segments: BuildSegment[],
  task?: Task,
  options: GenerateOptions = {}
): Promise<TTSResult> {
  const {
    useCache = true,
    cleanupTmp = false,
    strictSegments = false,
    segmentConcurrency,
    onSegmentProgress,
  } = options
  const fileList: string[] = []
  const length = segments.length
  let handledLength = 0

  if (!length) {
    throw new Error(`No segments found for task ${task?.id || 'unknown'}!`)
  }
  const { id } = segment
  const tmpDirName = id.replace('.mp3', '')
  const tmpDirPath = path.resolve(AUDIO_DIR, tmpDirName)
  await ensureDir(tmpDirPath)
  await fs.writeFile(
    path.resolve(tmpDirPath, 'ai-segments.json'),
    JSON.stringify(segments, null, 2)
  )
  const getProgress = () => {
    return Number((((handledLength / length) * 100) / (id.includes('segment') ? 2 : 1)).toFixed(2))
  }
  const tasks = segments.map((segment, index) => async () => {
    const { text, pitch, voice, rate, volume } = segment
    const output = path.resolve(tmpDirPath, `${index + 1}_splits.mp3`)
    const cacheKey = taskManager.generateTaskId({ text, pitch, voice, rate, volume })
    if (useCache) {
      const cache = await audioCacheInstance.getAudio(cacheKey)
      if (cache) {
        logger.info(`Cache hit[segments]: ${voice} ${text.slice(0, 10)}`)
        fileList.push(cache.audio)
        return cache
      }
    }
    const result = await generateSingleVoice({ text, pitch, voice, rate, volume, output })
    logger.debug(`Cache miss and generate audio: ${result.audio}, ${result.srt}`)
    fileList.push(result.audio)
    handledLength++
    task?.updateProgress?.(task.id, getProgress())
    onSegmentProgress?.(getProgress(), handledLength, length)
    if (useCache) {
      const params = { text, pitch, voice, rate, volume }
      await audioCacheInstance.setAudio(cacheKey, { ...params, ...result })
    }
    return result
  })
  let partial = false
  const results = await runConcurrentTasks(tasks, segmentConcurrency || EDGE_API_LIMIT)
  const failed = (results || []).filter((result) => !result?.success)
  if (failed.length) {
    logger.warn(`Partial result detected, some splits generated audio failed!`, results)
    partial = true
  }
  const outputFile = path.resolve(AUDIO_DIR, id)
  // 严格模式（章节批量合成）：有分段失败就整章失败，让这一章下次重跑，
  // 避免拼出缺内容的音频却被当成"已完成"而永远跳过
  if (strictSegments && failed.length) {
    const reasons = failed
      .map((r) => (r?.error instanceof Error ? r.error.message : r?.error))
      .filter(Boolean)
      .slice(0, 3)
      .join('; ')
    if (cleanupTmp) {
      await fs.rm(tmpDirPath, { recursive: true, force: true }).catch(() => undefined)
    }
    throw new Error(`${failed.length}/${length} 个分段合成失败：${reasons || '未知原因'}`)
  }
  logger.debug(`Concatenating audio files from ${tmpDirPath} to ${outputFile}`)
  await concatDirAudio({ inputDir: tmpDirPath, fileList, outputFile })
  await concatDirSrt({ inputDir: tmpDirPath, fileList, outputFile })
  logger.debug(
    `Concatenating SRT files from ${tmpDirPath} to ${outputFile.replace('.mp3', '.srt')}`
  )
  if (cleanupTmp) {
    await fs.rm(tmpDirPath, { recursive: true, force: true }).catch((err) => {
      logger.warn(`Failed to clean tmp dir ${tmpDirPath}: ${(err as Error).message}`)
    })
  }

  return {
    audio: `${STATIC_DOMAIN}/${id}`,
    srt: `${STATIC_DOMAIN}/${id.replace('.mp3', '.srt')}`,
    partial,
  }
}

/**
 * 并发执行任务
 */
async function runConcurrentTasks(tasks: (() => Promise<any>)[], limit: number): Promise<any[]> {
  logger.debug(`Running ${tasks.length} tasks with a limit of ${limit}`)
  const controller = new MapLimitController(tasks, limit, () =>
    logger.info('All concurrent tasks completed')
  )
  const { results, cancelled } = await controller.run()
  logger.info(`Tasks completed: ${results.length}, cancelled: ${cancelled}`)
  logger.debug(`Task results:`, results)
  return results
}

/**
 * 验证语言和语音参数
 */
function validateLangAndVoice(lang: string, voice: string): void {
  if (lang !== 'eng' && voice.startsWith('en')) {
    throw new Error(ErrorMessages.ENG_MODEL_INVALID_TEXT)
  }
}

/**
 * 从 LLM 获取分段参数
 */
async function fetchLLMSegment(prompt: string): Promise<any> {
  const response = await openai.createChatCompletion({
    messages: [
      {
        role: 'system',
        content: 'You are a helpful assistant. And you can return valid json object',
      },
      { role: 'user', content: prompt },
    ],
    // temperature: 0.7,
    // max_tokens: 500,
    response_format: { type: 'json_object' },
  })

  if (!response.choices[0].message.content) {
    throw new Error(ErrorMessages.INVALID_API_RESPONSE)
  }
  return parseLLMResponse(response)
}

/**
 * 解析 LLM 响应
 */
function parseLLMResponse(response: any): TTSParams {
  const params = JSON.parse(response.choices[0].message.content) as TTSParams
  if (!params || typeof params !== 'object') {
    throw new Error(ErrorMessages.INVALID_PARAMS_FORMAT)
  }
  return params
}

/**
 * 验证 TTS 结果
 */
function validateTTSResult(result: TTSResult, segmentId: string): void {
  if (!result.audio) {
    throw new Error(`${ErrorMessages.INCOMPLETE_RESULT} for segment ${segmentId}`)
  }
}

/**
 * 拼接音频文件
 */
export async function concatDirAudio({
  fileList,
  outputFile,
  inputDir,
}: ConcatAudioParams): Promise<void> {
  const mp3Files = sortAudioDir(fileList, '.mp3')
  if (!mp3Files.length) throw new Error('No MP3 files found in input directory')

  const tempListPath = path.resolve(inputDir, 'file_list.txt')
  await fs.writeFile(tempListPath, mp3Files.map((file) => `file '${file}'`).join('\n'))

  await new Promise<void>((resolve, reject) => {
    let settled = false
    // ffmpeg 若无法启动（或异常挂起），fluent-ffmpeg 不一定触发 error 事件，
    // promise 会永远不落地；这里加超时兜底，保证批量任务不会卡死在某一章
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`Concat audio timeout after ${CONCAT_TIMEOUT_MS}ms: ${outputFile}`))
    }, CONCAT_TIMEOUT_MS)
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      err ? reject(err) : resolve()
    }
    ffmpeg()
      .input(tempListPath)
      .inputFormat('concat')
      .inputOption('-safe', '0')
      .audioCodec('copy')
      .output(outputFile)
      .on('end', () => finish())
      .on('error', (err) => finish(new Error(`Concat failed: ${err.message}`)))
      .run()
  })
}

/**
 * 拼接字幕文件
 */
export async function concatDirSrt({
  fileList,
  outputFile,
  inputDir,
}: ConcatAudioParams): Promise<void> {
  const jsonFiles = sortAudioDir(
    fileList.map((file) => `${file}.json`),
    '.json'
  )
  if (!jsonFiles.length) throw new Error('No JSON files found for subtitles')

  const subtitleFiles: SubtitleFiles = await Promise.all(
    jsonFiles.map((file) => readJson<SubtitleFile>(file))
  )
  const mergedJson = mergeSubtitleFiles(subtitleFiles)
  const tempJsonPath = path.resolve(inputDir, 'all_splits.mp3.json')
  await fs.writeFile(tempJsonPath, JSON.stringify(mergedJson, null, 2))
  await generateSrt(tempJsonPath, srtPathFor(outputFile))
}

/**
 * 按文件名排序音频文件
 */
function sortAudioDir(fileList: string[], ext: string = '.mp3'): string[] {
  return fileList
    .filter((file) => path.extname(file).toLowerCase() === ext)
    .sort(
      (a, b) => Number(path.parse(a).name.split('_')[0]) - Number(path.parse(b).name.split('_')[0])
    )
}

export interface ConcatAudioParams {
  fileList: string[]
  outputFile: string
  inputDir: string
}
