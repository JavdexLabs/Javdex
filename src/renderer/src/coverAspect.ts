/**
 * Standard cover aspect ratios used across the library grid and detail page.
 *
 * Portrait — common JAV vertical cover ratio: 7:10 (width : height).
 * Landscape — typical JAV jacket art from scrapers: 800 × 538 px → ~1.487:1.
 *
 * In portrait display mode the UI crops the right portion of the landscape
 * jacket; the scale factor below maps that crop to the 7:10 frame.
 */
export const PORTRAIT_W = 7
export const PORTRAIT_H = 10
/** CSS aspect-ratio value (width / height). */
export const PORTRAIT_RATIO = PORTRAIT_W / PORTRAIT_H

export const LANDSCAPE_W = 800
export const LANDSCAPE_H = 538
export const LANDSCAPE_RATIO = LANDSCAPE_W / LANDSCAPE_H

/** Grid row: poster thumbnail height = columnWidth × this. */
export const PORTRAIT_HEIGHT_PER_WIDTH = PORTRAIT_H / PORTRAIT_W
export const LANDSCAPE_HEIGHT_PER_WIDTH = LANDSCAPE_H / LANDSCAPE_W

/**
 * Image width as a fraction of the portrait frame when cropping landscape art
 * from the right edge: (800/538) / (7/10).
 */
export const PORTRAIT_CROP_WIDTH_SCALE = LANDSCAPE_RATIO / PORTRAIT_RATIO

/** Space below the thumbnail for code + title (no star row on library cards). */
export const POSTER_META_HEIGHT = 58

/** Minimum poster column width in portrait mode (drives grid density). */
export const MIN_PORTRAIT_COL_WIDTH = 135

/** Landscape min width so thumbnail height matches portrait at the same column width. */
export const MIN_LANDSCAPE_COL_WIDTH = Math.round(
  MIN_PORTRAIT_COL_WIDTH * (PORTRAIT_HEIGHT_PER_WIDTH / LANDSCAPE_HEIGHT_PER_WIDTH)
)

/** Detail pages (playlist / actress) use a denser portrait column; landscape scales to match thumb height. */
export const DETAIL_POSTER_MIN_COL_WIDTH = 128
export const DETAIL_LANDSCAPE_MIN_COL_WIDTH = Math.round(
  DETAIL_POSTER_MIN_COL_WIDTH * (PORTRAIT_HEIGHT_PER_WIDTH / LANDSCAPE_HEIGHT_PER_WIDTH)
)

/**
 * Landscape column width that yields the same thumbnail height as a portrait
 * column at `portraitColWidth`, preserving 800:538 aspect via CSS only.
 */
export function landscapeColWidthForPortraitHeight(portraitColWidth: number): number {
  return (portraitColWidth * PORTRAIT_HEIGHT_PER_WIDTH) / LANDSCAPE_HEIGHT_PER_WIDTH
}

export interface PosterGridLayout {
  columnCount: number
  columnWidth: number
  widthRemainder: number
  posterHeight: number
}

/** Derive virtual poster grid columns; thumbnail height always comes from aspect ratio × width. */
export function computePosterGridLayout(
  layoutWidth: number,
  mode: 'portrait' | 'landscape',
  gap = 12
): PosterGridLayout {
  const minColWidth = mode === 'portrait' ? MIN_PORTRAIT_COL_WIDTH : MIN_LANDSCAPE_COL_WIDTH
  const heightPerWidth =
    mode === 'portrait' ? PORTRAIT_HEIGHT_PER_WIDTH : LANDSCAPE_HEIGHT_PER_WIDTH

  const columnCount = Math.max(1, Math.floor((layoutWidth + gap) / (minColWidth + gap)))
  const totalGap = gap * Math.max(0, columnCount - 1)
  const available = Math.max(0, layoutWidth - totalGap)
  const columnWidth = columnCount > 0 ? Math.floor(available / columnCount) : minColWidth
  const widthRemainder = columnCount > 0 ? available - columnWidth * columnCount : 0
  const posterHeight = Math.round(columnWidth * heightPerWidth)

  return { columnCount, columnWidth, widthRemainder, posterHeight }
}
