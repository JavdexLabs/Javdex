const AVATAR_AUTO_CROP_SAVED_EVENT = 'javdex:avatar-auto-crop-saved'

export function notifyAvatarAutoCropSaved(actressId: number): void {
  window.dispatchEvent(
    new CustomEvent<{ actressId: number }>(AVATAR_AUTO_CROP_SAVED_EVENT, {
      detail: { actressId }
    })
  )
}

export function onAvatarAutoCropSaved(listener: (actressId: number) => void): () => void {
  const handle = (event: Event): void => {
    const detail = (event as CustomEvent<{ actressId?: number }>).detail
    if (typeof detail?.actressId === 'number') listener(detail.actressId)
  }
  window.addEventListener(AVATAR_AUTO_CROP_SAVED_EVENT, handle)
  return () => window.removeEventListener(AVATAR_AUTO_CROP_SAVED_EVENT, handle)
}
