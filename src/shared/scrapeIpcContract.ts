import { IPC } from './ipc-channels'
import type {
  ActressAvatarAutoCropRequest,
  ActressAvatarAutoCropResponse
} from './actressAvatarCropTypes'
import type {
  ActressBatchScrapeFilter,
  ActressBatchScrapeRequest,
  ActressScrapeDisposition,
  ActressScrapeField,
  ActressScrapeUpdateMode
} from './actressScrapeTypes'
import type {
  CompositeScraperInput,
  ScraperPluginDescriptor,
  ScraperPluginPackage,
  ScraperPluginUpdateInput
} from './scraperPluginTypes'
import type {
  VideoBatchScrapeFilter,
  VideoBatchScrapeRequest,
  VideoRematchBatchRequest,
  VideoRematchScope,
  VideoScrapeField,
  VideoScrapeOneResult,
  VideoScrapeUpdateMode
} from './videoScrapeTypes'
import type { BatchProgress, BatchScrapeState } from './batchScrapeTypes'
import type {
  IpcContractArgs,
  IpcContractChannel,
  IpcContractResult,
  IpcEventChannel,
  IpcEventPayload
} from './typedIpcContract'

export interface ScrapeIpcContract {
  [IPC.SCRAPE_ONE]: {
    args: [
      videoId: number,
      scraperName?: string,
      fields?: VideoScrapeField[],
      mode?: VideoScrapeUpdateMode
    ]
    result: VideoScrapeOneResult
  }
  [IPC.SCRAPE_BATCH_START]: { args: [scraperName?: string]; result: boolean }
  [IPC.SCRAPE_BATCH_CANCEL]: { args: []; result: boolean }
  [IPC.SCRAPE_VIDEO_BATCH_COUNT]: { args: [filter: VideoBatchScrapeFilter]; result: number }
  [IPC.SCRAPE_VIDEO_BATCH_START]: { args: [request: VideoBatchScrapeRequest]; result: boolean }
  [IPC.SCRAPE_VIDEO_BATCH_CANCEL]: { args: []; result: boolean }
  [IPC.SCRAPE_REMATCH_COUNT]: { args: [scope: VideoRematchScope]; result: number }
  [IPC.SCRAPE_REMATCH_BATCH_START]: {
    args: [request: VideoRematchBatchRequest]
    result: boolean
  }
  [IPC.SCRAPE_REMATCH_BATCH_CANCEL]: { args: []; result: boolean }
  [IPC.BATCH_SCRAPE_STATE]: { args: []; result: BatchScrapeState }
  [IPC.BATCH_SCRAPE_PAUSE]: { args: []; result: boolean }
  [IPC.BATCH_SCRAPE_RESUME]: { args: []; result: boolean }
  [IPC.BATCH_SCRAPE_DISCARD]: { args: []; result: boolean }
  [IPC.AVATAR_AUTO_CROP_BATCH_BEGIN]: { args: []; result: string }
  [IPC.AVATAR_AUTO_CROP_BATCH_END]: { args: [token: string]; result: boolean }
  [IPC.SCRAPER_LIST]: { args: []; result: string[] }
  [IPC.SCRAPER_PLUGIN_DETAILS]: { args: []; result: ScraperPluginDescriptor[] }
  [IPC.PLUGIN_IMPORT]: { args: []; result: ScraperPluginDescriptor | null }
  [IPC.SCRAPER_PLUGIN_EXPORT]: { args: [name: string]; result: string | null }
  [IPC.SCRAPER_PLUGIN_PACKAGE]: { args: [name: string]; result: ScraperPluginPackage }
  [IPC.SCRAPER_PLUGIN_UPDATE]: {
    args: [name: string, input: ScraperPluginUpdateInput]
    result: ScraperPluginDescriptor
  }
  [IPC.SCRAPER_PLUGIN_DELETE]: { args: [name: string]; result: boolean }
  [IPC.SCRAPER_COMPOSITE_CREATE]: {
    args: [input: CompositeScraperInput]
    result: ScraperPluginDescriptor
  }
  [IPC.SCRAPER_COMPOSITE_UPDATE]: {
    args: [name: string, input: CompositeScraperInput]
    result: ScraperPluginDescriptor
  }
  [IPC.SCRAPER_COMPOSITE_DELETE]: { args: [name: string]; result: boolean }
  [IPC.ACTRESS_SCRAPER_LIST]: { args: []; result: string[] }
  [IPC.ACTRESS_SCRAPER_PLUGIN_DETAILS]: { args: []; result: ScraperPluginDescriptor[] }
  [IPC.ACTRESS_SCRAPER_PLUGIN_EXPORT]: { args: [name: string]; result: string | null }
  [IPC.ACTRESS_SCRAPER_PLUGIN_PACKAGE]: { args: [name: string]; result: ScraperPluginPackage }
  [IPC.ACTRESS_SCRAPER_PLUGIN_UPDATE]: {
    args: [name: string, input: ScraperPluginUpdateInput]
    result: ScraperPluginDescriptor
  }
  [IPC.ACTRESS_SCRAPER_PLUGIN_DELETE]: { args: [name: string]; result: boolean }
  [IPC.ACTRESS_SCRAPER_COMPOSITE_CREATE]: {
    args: [input: CompositeScraperInput]
    result: ScraperPluginDescriptor
  }
  [IPC.ACTRESS_SCRAPER_COMPOSITE_UPDATE]: {
    args: [name: string, input: CompositeScraperInput]
    result: ScraperPluginDescriptor
  }
  [IPC.ACTRESS_SCRAPER_COMPOSITE_DELETE]: { args: [name: string]; result: boolean }
  [IPC.ACTRESS_SCRAPE_ONE]: {
    args: [
      actressId: number,
      scraperName?: string,
      fields?: ActressScrapeField[],
      mode?: ActressScrapeUpdateMode,
      queryName?: string,
      useAliases?: boolean,
      autoCropAvatar?: boolean
    ]
    result: ActressScrapeDisposition
  }
  [IPC.ACTRESS_SCRAPE_BATCH_COUNT]: { args: [filter: ActressBatchScrapeFilter]; result: number }
  [IPC.ACTRESS_SCRAPE_BATCH_START]: {
    args: [request?: ActressBatchScrapeRequest | string]
    result: boolean
  }
  [IPC.ACTRESS_SCRAPE_BATCH_CANCEL]: { args: []; result: boolean }
  [IPC.ACTRESS_AVATAR_AUTO_CROP_RESULT]: {
    args: [response: ActressAvatarAutoCropResponse]
    result: boolean
  }
}

export interface ScrapeIpcEventContract {
  [IPC.SCRAPE_BATCH_PROGRESS]: BatchProgress
  [IPC.SCRAPE_VIDEO_BATCH_PROGRESS]: BatchProgress
  [IPC.SCRAPE_REMATCH_BATCH_PROGRESS]: BatchProgress
  [IPC.ACTRESS_SCRAPE_BATCH_PROGRESS]: BatchProgress
  [IPC.ACTRESS_AVATAR_AUTO_CROP_REQUEST]: ActressAvatarAutoCropRequest
}

export type ScrapeIpcChannel = IpcContractChannel<ScrapeIpcContract>
export type ScrapeIpcArgs<Channel extends ScrapeIpcChannel> =
  IpcContractArgs<ScrapeIpcContract, Channel>
export type ScrapeIpcResult<Channel extends ScrapeIpcChannel> =
  IpcContractResult<ScrapeIpcContract, Channel>
export type ScrapeIpcEventChannel = IpcEventChannel<ScrapeIpcEventContract>
export type ScrapeIpcEvent<Channel extends ScrapeIpcEventChannel> =
  IpcEventPayload<ScrapeIpcEventContract, Channel>
