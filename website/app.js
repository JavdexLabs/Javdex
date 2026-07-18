const RELEASE_PAGE = 'https://github.com/JavdexLabs/Javdex/releases/latest'

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const megabytes = bytes / (1024 * 1024)
  return `${megabytes >= 100 ? megabytes.toFixed(0) : megabytes.toFixed(1)} MB`
}

function formatDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(date)
}

function updateRelease(manifest) {
  const version = manifest.version || '最新正式版'
  document.querySelectorAll('[data-release-version]').forEach((element) => {
    element.textContent = version
  })

  const releaseDate = document.querySelector('[data-release-date]')
  if (releaseDate) releaseDate.textContent = formatDate(manifest.publishedAt)

  document.querySelectorAll('[data-download]').forEach((link) => {
    const key = link.dataset.download
    const asset = manifest.downloads?.[key]
    const meta = link.querySelector('[data-download-meta]')

    if (!asset?.url) {
      link.href = manifest.releaseUrl || RELEASE_PAGE
      if (meta) meta.textContent = '前往 Release 选择文件'
      return
    }

    link.href = asset.url
    link.setAttribute('aria-label', `下载 ${asset.name}`)
    if (meta) {
      const size = formatBytes(asset.size)
      meta.textContent = size ? `${asset.name} · ${size}` : asset.name
      meta.title = asset.name
    }
  })

  const status = document.querySelector('[data-release-status]')
  if (status) status.textContent = `已连接 GitHub Release · ${version}`
}

async function loadRelease() {
  const status = document.querySelector('[data-release-status]')
  try {
    const response = await fetch('./release.json', { cache: 'no-cache' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    updateRelease(await response.json())
  } catch {
    if (status) status.textContent = '暂时无法读取安装包清单，按钮将前往 GitHub Latest Release'
  }
}

function detectPlatform() {
  const platform = `${navigator.userAgentData?.platform || ''} ${navigator.platform || ''} ${
    navigator.userAgent || ''
  }`.toLowerCase()

  if (platform.includes('win')) return 'windows'
  if (platform.includes('mac')) return 'macos'
  if (platform.includes('linux') || platform.includes('x11')) return 'linux'
  return null
}

function markRecommendedPlatform() {
  const platform = detectPlatform()
  if (!platform) return
  const card = document.querySelector(`[data-platform-card="${platform}"]`)
  if (!card) return
  card.classList.add('is-recommended')
  const badge = card.querySelector('[data-recommended-badge]')
  if (badge) badge.hidden = false
}

function setupReveal() {
  const elements = [...document.querySelectorAll('.reveal')]
  if (!('IntersectionObserver' in window)) {
    elements.forEach((element) => element.classList.add('is-visible'))
    return
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return
        entry.target.classList.add('is-visible')
        observer.unobserve(entry.target)
      })
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
  )

  elements.forEach((element) => observer.observe(element))
}

function setupLightbox() {
  const dialog = document.querySelector('.lightbox')
  const image = dialog?.querySelector('img')
  const caption = dialog?.querySelector('p')
  const closeButton = dialog?.querySelector('.lightbox-close')
  if (!dialog || !image || !caption || !closeButton) return

  document.querySelectorAll('[data-lightbox-src]').forEach((button) => {
    button.addEventListener('click', () => {
      image.src = button.dataset.lightboxSrc
      image.alt = button.dataset.lightboxAlt || '软件截图'
      caption.textContent = image.alt
      dialog.showModal()
    })
  })

  closeButton.addEventListener('click', () => dialog.close())
  dialog.addEventListener('click', (event) => {
    const bounds = dialog.getBoundingClientRect()
    const isBackdrop =
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    if (isBackdrop) dialog.close()
  })
  dialog.addEventListener('close', () => {
    image.removeAttribute('src')
  })
}

markRecommendedPlatform()
setupReveal()
setupLightbox()
loadRelease()
