import assert from 'node:assert/strict'

// Production is a necessary condition, not proof of unique frames or scanout.
export function checkLoadProduction(stage, mode, sourceFps) {
  assert(Number.isFinite(sourceFps) && sourceFps > 0)
  const first = stage.samples[0], last = stage.samples.at(-1)
  const seconds = (last.elapsed - first.elapsed) / 1000
  assert(seconds > 0)
  const fps = (last.hosts[mode].nativeFrames - first.hosts[mode].nativeFrames) / seconds
  assert(fps >= sourceFps * .97, `video production is below source cadence: ${fps} / ${sourceFps} fps`)
  assert(stage.droppedFrames <= 1, `video dropped ${stage.droppedFrames} frames during the playing interval`)
  return { sourceFps, producedFps: fps, droppedFrames: stage.droppedFrames }
}
