<template>
  <div class="chapter-page">
    <el-card class="card upload-card">
      <template #header>
        <div class="card-header">
          <span>整本小说 · 按章节批量合成</span>
          <span class="hint">每章生成一个 mp3 + 一个字幕，文件名带序号，可直接拖入 txt</span>
        </div>
      </template>

      <el-upload
        v-if="!book"
        drag
        action="#"
        :auto-upload="false"
        :on-change="handleFile"
        :show-file-list="false"
        accept=".txt"
      >
        <el-icon class="el-icon--upload"><upload-filled /></el-icon>
        <div class="el-upload__text">把小说 txt 拖到这里，或 <em>点击选择文件</em></div>
        <template #tip>
          <div class="el-upload__tip">
            支持 UTF-8 编码的 .txt，会自动识别「第一卷 / 第一节：xxx」这类章节结构
          </div>
        </template>
      </el-upload>

      <div v-else class="book-info">
        <div class="book-title">《{{ book.fileName }}》</div>
        <div class="book-meta">
          共 <b>{{ book.chapterCount }}</b> 章 ·
          <b>{{ (book.totalChars / 10000).toFixed(1) }}</b> 万字 · 预计音频约
          <b>{{ estimatedHours }}</b> 小时
        </div>
        <el-button size="small" @click="reset">重新选择文件</el-button>
      </div>

      <div v-if="uploading" class="upload-progress">
        <el-progress :percentage="uploadPercent" :stroke-width="12" />
        <div class="hint">正在上传并解析章节…（几十兆文件约 1 秒）</div>
      </div>
    </el-card>

    <el-card v-if="book" class="card config-card">
      <template #header><span>合成设置</span></template>

      <el-form label-width="90px" label-position="left">
        <el-form-item label="音色">
          <el-select v-model="voice" filterable placeholder="选择音色" style="width: 100%">
            <el-option
              v-for="v in voiceList"
              :key="v.Name"
              :label="`${v.Name}（${v.Gender === 'Female' ? '女' : '男'}）`"
              :value="v.Name"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="章节范围">
          <div class="range-row">
            <el-input-number v-model="from" :min="1" :max="book.chapterCount" size="small" />
            <span class="range-sep">~</span>
            <el-input-number v-model="to" :min="1" :max="book.chapterCount" size="small" />
            <el-button size="small" @click="setRange(10)">前 10 章</el-button>
            <el-button size="small" @click="setRange(20)">前 20 章</el-button>
            <el-button size="small" @click="setRange(book.chapterCount)">全部</el-button>
          </div>
        </el-form-item>

        <el-form-item label=" ">
          <el-button
            type="primary"
            :loading="starting"
            :disabled="busy"
            @click="handleStart"
          >
            开始生成（{{ selectedCount }} 章）
          </el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card v-if="task" class="card progress-card">
      <template #header>
        <div class="card-header">
          <span>生成进度</span>
          <el-tag :type="statusTagType" size="small">{{ statusText }}</el-tag>
        </div>
      </template>

      <el-progress
        :percentage="overallPercent"
        :stroke-width="16"
        :status="task.status === 'failed' ? 'exception' : undefined"
      />
      <div class="progress-meta">
        <span>完成 <b>{{ task.done }}</b></span>
        <span>跳过 <b>{{ task.skipped }}</b></span>
        <span :class="{ danger: task.failed > 0 }">失败 <b>{{ task.failed }}</b></span>
        <span>共 <b>{{ task.total }}</b> 章</span>
        <span v-if="elapsedText">已用 {{ elapsedText }}</span>
      </div>
      <div class="current-line" v-if="task.message">{{ task.message }}</div>

      <div class="actions">
        <el-button v-if="task.status === 'running'" size="small" @click="handlePause">
          暂停
        </el-button>
        <el-button
          v-if="task.status === 'paused' || task.status === 'cancelled' || task.status === 'failed'"
          size="small"
          type="primary"
          @click="handleResume"
        >
          继续（已生成的自动跳过）
        </el-button>
        <el-button v-if="busy" size="small" @click="handleCancel">取消</el-button>
      </div>

      <div class="items" v-if="task.items.length">
        <div class="item-head">
          <span>章节明细</span>
          <span class="hint">
            音频在 audio\{{ task.folderName }}\ ，字幕在 Str\{{ task.folderName }}\
          </span>
        </div>
        <el-scrollbar height="320px">
          <div v-for="item in task.items" :key="item.index" class="item" :class="item.status">
            <span class="item-index">{{ String(item.index).padStart(4, '0') }}</span>
            <span class="item-title">{{ item.title }}</span>
            <span class="item-state">
              <template v-if="item.status === 'running'">
                合成中<template v-if="item.attempt && item.attempt > 1">
                  ·第{{ item.attempt }}次尝试</template
                ><template v-if="item.segmentTotal">
                  （{{ item.segmentDone }}/{{ item.segmentTotal }} 段）</template
                >
              </template>
              <template v-else-if="item.status === 'done'">
                ✓ {{ ((item.durationMs || 0) / 1000).toFixed(0) }}s
                <el-tag v-if="item.srtMissing" type="warning" size="small">无字幕</el-tag>
              </template>
              <template v-else-if="item.status === 'skipped'">已存在，跳过</template>
              <template v-else-if="item.status === 'failed'">
                <el-tooltip :content="item.error || '失败'" placement="left">
                  <el-tag type="danger" size="small">失败</el-tag>
                </el-tooltip>
              </template>
              <template v-else>等待</template>
            </span>
            <span class="item-actions">
              <el-button
                v-if="item.status === 'done'"
                link
                type="primary"
                size="small"
                @click="download(item, 'mp3')"
                >音频</el-button
              >
              <el-button
                v-if="item.status === 'done' && !item.srtMissing"
                link
                type="primary"
                size="small"
                @click="download(item, 'srt')"
                >字幕</el-button
              >
            </span>
          </div>
        </el-scrollbar>
      </div>
    </el-card>

    <el-card v-if="book" class="card list-card">
      <template #header>
        <div class="card-header">
          <span>章节列表（用于确认切分是否正确）</span>
          <span class="hint">第 {{ pageFrom }} ~ {{ pageTo }} 章 / 共 {{ book.chapterCount }} 章</span>
        </div>
      </template>
      <el-table :data="chapters" size="small" height="360" stripe>
        <el-table-column prop="index" label="序号" width="70" />
        <el-table-column prop="volumeTitle" label="卷" width="90" />
        <el-table-column prop="title" label="节标题" show-overflow-tooltip />
        <el-table-column prop="charCount" label="字数" width="90" />
      </el-table>
      <div class="pager">
        <el-button size="small" :disabled="pageFrom <= 1" @click="prevPage">上一页</el-button>
        <el-button size="small" :disabled="pageTo >= book.chapterCount" @click="nextPage">
          下一页
        </el-button>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { UploadFilled } from '@element-plus/icons-vue'
import { getVoiceList, downloadFile } from '@/api/tts'
import { takePendingBook } from '@/utils/pendingBook'
import type { BookInfo, ChapterSummary, ChapterTaskInfo } from '@/api/chapter'
import {
  cancelChapterTask,
  getBookChapters,
  getChapterTask,
  getChapterTasks,
  pauseChapterTask,
  resumeChapterTask,
  startChapterTask,
  uploadBook,
} from '@/api/chapter'

const book = ref<BookInfo | null>(null)
const chapters = ref<ChapterSummary[]>([])
const pageFrom = ref(1)
const pageTo = ref(50)
const PAGE_SIZE = 50

const voiceList = ref<{ Name: string; Gender: string }[]>([])
const voice = ref('zh-CN-YunxiNeural')
const from = ref(1)
const to = ref(10)

const uploading = ref(false)
const uploadPercent = ref(0)
const starting = ref(false)

const task = ref<ChapterTaskInfo | null>(null)
let timer: number | null = null

const busy = computed(
  () => task.value?.status === 'running' || task.value?.status === 'pending'
)
const selectedCount = computed(() => Math.max(0, (to.value || 0) - (from.value || 0) + 1))
const overallPercent = computed(() => {
  if (!task.value || !task.value.total) return 0
  const finished = task.value.done + task.value.skipped + task.value.failed
  return Math.min(100, Math.round((finished / task.value.total) * 100))
})
const statusText = computed(() => {
  const map: Record<string, string> = {
    pending: '排队中',
    running: '进行中',
    paused: '已暂停',
    completed: '已完成',
    cancelled: '已取消',
    failed: '失败',
  }
  return map[task.value?.status || ''] || ''
})
const statusTagType = computed(() => {
  switch (task.value?.status) {
    case 'completed':
      return 'success'
    case 'failed':
      return 'danger'
    case 'paused':
      return 'warning'
    default:
      return 'info'
  }
})
const estimatedHours = computed(() => {
  if (!book.value) return '0'
  // 实测约 4.8 字/秒
  return (book.value.totalChars / 4.8 / 3600).toFixed(0)
})
const elapsedText = computed(() => {
  if (!task.value?.startedAt) return ''
  const end = task.value.finishedAt || Date.now()
  const sec = Math.round((end - task.value.startedAt) / 1000)
  if (sec < 60) return `${sec} 秒`
  return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`
})

const handleFile = async (file: any) => {
  const raw: File | undefined = file?.raw
  if (!raw) return
  if (!/\.txt$/i.test(raw.name)) {
    ElMessage.error('只支持 .txt 文本文件')
    return
  }
  uploading.value = true
  uploadPercent.value = 0
  try {
    const info = await uploadBook(raw, (p) => (uploadPercent.value = p))
    book.value = info
    chapters.value = info.chapters
    pageFrom.value = 1
    pageTo.value = Math.min(PAGE_SIZE, info.chapterCount)
    // 默认只选前 10 章，避免一上来就跑整本
    from.value = 1
    to.value = Math.min(10, info.chapterCount)
    if (info.chapterCount <= 1) {
      ElMessage.warning('未识别到章节标题，请确认 txt 里有「第X节：xxx」这类标题')
    }
    ElMessage.success(`解析完成：共 ${info.chapterCount} 章，${(info.totalChars / 10000).toFixed(1)} 万字`)
  } catch (err) {
    ElMessage.error((err as Error).message || '上传失败')
  } finally {
    uploading.value = false
  }
}

const reset = () => {
  book.value = null
  chapters.value = []
}

const setRange = (n: number) => {
  from.value = 1
  to.value = Math.min(n, book.value?.chapterCount || n)
}

const loadChapters = async (pageStart: number) => {
  if (!book.value) return
  const size = Math.min(PAGE_SIZE, book.value.chapterCount - pageStart + 1)
  const data = await getBookChapters(book.value.bookId, pageStart, size)
  chapters.value = data.chapters
  pageFrom.value = data.from
  pageTo.value = data.to
}

const prevPage = () => loadChapters(Math.max(1, pageFrom.value - PAGE_SIZE))
const nextPage = () => loadChapters(pageFrom.value + PAGE_SIZE)

const handleStart = async () => {
  if (!book.value) return
  if (selectedCount.value <= 0) {
    ElMessage.error('章节范围不合法')
    return
  }
  starting.value = true
  try {
    task.value = await startChapterTask(book.value.bookId, {
      from: from.value,
      to: to.value,
      voice: voice.value,
    })
    startPolling()
    ElMessage.success(`已开始：第 ${from.value} ~ ${to.value} 章`)
  } catch (err) {
    ElMessage.error((err as Error).message || '启动失败')
  } finally {
    starting.value = false
  }
}

const handlePause = async () => {
  if (!task.value) return
  task.value = await pauseChapterTask(task.value.id)
}
const handleResume = async () => {
  if (!task.value) return
  try {
    task.value = await resumeChapterTask(task.value.id)
    startPolling()
  } catch (err) {
    ElMessage.error((err as Error).message || '继续失败')
  }
}
const handleCancel = async () => {
  if (!task.value) return
  task.value = await cancelChapterTask(task.value.id)
}

const download = (item: { fileName: string }, ext: 'mp3' | 'srt') => {
  const name = ext === 'mp3' ? item.fileName : item.fileName.replace(/\.mp3$/i, '.srt')
  // 产物按 txt 文件名分了文件夹，下载路径要带上这一层
  const folder = task.value?.folderName
  const relPath = folder ? `${folder}/${name}` : name
  window.open(downloadFile(relPath), '_blank')
}

const poll = async () => {
  if (!task.value) return
  try {
    const latest = await getChapterTask(task.value.id)
    task.value = latest
    if (['completed', 'failed', 'cancelled', 'paused'].includes(latest.status)) {
      stopPolling()
      if (latest.status === 'completed') {
        ElMessage.success(
          `完成：成功 ${latest.done} 章，跳过 ${latest.skipped} 章，失败 ${latest.failed} 章`
        )
      }
    }
  } catch {
    /* 轮询失败忽略 */
  }
}

const startPolling = () => {
  stopPolling()
  timer = window.setInterval(poll, 3000)
}
const stopPolling = () => {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

onMounted(async () => {
  // 若用户是在单篇生成页拖入的整本小说，这里直接接着上传解析，无需再拖一次
  const pending = takePendingBook()
  if (pending) void handleFile({ raw: pending })

  try {
    const res = await getVoiceList()
    voiceList.value = (res?.data || []) as any
  } catch {
    /* 音色列表拉取失败不阻塞页面 */
  }
  // 刷新页面后恢复最近一次任务的进度显示
  try {
    const { tasks } = await getChapterTasks()
    const latest = tasks?.[0]
    if (latest) {
      task.value = latest
      if (['running', 'pending'].includes(latest.status)) startPolling()
    }
  } catch {
    /* ignore */
  }
})

onUnmounted(stopPolling)
</script>

<style scoped>
.chapter-page {
  max-width: 1100px;
  margin: 0 auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.hint {
  font-size: 12px;
  color: #909399;
  font-weight: normal;
}
.book-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}
.book-title {
  font-size: 16px;
  font-weight: 600;
}
.book-meta {
  color: #606266;
  font-size: 13px;
}
.upload-progress {
  margin-top: 12px;
}
.range-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.range-sep {
  color: #909399;
}
.progress-meta {
  display: flex;
  gap: 16px;
  margin-top: 10px;
  font-size: 13px;
  color: #606266;
}
.progress-meta .danger {
  color: #f56c6c;
}
.current-line {
  margin-top: 6px;
  font-size: 13px;
  color: #409eff;
}
.actions {
  margin-top: 12px;
  display: flex;
  gap: 8px;
}
.items {
  margin-top: 14px;
}
.item-head {
  display: flex;
  justify-content: space-between;
  margin-bottom: 6px;
  font-weight: 600;
}
.item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 6px;
  border-bottom: 1px solid #f0f0f0;
  font-size: 13px;
}
.item.running {
  background: #ecf5ff;
}
.item.done {
  color: #303133;
}
.item.failed {
  background: #fef0f0;
}
.item-index {
  color: #909399;
  font-family: monospace;
}
.item-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item-state {
  color: #606266;
  white-space: nowrap;
}
.item-actions {
  width: 110px;
  text-align: right;
}
.pager {
  margin-top: 10px;
  display: flex;
  gap: 8px;
}
</style>
