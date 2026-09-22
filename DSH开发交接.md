# DSH 开发交接说明（EasyVoice 项目）

> **给谁看**：在**另一台电脑**上用 DeepSeek Harness 继续开发本项目的 AI 会话（新会话没有历史上下文，本文自包含）。
>
> **仓库**：https://github.com/yueying1/easyVoice （分支 `main`）
> **文档定位**：本文 = 接手指南 + 环境/构建 + 踩坑记录 + 协作约定。
> 更详细的历史演进过程见 `对话交接文档.md`；面向用户的安装步骤见 `安装与运行.md`；功能使用见 `使用说明.md`。

---

## 0. 新电脑上先做这三步

```powershell
# 1. 拉代码
git clone https://github.com/yueying1/easyVoice.git
cd easyVoice

# 2. 装依赖 + 构建（前提：已装 Node.js 20+、pnpm、ffmpeg，详见 安装与运行.md）
pnpm install
pnpm build

# 3. 启动（或直接双击 启动EasyVoice.bat，它会自动处理首次安装构建）
pnpm start
```

浏览器打开 http://localhost:3000 即为应用；整本小说批量合成在 http://localhost:3000/chapter 。

> ⚠️ **注意**：本机（上一台）的项目路径是 `F:\WenJian\XiaoShuo\Program\easyVoice`，
> 你那边路径不同属正常。**代码里不要写死绝对路径**，全部走 `config/index.ts` 里的常量。

---

## 1. 项目是什么

**EasyVoice**：小说/文本转语音。Vue 3 前端 + Express 后端（pnpm workspace，3 个包），
Edge-TTS 免费云端合成，本地 ffmpeg 拼接分段音频，输出 mp3 + srt 字幕。

两种使用方式：

| 场景 | 入口 | 产物 |
|---|---|---|
| 单篇文本（粘贴一段文字） | `/generate` | `audio\` 和 `Str\` 根目录下各一个文件 |
| **整本小说（拖入 txt，自动分章）** | `/chapter` | 按书名建子文件夹：`audio\<书名>\`、`Str\<书名>\` |

```
packages/backend/   Express 服务（TS，编译到 dist，托管前端）
packages/frontend/  Vue 3 页面（Vite，构建产物自动复制到 backend/public）
packages/shared/    共享常量/类型（上游遗留，改动需谨慎）
```

---

## 2. 当前完成状态（截至 2026-09-22）

已在 GitHub `main` 分支上（提交 `cbf1fc5` 及以后）。

### 功能清单与实现位置

| 功能 | 关键文件 |
|---|---|
| 章节识别与解析（含卷、去重、空章跳过） | `backend/src/services/chapter.service.ts` |
| 章节批量合成任务（串行/续跑/严格模式/重试/暂停） | `backend/src/services/chapterTask.service.ts` |
| 章节相关 HTTP 接口 | `backend/src/controllers/chapter.controller.ts`、`routes/chapter.route.ts` |
| 产物落盘目录、`srtPathFor()` 路径映射 | `backend/src/config/index.ts` |
| 自定义输出文件名的生成入口 | `backend/src/services/tts.service.ts` 的 `generateTTSWithId()` |
| 音频/字幕下载（支持子目录 + 穿越防护） | `backend/src/controllers/tts.controller.ts` 的 `downloadAudio()` / `resolveInside()` |
| 章节批量合成页面 | `frontend/src/views/Chapter.vue` + `frontend/src/api/chapter.ts` |
| 拖入大 txt 自动转交章节页 | `frontend/src/utils/pendingBook.ts`、`views/Generate.vue` |
| 启动脚本（自动准备 pnpm / 首次自动构建 / 显示网址） | `启动EasyVoice.bat` |

### 关键行为约定（改动前务必理解）

- **产物命名**：`0002_第一卷_第一节：纵身亡魔心仍不悔.mp3`
  前缀是**全书连续序号**（4 位补零），所以按文件名排序即阅读顺序；序号跨卷连续、不重置。
- **章节识别规则**（参考了 `F:\WenJian\XiaoShuo\Program\Reader` 的 Win32 阅读器实现）：
  行首 `第<数字白名单><章|节|部|回>`，且**单位字后必须紧跟分隔符**（空白/全角空格/NBSP/冒号/行尾）。
  数字白名单含阿拉伯数字、中文小中大写数字、亿、〇、两。另外支持 `第X卷`（作为分组，不单独出音频）
  和 `序/楔子/番外/后记` 等独立篇章。epub 转换常见的**同一标题连续出现两次**会自动去重；
  字数过少的占位章节（如作者请假「卡文无更」）自动跳过。
- **断点续传**：开始/继续任务时**按产物文件是否存在**判定，不依赖任何状态文件。
  ⚠️ 这条意味着：**一旦改了产物路径规则，旧位置的文件不会被认作已完成**，会重新生成。
- **严格模式**：批量任务里任一分段合成失败就整章判失败并重试，绝不产出缺内容的音频；
  非批量接口保持上游「部分成功也返回」的行为。
- **中间文件**：分段临时目录与字幕源 json 在每章完成后自动清理，`audio\` 里只留成品。

---

## 3. 环境与构建（DSH 特有注意事项）

### 前提

Node.js 20+（实测 v24.9.0）、pnpm 10.6.3（`package.json` 的 `packageManager` 已固定）、
**ffmpeg + ffprobe**（拼接音频必需）。详见 `安装与运行.md`。

### 常用命令

```powershell
pnpm install                                  # 装依赖
pnpm build                                    # 全量构建（shared + backend + frontend）
pnpm --filter @easy-voice/backend build       # 只构建后端（tsc）
pnpm --filter @easy-voice/frontend build      # 只构建前端（会复制到 backend/public）
pnpm start                                    # 生产模式启动（后端托管前端）
```

> 改了后端源码 → 只 build 后端即可；**改了前端 → 必须 build 前端**（产物要复制到 `backend/public`），
> 然后刷新浏览器。启动脚本只负责启动，不会热更新。

### ⚠️ DSH 沙箱会拦住两件事（本会话反复踩）

1. **`ffmpeg` spawn 被拒**：`fluent-ffmpeg` 启动 ffmpeg 子进程时，`workspace-write` 沙箱会以
   `spawn EPERM` 拒绝 → 音频拼接失败，任务卡住。
   **跑涉及音频合成的服务时必须放宽到 `danger-full-access`**，否则验证不了真实产物。
2. **前端构建（esbuild/vite）同样报 `spawn EPERM`** → 需要放宽权限才能 `pnpm build` 前端。
   后端 `tsc` 构建不受影响。

这些都是**沙箱限制，不是代码 bug**。放宽权限后一切正常。
另外：沙箱下 `git ls-remote` / `git push` 会报
`schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`，同样是沙箱禁止访问系统凭据存储，
放宽权限即可（新电脑上首次推送可能需要先 `gh auth login` 或配置 PAT）。

---

## 4. 踩坑记录（都是实际发生过的）

- **ffmpeg 失败时 Promise 不会 reject**：`fluent-ffmpeg` 的 spawn 失败可能变成进程级
  `uncaughtException`，导致批量任务**永久卡死**。已在 `concatDirAudio()` 加了
  `CONCAT_TIMEOUT_MS`（默认 180s）超时兜底 —— 改这里时不要移除超时。
- **Edge-TTS 会短时 1006 限流**：实测一章 5~7 段里偶发 1 段断连，且**重试间隔太短必然再失败**。
  现策略：分段重试基数 `EDGE_RETRY_BASE_DELAY_MS`（默认 1000ms，共 5 次）+ 整章重试
  `CHAPTER_MAX_ATTEMPTS`（默认 2，间隔 8s）+ 章内并发降到 2。这些都是可配项。
- **HTTP 头不能放中文**：流式接口回传字幕文件名时做了 `encodeURIComponent`，前端 `decodeURIComponent`；
  漏了会在 `res.setHeader` 抛 `ERR_INVALID_CHAR`。
- **下载路径要保留 `/`**：`downloadFile()` 用 `encodeURI` 而非 `encodeURIComponent`，
  否则 `书名/xxx.mp3` 里的 `/` 被编码成 `%2F`，通配路由取不到。
- **`/chapter` 用 curl 测会 404**：`connect-history-api-fallback` 只重写带 `Accept: text/html`
  的浏览器导航请求。裸测要加 `Accept: text/html`，别误判成 bug。
- **pnpm 10 忽略依赖构建脚本**：`pnpm install` 会打印 `Ignored build scripts: esbuild, vue-demi`，
  **实测不影响本项目构建**，可忽略。
- **上传 Git 前必须 `git add -A`**：本项目经常新增源文件，漏加会让别人 clone 后编译失败。

---

## 5. 未完成 / 可继续的方向

1. **自定义章节正则还没暴露到界面**：后端 `parseChapters(raw, { customRegex })` 已支持，
   接口与前端未接。遇到 `1. 标题` 这类非常规目录体例时值得补上。
2. **全书 2336 章未实际跑完**（用户要求先验证前 10 章）。规模：约 351 小时音频 / 约 14.5 GB /
   预计连续跑 1.5~2 天。真跑之前建议再确认续跑与限流表现。
3. **没有真实浏览器的点击验证**：页面只验证到「接口 + 构建产物」层面（无浏览器自动化能力）。
4. 可考虑的增强：批量任务进度持久化（现在靠文件存在性）、多任务队列、按角色自动分配音色、
   接入 `REGISTER_KOKORO` 本地引擎（项目已支持开关）。

---

## 6. 与这位用户协作的约定（重要）

- **全程中文**：回复、思考过程、需要他做的选择、命令说明，一律中文（他明确要求过）。
- **用实测说话**：他不接受"应该可以"式推断。改动后要真跑一遍并给出证据
  （文件是否落盘、时长/字数、接口返回码、目录结构）。他也会自己动手验证（自己删产物、自己试用网页）。
- **先小范围验证再全量**：批量合成动辄跑几小时到几天，先跑 1~10 章确认音色与产物，再排全书。
- **涉及文件布局/命名/存放位置的改动，先确认再动手**：他对此很在意（例如"按 txt 文件名建文件夹"
  曾来回确认过一轮）。需求不清楚就提问，别自己发挥。
- **临时脚本用完即删**：验证用的 `tmp-check` 之类目录不要留在仓库里（注意别被 `git add -A` 带上去）。
- **不要提交密钥**：`.env` 已在 `.gitignore`；他也曾手动清掉过里面的 API Key。
  改完代码若要提交，先确认 `git status` 干净、没有 `.env`/产物/小说原文。
- **诚实报告**：做到哪一步、哪一步没验证，要说清楚（比如"没做浏览器点击验证"）。

---

## 7. 目录与产物速查

| 路径 | 说明 | 是否进 Git |
|---|---|---|
| `audio\<书名>\*.mp3` | 章节批量合成的音频 | ❌ 忽略 |
| `audio\*.mp3` | 单篇生成的音频 | ❌ 忽略 |
| `Str\<书名>\*.srt` | 字幕（与音频同名） | ❌ 忽略 |
| `books\<bookId>.txt` / `.meta.json` | 上传的小说原文 + 元信息（folderName 来源） | ❌ 忽略 |
| `logs\` | 运行日志（`*.log` 被忽略） | ❌ |
| `ffmpeg\bin\` | 手动放入的 ffmpeg | ❌ 忽略 |
| `.bin\` | 项目内 pnpm 启动器 | ❌ 忽略 |
| `.env` | 环境配置（含密钥） | ❌ 忽略 |
| `.env.example` | 配置模板（含全部可配项与中文注释） | ✅ |
| `packages/backend/dist`、`backend/public`、`frontend/dist` | 构建产物 | ❌ 忽略 |

> `bookId` 形如 `书名-内容hash8`；产物文件夹名取自 `books\<bookId>.meta.json` 里的 `folderName`
> （上传时用**用户拖入的原始 txt 文件名**去掉扩展名，不受 bookId 截断影响）。

---

## 8. 相关文档索引

| 文档 | 内容 |
|---|---|
| `安装与运行.md` | **换电脑/从 GitHub 拉取**的完整步骤、前提清单、常见问题（已端到端实测） |
| `使用说明.md` | 已跑起来后怎么用：启动、两种生成方式、产物位置、调优环境变量 |
| `对话交接文档.md` | 详细开发历史（第一~十一节）：每轮需求、改动、实测数据、踩坑 |
| `README.md` | 上游项目原始说明 |
