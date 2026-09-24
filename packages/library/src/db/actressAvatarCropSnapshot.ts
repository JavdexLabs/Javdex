import { randomUUID } from 'node:crypto'
import type { ActressAvatarCropTargetPage } from '@shared/actressAvatarCropTypes'
import { getDb } from './database'

export interface ActressAvatarCropSnapshot {
  page(afterId: number): ActressAvatarCropTargetPage
  dispose(): void
}

/** Fixed target identity set; SQLite owns the snapshot instead of renderer arrays. */
export function createActressAvatarCropSnapshot(): ActressAvatarCropSnapshot {
  const db = getDb()
  const table = `avatar_crop_${randomUUID().replaceAll('-', '')}`
  let disposed = false
  let total = 0
  db.transaction(() => {
    db.exec(`CREATE TEMP TABLE ${table} (actress_id INTEGER PRIMARY KEY, name_prefix BLOB NOT NULL)`)
    db.exec(`INSERT INTO ${table} SELECT id, substr(CAST(main_name AS BLOB),1,516)
      FROM actresses WHERE length(CAST(avatar_source_path AS BLOB)) > 0
      OR length(CAST(avatar_path AS BLOB)) > 0`)
    total = (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {count:number}).count
  })()
  return {
    page(afterId) {
      if (disposed || !db.open) throw new Error('头像任务快照已失效')
      if (!Number.isSafeInteger(afterId) || afterId < 0) throw new Error('无效的头像任务游标')
      const rows = db.prepare(`SELECT actress_id, name_prefix FROM ${table}
        WHERE actress_id > ? ORDER BY actress_id ASC LIMIT 101`).all(afterId) as Array<{actress_id:number;name_prefix:Buffer}>
      const items = rows.slice(0,100).map(row => {
        const points = Array.from(row.name_prefix.toString('utf8'))
        return {actressId:row.actress_id,mainName:points.slice(0,128).join('')+(points.length>128?'…':'')}
      })
      return {items,total,nextAfterId:rows.length>100?items[items.length-1].actressId:null}
    },
    dispose() {
      if (disposed) return
      if (db.open) db.exec(`DROP TABLE IF EXISTS ${table}`)
      disposed = true
    }
  }
}
