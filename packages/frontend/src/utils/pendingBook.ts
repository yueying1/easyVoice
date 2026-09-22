/**
 * 跨页面暂存用户刚拖入的小说文件。
 * 在单篇生成页拖入整本小说时，直接把文件带到「按章节批量合成」页面，
 * 省掉用户再拖一次；只在同一个前端运行时内有效（路由跳转不刷新页面）。
 */
let pendingFile: File | null = null

export function setPendingBook(file: File): void {
  pendingFile = file
}

export function takePendingBook(): File | null {
  const file = pendingFile
  pendingFile = null
  return file
}
