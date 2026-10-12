import { isStructuredError } from '@shared/protocol/errors'

// Only these controlled messages can cross IPC. Native/HTTP/OS errors may contain locators.
const messages = {
  connection: '资料库当前不可用，请检查连接后重试',
  authorization: '远程播放授权已失效，请在资料库连接设置恢复授权后重试',
  version: '桌面与服务器版本不一致，请更新到同一版本后重试',
  library: '媒体库不存在或已归档，请恢复媒体库后播放',
  resource: '所选影片资源不存在或不属于当前媒体库，请刷新资料后重试',
  identity: '影片资源或资料库身份已变化，请刷新资料后重新播放',
  root: '影片文件或媒体库根目录不可用，请检查来源目录及访问权限后重试',
  missing: '影片文件不存在，请重新连接存储设备或检查资源位置',
  file: '影片文件暂时无法访问，请检查文件及访问权限后重试',
  unsupported: '此资源请使用外部打开，内置播放目前仅支持影片文件',
  grant: '服务端未返回可用的原文件播放授权，请检查连接后重试',
  runtime: '内置播放运行库无法初始化，请检查运行库或显式使用外部播放器',
  format: '无法识别所选影片格式，文件可能损坏或格式不受支持，可检查文件或显式使用外部播放器',
  streams: '所选文件没有可播放的音视频流，请检查文件或显式使用外部播放器',
  audio: '无法初始化音频输出，请检查系统音频设备后重试',
  video: '原生画面输出失败，请重试或显式使用外部播放器',
  load: '无法读取所选影片，请检查文件、网络与播放授权后重试',
  openingTimeout: '30 秒内未能打开影片，请检查文件或网络后重试',
  seekTimeout: '20 秒内未能完成定位，请检查文件或网络后重试',
  native: '播放内核已停止或控制失败，请重试或显式使用外部播放器'
} as const

export type PlaybackFailureCode = keyof typeof messages
export class PlaybackFailure extends Error {
  constructor(readonly code: PlaybackFailureCode) {
    super(messages[code])
    this.name = 'PlaybackFailure'
  }
}

/** Discard third-party messages, even when they are structured catalog errors. */
export function playbackFailure(error: unknown, fallback: PlaybackFailureCode = 'load'): PlaybackFailure {
  if (error instanceof PlaybackFailure) return error
  if (isStructuredError(error)) {
    if (error.code === 'AUTH_REQUIRED' || error.code === 'WRITER_REVOKED') return new PlaybackFailure('authorization')
    if (error.code === 'VERSION_MISMATCH') return new PlaybackFailure('version')
    if (['IDENTITY_CONFLICT', 'INSTANCE_MISMATCH', 'CATALOG_MISMATCH', 'VERSION_CONFLICT', 'FILE_CHANGED'].includes(error.code)) return new PlaybackFailure('identity')
    if (error.code === 'ROOT_OFFLINE' || error.code === 'READ_ONLY_MOUNT') return new PlaybackFailure('root')
    if (['CONNECTION_UNAVAILABLE', 'CATALOG_FROZEN', 'RECOVERY_REQUIRED'].includes(error.code)) return new PlaybackFailure('connection')
  }
  return new PlaybackFailure(fallback)
}
