import type { UpdaterConfig } from './config'

/** Every business command must enter the same identity before loading business code. */
export function businessProcessCommand(config: Pick<UpdaterConfig, 'businessUid' | 'businessGid' | 'businessGroups'>, args: string[]) {
  if (process.platform === 'linux' && process.getuid?.() === 0) {
    // Node's spawn uid/gid options clear supplementary groups. setpriv applies
    // only explicitly configured groups, then execs Node in the same process.
    return { file: 'setpriv', args: [
      `--reuid=${config.businessUid}`, `--regid=${config.businessGid}`,
      config.businessGroups.length ? `--groups=${config.businessGroups.join(',')}` : '--clear-groups',
      '--', process.execPath, ...args
    ], credentials: {} }
  }
  // Non-root/non-Linux hosts are used by the synthetic lifecycle tests only;
  // the production manager requires Linux root. Never silently ignore groups.
  if (config.businessGroups.length) throw new Error('配置业务附加组需要 Linux root 管理进程与 setpriv')
  return { file: process.execPath, args, credentials: { uid: config.businessUid, gid: config.businessGid } }
}
