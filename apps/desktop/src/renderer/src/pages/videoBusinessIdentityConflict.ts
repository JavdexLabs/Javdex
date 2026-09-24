export function isVideoBusinessIdentityConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('影片业务身份') ||
    message.includes("idx_videos_business_identity") ||
    message.includes('UNIQUE constraint failed: videos.publisher_organization_id, videos.code, videos.release_date')
  )
}
