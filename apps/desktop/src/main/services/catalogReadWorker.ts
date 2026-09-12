import { createScopedVideoCatalogRepo } from '../db/scopedVideoCatalogRepo'
import { createHomeDiscoveryRepo } from '../db/homeDiscoveryRepo'
import { WebCatalogQueryReader } from '../web/catalogQueryReader'
import { IPC } from '@shared/ipc-channels'
import { videoIpcSchemas } from '../ipc/ipcCommandSchemas'
import { mediaLibraryIpcSchemas } from '../ipc/mediaLibraryIpcSchemas'
import { createScanAuditPathPermissionReader } from './scanAuditPathPermission'
import { readScanAuditHeader } from './scanAuditReadHeader'
import type { CatalogReadCommand } from './catalogReadWorkerClient'
import { ScanAuditIndexSession } from './scanAuditIndexSession'
import { createScanAuditReadIndex } from './scanAuditReadIndex'
import { normalizeScanAuditReadRequest, normalizeScanAuditViewRequest } from './scanAuditReadRequest'
import { createClassificationImagePageReader } from './classificationImagePage'
import { parentPort, workerData } from 'node:worker_threads'
import { openReadOnlyDatabaseAtPath } from '../db/database'
import { createTagFilterOptionsReader } from './tagQueryService'

const port = parentPort
if (!port || typeof workerData?.databasePath !== 'string') throw new Error('Invalid catalog reader startup')
const connection = openReadOnlyDatabaseAtPath(workerData.databasePath)
const catalog = createScopedVideoCatalogRepo(connection)
const home = createHomeDiscoveryRepo({database:connection})
const web = new WebCatalogQueryReader(connection)
const read = createTagFilterOptionsReader(() => connection)
const readImages = createClassificationImagePageReader(() => connection)
const canRevealAuditPath = createScanAuditPathPermissionReader(connection)
const auditSession = new ScanAuditIndexSession({
  build: (snapshot, limits, options) => createScanAuditReadIndex(workerData.databasePath, snapshot, limits, options),
  revision: () => JSON.stringify([connection.pragma('data_version', {simple:true}), connection.pragma('schema_version', {simple:true})])
})
port.on('close', () => { auditSession.dispose(); if (connection.open) connection.close() })
port.on('message', (message: CatalogReadCommand | {type:'close'}) => {
  if (message.type === 'close') {
    auditSession.dispose()
    connection.close()
    port.close()
    return
  }
  if (message.type !== 'read' || !Number.isSafeInteger(message.id) || Number(message.id) <= 0) {
    throw new Error('Invalid catalog reader command')
  }
  try {
    if (!message.query) throw new Error('Missing catalog query')
    if (message.operation === 'scoped-video-list') {
      const [scope,query]=videoIpcSchemas[IPC.VIDEO_LIST].parse([message.scope,message.query])
      port.postMessage({type:'result',id:message.id,result:catalog.list(scope,query)})
      return
    }
    if (message.operation === 'scoped-video-years') {
      const [scope]=videoIpcSchemas[IPC.VIDEO_YEARS].parse([message.query])
      port.postMessage({type:'result',id:message.id,result:catalog.listYears(scope)})
      return
    }
    if (message.operation === 'home-load') {
      const [input]=mediaLibraryIpcSchemas[IPC.HOME_LOAD].parse([message.query])
      port.postMessage({type:'result',id:message.id,result:home.load(input)})
      return
    }
    if (message.operation === 'home-search') {
      const [input]=mediaLibraryIpcSchemas[IPC.HOME_SEARCH].parse([message.query])
      port.postMessage({type:'result',id:message.id,result:home.search(input)})
      return
    }
    if (message.operation === 'web-browse' || message.operation === 'web-home' || message.operation === 'web-collections') {
      const result = message.operation === 'web-home' ? web.home(message.query.seed)
        : message.operation === 'web-browse' ? web.browse(message.query) : web.collections()
      port.postMessage({type:'result',id:message.id,result})
      return
    }
    if (message.operation === 'scan-audit-path') {
      port.postMessage({ type:'result', id:message.id, result:canRevealAuditPath(message.query.libraryId,message.query.filePath) })
      return
    }
    if (message.operation === 'scan-audit-header') {
      port.postMessage({ type:'result', id:message.id, result:readScanAuditHeader(connection,message.query.libraryId) })
      return
    }
    if (message.operation === 'scan-audit-view-page') {
      const request = normalizeScanAuditViewRequest(message.snapshot, message.query, message.limits)
      const result = auditSession.readView(request.snapshot, request.query, request.limits)
      port.postMessage({ type:'result', id:message.id, result })
      return
    }
    if (message.operation === 'scan-audit-page') {
      const request = normalizeScanAuditReadRequest(message.snapshot, message.query, message.limits)
      const result = auditSession.read(request.snapshot, request.query, request.limits)
      port.postMessage({ type: 'result', id: message.id, result })
      return
    }
    if (message.operation !== undefined && message.operation !== 'tag-options' && message.operation !== 'classification-images') throw new Error('Unknown catalog read operation')
    if (message.operation === 'classification-images' && !message.entity) throw new Error('Missing classification entity')
    const result = message.operation === 'classification-images'
      ? readImages(message.entity!, message.query) : read(message.query)
    port.postMessage({ type: 'result', id: message.id, result })
  } catch (error) {
    port.postMessage({ type: 'error', id: message.id, message: error instanceof Error ? error.message : String(error) })
  }
})
port.postMessage({ type: 'ready' })
