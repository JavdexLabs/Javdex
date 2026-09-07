const RELEASE_PAGE = "https://github.com/JavdexLabs/Javdex/releases/latest";

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes >= 100 ? megabytes.toFixed(0) : megabytes.toFixed(1)} MB`;
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

function updateRelease(manifest) {
  const version = manifest.version || "最新正式版";
  document.querySelectorAll("[data-release-version]").forEach((element) => {
    element.textContent = version;
  });

  const releaseDate = document.querySelector("[data-release-date]");
  if (releaseDate) releaseDate.textContent = formatDate(manifest.publishedAt);

  document.querySelectorAll("[data-download]").forEach((link) => {
    const key = link.dataset.download;
    const asset = manifest.downloads?.[key];
    const meta = link.querySelector("[data-download-meta]");

    if (!asset?.url) {
      link.href = manifest.releaseUrl || RELEASE_PAGE;
      if (meta) meta.textContent = "前往 Release 选择文件";
      return;
    }

    link.href = asset.url;
    link.setAttribute("aria-label", `下载 ${asset.name}`);
    if (meta) {
      const size = formatBytes(asset.size);
      meta.textContent = size ? `${asset.name} · ${size}` : asset.name;
      meta.title = asset.name;
    }
  });

  const status = document.querySelector("[data-release-status]");
  if (status)
    status.textContent = Object.values(manifest.downloads || {}).some(
      (asset) => asset?.url,
    )
      ? `安装包来自 GitHub Release · ${version}`
      : "暂时无法读取安装包清单，可前往 GitHub Release 选择文件";
}

async function loadRelease() {
  const status = document.querySelector("[data-release-status]");
  try {
    const response = await fetch("./release.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest = await response.json();
    if (manifest.schemaVersion !== 1) throw new Error("Unsupported manifest");
    updateRelease(manifest);
  } catch {
    updateRelease({ downloads: {}, releaseUrl: RELEASE_PAGE });
    if (status)
      status.textContent =
        "暂时无法读取安装包清单，按钮将前往 GitHub Latest Release";
  }
}

function detectPlatform() {
  const platform =
    `${navigator.userAgentData?.platform || ""} ${navigator.platform || ""} ${
      navigator.userAgent || ""
    }`.toLowerCase();

  if (platform.includes("win")) return "windows";
  if (platform.includes("mac")) return "macos";
  if (platform.includes("linux") || platform.includes("x11")) return "linux";
  return null;
}

function markRecommendedPlatform() {
  const platform = detectPlatform();
  if (!platform) return;
  const card = document.querySelector(`[data-platform-card="${platform}"]`);
  if (!card) return;
  card.classList.add("is-recommended");
  const badge = card.querySelector("[data-recommended-badge]");
  if (badge) badge.hidden = false;
}

function setupReveal() {
  const elements = [...document.querySelectorAll(".reveal")];
  if (
    !("IntersectionObserver" in window) ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    elements.forEach((element) => element.classList.add("is-visible"));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );

  document.documentElement.classList.add("js-motion");
  elements.forEach((element) => observer.observe(element));
}

function setupLightbox() {
  const dialog = document.querySelector(".lightbox");
  const image = dialog?.querySelector("img");
  const caption = dialog?.querySelector("p");
  const closeButton = dialog?.querySelector(".lightbox-close");
  if (!dialog || !image || !caption || !closeButton) return;

  document.querySelectorAll("[data-lightbox-src]").forEach((button) => {
    button.addEventListener("click", () => {
      image.src = button.dataset.lightboxSrc;
      image.alt = button.dataset.lightboxAlt || "软件截图";
      caption.textContent = image.alt;
      dialog.showModal();
      document.body.style.overflow = "hidden";
    });
  });

  closeButton.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    const bounds = dialog.getBoundingClientRect();
    const isBackdrop =
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom;
    if (isBackdrop) dialog.close();
  });
  dialog.addEventListener("close", () => {
    image.removeAttribute("src");
    document.body.style.overflow = "";
  });
}

const productViews = [
  [
    "library",
    "多媒体库，按你的方式组织。",
    "独立设置来源目录，搜索番号、标题与演员，组合筛选与排序。横版封面与竖版展示可以在外观设置中切换。",
  ],
  [
    "video-detail",
    "影片的故事与资源，都在这里。",
    "查看封面、发行信息、演员、简介与关联资源，维护个人评分。封面与详情背景可以分别设置。",
  ],
  [
    "playlist",
    "把喜欢的作品，放在同一份清单。",
    "跨媒体库收录影片，维护清单封面和相关链接。借助 AI 导入网页清单时，先匹配已有影片，不会下载播放资源。",
  ],
];
const workflowSteps = [
  [
    "create-1",
    "设置 / 媒体库 / 新建媒体库",
    "给你的收藏，一个名字。",
    "在“设置 → 媒体库”新建媒体库。填写名称，选择图标和标识颜色，方便在侧栏辨认。",
    "也可以从侧栏“媒体库”旁的加号进入同一个创建向导。",
  ],
  [
    "create-2",
    "新建媒体库 / 根目录",
    "选择影片所在的目录。",
    "点击“选择目录”，添加一个或多个本地来源。软件扫描本地视频与 STRM 文件，将它们关联到影片资料。",
    "也可以跳过此步先创建空库，稍后补充目录或手动导入链接。",
  ],
  [
    "create-3",
    "新建媒体库 / 扫描配置",
    "让扫描符合你的习惯。",
    "设置自动扫描、最小时长、默认刮削来源与显示选项。已有本地 NFO 时，可以保留默认开启的“自动导入本地 NFO”。",
    "这些选项只作用于当前媒体库；联网刮削需要可用来源。",
  ],
  [
    "create-4",
    "新建媒体库 / 首次扫描",
    "确认配置，完成创建。",
    "检查创建摘要。有已选目录时，可选择创建后立即扫描；也可稍后在媒体库“来源与扫描”中手动启动。",
    "当前截图演示空库创建，因此没有来源目录，立即扫描选项不可用。",
  ],
  [
    "sources",
    "设置 / 刮削来源 / 影片",
    "选择来源，再补齐资料。",
    "选择并配置可用刮削来源，在影片详情执行刮削，或选中多部影片批量处理。也能按字段组合不同来源。",
    "内置 MetaTube 需要连接自己的服务。普通插件刮削无需配置 AI 模型。",
  ],
  [
    "library",
    "媒体库 / 影片列表",
    "开始浏览与整理。",
    "按番号、标题或演员搜索，组合筛选与排序。查看影片详情，把喜欢的作品加入清单；有疑问时到“待确认”核对。",
    "资料与资源集中管理，播放或打开链接由系统默认应用处理。",
  ],
];

function animatePanel(panel) {
  panel.classList.remove("panel-enter");
  void panel.offsetWidth;
  panel.classList.add("panel-enter");
}

function updateScreenshot(button, file, label) {
  const src = `./assets/screenshots/${file}.webp`;
  button.dataset.lightboxSrc = src;
  button.dataset.lightboxAlt = label;
  button.setAttribute("aria-label", `放大${label}`);
  const image = button.querySelector("img");
  image.src = src;
  image.alt = label;
}

function setupTabGroup(selector, panelId, update) {
  const tabs = [...document.querySelectorAll(selector)];
  const panel = document.getElementById(panelId);
  if (!tabs.length || !panel) return null;
  let selected = 0;
  const select = (index, focus = false) => {
    selected = index;
    tabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
    });
    panel.setAttribute("aria-labelledby", tabs[index].id);
    update(index, panel);
    animatePanel(panel);
    if (focus) tabs[index].focus();
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(index));
    tab.addEventListener("keydown", (event) => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      if (event.key === "ArrowLeft")
        next = (index + tabs.length - 1) % tabs.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = tabs.length - 1;
      if (next !== undefined) {
        event.preventDefault();
        select(next, true);
      }
    });
  });
  return () => select((selected + 1) % tabs.length, true);
}

setupTabGroup("[data-view]", "product-panel", (index, panel) => {
  const [file, title, copy] = productViews[index];
  updateScreenshot(panel.querySelector(".screen-button"), file, title);
  document.querySelector("[data-view-title]").textContent = title;
  document.querySelector("[data-view-copy]").textContent = copy;
});
const nextStep = setupTabGroup(
  "[data-step]",
  "workflow-panel",
  (index, panel) => {
    const [file, location, title, copy, tip] = workflowSteps[index];
    for (const [key, value] of Object.entries({
      location,
      title,
      copy,
      tip,
      count: `0${index + 1} / 06`,
    })) {
      panel.querySelector(`[data-step-${key}]`).textContent = value;
    }
    updateScreenshot(panel.querySelector(".screen-button"), file, title);
    const next = panel.querySelector("[data-next]");
    next.firstChild.textContent = index === 5 ? "回到第一步 " : "下一步 ";
  },
);
document
  .querySelector("[data-next]")
  ?.addEventListener("click", () => nextStep?.());

markRecommendedPlatform();
setupReveal();
setupLightbox();
loadRelease();
