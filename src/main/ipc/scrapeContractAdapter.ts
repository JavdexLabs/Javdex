import type {
  ScrapeIpcArgs,
  ScrapeIpcChannel,
  ScrapeIpcContract,
  ScrapeIpcEvent,
  ScrapeIpcEventChannel,
  ScrapeIpcEventContract,
  ScrapeIpcResult
} from '@shared/scrapeIpcContract'
import type { WebContents } from 'electron'
import { createTypedEventAdapter, createTypedIpcAdapter } from './typedIpcAdapter'

const commandAdapter = createTypedIpcAdapter<ScrapeIpcContract>()
const eventAdapter = createTypedEventAdapter<ScrapeIpcEventContract>()

export function registerScrapeHandler<Channel extends ScrapeIpcChannel>(
  channel: Channel,
  handler: (
    ...args: ScrapeIpcArgs<Channel>
  ) => ScrapeIpcResult<Channel> | Promise<ScrapeIpcResult<Channel>>
): void {
  commandAdapter.register(channel, handler)
}

export function sendScrapeEvent<Channel extends ScrapeIpcEventChannel>(
  webContents: Pick<WebContents, 'send'> | undefined,
  channel: Channel,
  payload: ScrapeIpcEvent<Channel>
): void {
  eventAdapter.send(webContents, channel, payload)
}
