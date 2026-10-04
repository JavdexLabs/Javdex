import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { SCRAPE_BROWSER_HELPER_FLAG } from './scrapers/scrapeBrowserProtocol'
import { configurePlaybackDisplay } from './player/playbackDisplay'

const SCRAPE_BROWSER_SMOKE_FLAG = '--javdex-scraper-helper-smoke'

configurePlaybackDisplay(app, {
  windowsNativePlayback: process.platform === 'win32'
    && !process.argv.includes(SCRAPE_BROWSER_HELPER_FLAG)
    && !process.argv.includes(SCRAPE_BROWSER_SMOKE_FLAG)
    && fs.existsSync(app.isPackaged
      ? path.join(process.resourcesPath, 'native-playback', 'playback.node')
      : path.join(app.getAppPath(), 'out', 'native-playback', 'playback.node'))
})

if (process.argv.includes(SCRAPE_BROWSER_HELPER_FLAG)) {
  void import('./scrapers/scrapeBrowserHelperEntry')
    .then(({ startScrapeBrowserHelper }) => startScrapeBrowserHelper())
    .catch((error) => {
      // Never log the helper token, profile path, pipe or CDP endpoint.
      const name = error instanceof Error ? error.name : 'Error'
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[scraper-helper] ${name}: ${message}`)
      process.exitCode = 1
      app.quit()
    })
} else if (process.argv.includes(SCRAPE_BROWSER_SMOKE_FLAG)) {
  void import('./scrapers/scrapeBrowserSmokeEntry')
    .then(({ runScrapeBrowserSmoke }) => runScrapeBrowserSmoke())
    .catch((error) => {
      console.error(`[scraper-helper-smoke] ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
      app.quit()
    })
} else {
  void import('./appMain')
}
