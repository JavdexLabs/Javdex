import type {
  ScraperServiceConfigInput,
  ScraperServiceConnectionResult,
  ScraperServiceId,
  ScraperServicePublicConfig
} from '@shared/scraperServiceTypes'
import {
  clearScraperServiceConfig,
  getScraperServicePublicConfig,
  saveScraperServiceConfig,
  testScraperServiceConnection
} from '../scrapers/configuredScraperService'

export interface ScraperServiceConfigurationDependencies {
  get(serviceId: ScraperServiceId): ScraperServicePublicConfig
  save(
    serviceId: ScraperServiceId,
    input: ScraperServiceConfigInput
  ): ScraperServicePublicConfig
  test(
    serviceId: ScraperServiceId,
    input: ScraperServiceConfigInput
  ): Promise<ScraperServiceConnectionResult>
  clear(serviceId: ScraperServiceId): void
}

/** Application boundary for trusted scraper-service configuration IPC. */
export class ScraperServiceConfiguration {
  constructor(private readonly dependencies: ScraperServiceConfigurationDependencies) {}

  get(serviceId: ScraperServiceId): ScraperServicePublicConfig {
    return this.dependencies.get(serviceId)
  }

  save(
    serviceId: ScraperServiceId,
    input: ScraperServiceConfigInput
  ): ScraperServicePublicConfig {
    return this.dependencies.save(serviceId, input)
  }

  test(
    serviceId: ScraperServiceId,
    input: ScraperServiceConfigInput
  ): Promise<ScraperServiceConnectionResult> {
    return this.dependencies.test(serviceId, input)
  }

  clear(serviceId: ScraperServiceId): boolean {
    this.dependencies.clear(serviceId)
    return true
  }
}

export function createDefaultScraperServiceConfiguration(): ScraperServiceConfiguration {
  return new ScraperServiceConfiguration({
    get: getScraperServicePublicConfig,
    save: saveScraperServiceConfig,
    test: testScraperServiceConnection,
    clear: clearScraperServiceConfig
  })
}
