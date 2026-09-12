interface ImageBytes { body: Buffer; mime: string }
interface Consumer {
  cancelled: boolean
  signal?: AbortSignal
  abort(): void
  resolve(value: ImageBytes): void
  reject(error: unknown): void
}
interface Flight {
  controller: AbortController
  consumers: Set<Consumer>
}

/** Called inside the bounded read queue: each live flight retains at least one queue slot. */
export class AssetReadFlights {
  private readonly flights = new Map<string, Flight>()

  run(key: string, read: (signal: AbortSignal) => Promise<ImageBytes>, signal?: AbortSignal): Promise<ImageBytes> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    let flight = this.flights.get(key)
    const created = !flight
    if (!flight) {
      flight = { controller: new AbortController(), consumers: new Set() }
      this.flights.set(key, flight)
    }
    const current = flight
    const result = new Promise<ImageBytes>((resolve, reject) => {
      const consumer: Consumer = {
        cancelled: false, signal, resolve, reject,
        abort: () => {
          consumer.cancelled = true
          if ([...current.consumers].some((item) => !item.cancelled)) {
            this.remove(current, consumer)
            reject(signal?.reason)
          } else {
            // Last consumer drains the underlying work before releasing its queue slot.
            if (this.flights.get(key) === current) this.flights.delete(key)
            current.controller.abort(signal?.reason)
          }
        }
      }
      current.consumers.add(consumer)
      signal?.addEventListener('abort', consumer.abort, { once: true })
    })
    if (created) {
      void Promise.resolve().then(() => read(current.controller.signal)).then(
        (image) => this.finish(key, current, image),
        (error) => this.finish(key, current, undefined, error)
      )
    }
    return result
  }

  private remove(flight: Flight, consumer: Consumer): void {
    consumer.signal?.removeEventListener('abort', consumer.abort)
    flight.consumers.delete(consumer)
  }

  private finish(key: string, flight: Flight, image?: ImageBytes, error?: unknown): void {
    if (this.flights.get(key) === flight) this.flights.delete(key)
    for (const consumer of flight.consumers) {
      try {
        if (consumer.cancelled) consumer.reject(consumer.signal?.reason)
        else if (!image) consumer.reject(error)
        else consumer.resolve({ body: flight.consumers.size === 1 ? image.body : Buffer.from(image.body), mime: image.mime })
      } catch (failure) {
        consumer.reject(failure)
      } finally {
        this.remove(flight, consumer)
      }
    }
  }
}
