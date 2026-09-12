export const ACTRESS_GRID_GAP = 12
export const ACTRESS_GRID_MIN_CARD_WIDTH = 132

export interface ActressGridLayout {
  columnCount: number
  cardWidth: number
  columnStride: number
  rowHeight: number
}

export function computeActressGridLayout(layoutWidth: number): ActressGridLayout {
  const columnCount = Math.max(
    1,
    Math.floor(
      (Math.max(0, layoutWidth) + ACTRESS_GRID_GAP) /
        (ACTRESS_GRID_MIN_CARD_WIDTH + ACTRESS_GRID_GAP)
    )
  )
  const cardWidth = Math.max(
    1,
    (Math.max(0, layoutWidth) - ACTRESS_GRID_GAP * (columnCount - 1)) / columnCount
  )
  return {
    columnCount,
    cardWidth,
    columnStride: cardWidth + ACTRESS_GRID_GAP,
    rowHeight: cardWidth + ACTRESS_GRID_GAP
  }
}

export function actressGridSlotCount(
  itemCount: number,
  columnCount: number,
  showStatusRow: boolean
): { renderedCount: number; statusRowStart: number } {
  const statusRowStart = Math.ceil(itemCount / columnCount) * columnCount
  return {
    renderedCount: showStatusRow ? statusRowStart + columnCount : itemCount,
    statusRowStart
  }
}
