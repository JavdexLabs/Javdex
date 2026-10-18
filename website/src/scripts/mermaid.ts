import mermaid from 'mermaid';

function getTheme(): 'dark' | 'default' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default';
}

let counter = 0;
let activeWrapper: HTMLElement | null = null;
let dialogEl: HTMLDialogElement | null = null;
let canvasEl: HTMLElement | null = null;
let scaleLabelEl: HTMLElement | null = null;
let scale = 1;
let panX = 0;
let panY = 0;

const MIN_SCALE = 0.4;
const MAX_SCALE = 5;
const ZOOM_STEP = 0.25;

function clampScale(next: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(next * 100) / 100));
}

function applyTransform() {
  if (!canvasEl || !scaleLabelEl) return;
  canvasEl.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  scaleLabelEl.textContent = `${Math.round(scale * 100)}%`;
}

function resetView() {
  scale = 1;
  panX = 0;
  panY = 0;
  applyTransform();
}

function zoomBy(delta: number) {
  scale = clampScale(scale + delta);
  applyTransform();
}

function populateLightboxFromWrapper(wrapper: HTMLElement) {
  if (!canvasEl) return;
  const rawSvg = wrapper.dataset.rawSvg;
  const svgId = wrapper.dataset.svgId;
  if (!rawSvg || !svgId) return;

  // Replace the SVG id and all scoped CSS / marker url(#id...) references so styles stay intact without DOM id collisions
  const lightboxId = `${svgId}-lightbox`;
  const scopedSvgHtml = rawSvg.replaceAll(svgId, lightboxId);
  canvasEl.innerHTML = scopedSvgHtml;

  const svgEl = canvasEl.querySelector('svg');
  if (!svgEl) return;

  const viewBox = svgEl.getAttribute('viewBox');
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      const vbWidth = parts[2];
      const vbHeight = parts[3];
      const maxW = Math.max(480, window.innerWidth - 80);
      const maxH = Math.max(360, window.innerHeight - 110);
      // Scale up small/medium diagrams while fitting large diagrams cleanly in the viewport
      const fitRatio = Math.min(maxW / vbWidth, maxH / vbHeight, 2.0);
      svgEl.style.width = `${Math.round(vbWidth * fitRatio)}px`;
      svgEl.style.height = `${Math.round(vbHeight * fitRatio)}px`;
    }
  }
  svgEl.style.maxWidth = 'none';
  svgEl.querySelectorAll<SVGForeignObjectElement>('foreignObject').forEach((fo) => {
    fo.style.overflow = 'visible';
  });
}

function ensureLightbox(): HTMLDialogElement {
  if (dialogEl && document.body.contains(dialogEl)) return dialogEl;

  const dlg = document.createElement('dialog');
  dlg.className = 'mermaid-lightbox not-content';
  dlg.setAttribute('aria-label', '图表放大预览');
  dlg.innerHTML = `
    <div class="mermaid-lightbox-shell">
      <div class="mermaid-lightbox-toolbar">
        <div class="mermaid-lightbox-title">
          <strong>图表放大预览</strong>
          <small style="opacity:0.8">滚轮缩放 · 按住左键拖拽平移 · 双击切换 200% · Esc 关闭</small>
        </div>
        <div class="mermaid-lightbox-controls">
          <button type="button" class="mermaid-lightbox-btn" data-action="zoom-out" title="缩小 (-)">−</button>
          <span class="mermaid-lightbox-scale" data-role="scale">100%</span>
          <button type="button" class="mermaid-lightbox-btn" data-action="zoom-in" title="放大 (+)">+</button>
          <button type="button" class="mermaid-lightbox-btn" data-action="reset" title="重置缩放 (0)">重置 100%</button>
          <button type="button" class="mermaid-lightbox-btn" data-action="close" title="关闭预览 (Esc)">关闭 ✕</button>
        </div>
      </div>
      <div class="mermaid-lightbox-stage" data-role="stage">
        <div class="mermaid-lightbox-canvas" data-role="canvas"></div>
      </div>
    </div>
  `;

  document.body.appendChild(dlg);
  dialogEl = dlg;
  canvasEl = dlg.querySelector<HTMLElement>('[data-role="canvas"]');
  scaleLabelEl = dlg.querySelector<HTMLElement>('[data-role="scale"]');
  const stageEl = dlg.querySelector<HTMLElement>('[data-role="stage"]')!;

  dlg.querySelector('[data-action="zoom-in"]')?.addEventListener('click', () => zoomBy(ZOOM_STEP));
  dlg.querySelector('[data-action="zoom-out"]')?.addEventListener('click', () => zoomBy(-ZOOM_STEP));
  dlg.querySelector('[data-action="reset"]')?.addEventListener('click', () => resetView());
  dlg.querySelector('[data-action="close"]')?.addEventListener('click', () => dlg.close());

  stageEl.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
      zoomBy(delta);
    },
    { passive: false }
  );

  let isDragging = false;
  let hasMoved = false;
  let startX = 0;
  let startY = 0;
  let originPanX = 0;
  let originPanY = 0;

  stageEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    hasMoved = false;
    startX = e.clientX;
    startY = e.clientY;
    originPanX = panX;
    originPanY = panY;
    stageEl.classList.add('is-dragging');
    stageEl.setPointerCapture(e.pointerId);
  });

  stageEl.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) hasMoved = true;
    panX = originPanX + dx;
    panY = originPanY + dy;
    applyTransform();
  });

  const endDrag = (e: PointerEvent) => {
    if (!isDragging) return;
    isDragging = false;
    stageEl.classList.remove('is-dragging');
    if (stageEl.hasPointerCapture(e.pointerId)) {
      stageEl.releasePointerCapture(e.pointerId);
    }
    if (!hasMoved && e.target === stageEl) {
      dlg.close();
    }
  };

  stageEl.addEventListener('pointerup', endDrag);
  stageEl.addEventListener('pointercancel', endDrag);

  stageEl.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (Math.abs(scale - 1) < 0.05) {
      scale = 2;
    } else {
      scale = 1;
      panX = 0;
      panY = 0;
    }
    applyTransform();
  });

  dlg.addEventListener('keydown', (e) => {
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomBy(ZOOM_STEP);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoomBy(-ZOOM_STEP);
    } else if (e.key === '0') {
      e.preventDefault();
      resetView();
    }
  });

  dlg.addEventListener('close', () => {
    activeWrapper = null;
  });

  return dlg;
}

function openLightbox(wrapper: HTMLElement) {
  const dlg = ensureLightbox();
  activeWrapper = wrapper;
  populateLightboxFromWrapper(wrapper);
  resetView();
  if (!dlg.open) {
    dlg.showModal();
  }
}

async function renderMermaidDiagrams() {
  const elements = document.querySelectorAll<HTMLElement>('pre[data-language="mermaid"], .language-mermaid');
  if (elements.length === 0) return;

  const currentTheme = getTheme();
  mermaid.initialize({
    startOnLoad: false,
    theme: currentTheme,
    securityLevel: 'loose',
    fontFamily: 'inherit',
    flowchart: {
      htmlLabels: true,
      wrappingWidth: 960,
      minNodeWidth: 80,
      padding: 16,
      nodeSpacing: 40,
      rankSpacing: 45,
      useMaxWidth: true,
    },
    state: {
      wrappingWidth: 960,
      minNodeWidth: 80,
      useMaxWidth: true,
    },
    sequence: {
      useMaxWidth: true,
    },
  });

  for (const el of elements) {
    const figure = el.closest('figure') || el;
    let rawCode = el.dataset.rawCode;
    if (!rawCode) {
      const lineElements = el.querySelectorAll('.ec-line');
      if (lineElements.length > 0) {
        rawCode = Array.from(lineElements)
          .map((line) => line.textContent || '')
          .join('\n')
          .trim();
      } else {
        rawCode = (el.innerText || el.textContent || '').trim();
      }
      el.dataset.rawCode = rawCode;
    }
    if (!rawCode) continue;

    let container = figure.nextElementSibling as HTMLElement | null;
    if (!container || !container.classList.contains('mermaid-wrapper')) {
      container = document.createElement('div');
      container.className = 'mermaid-wrapper not-content';
      container.tabIndex = 0;
      container.setAttribute('role', 'button');
      container.setAttribute('aria-label', '点击放大查看图表');
      container.title = '点击放大查看';

      const wrapperRef = container;
      container.addEventListener('click', () => openLightbox(wrapperRef));
      container.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openLightbox(wrapperRef);
        }
      });

      figure.parentNode?.insertBefore(container, figure.nextSibling);
      (figure as HTMLElement).style.display = 'none';
    }

    const id = `mermaid-graph-${++counter}`;
    try {
      const { svg } = await mermaid.render(id, rawCode);
      container.dataset.rawSvg = svg;
      container.dataset.svgId = id;
      container.innerHTML = `${svg}<span class="mermaid-zoom-hint" aria-hidden="true">🔍 点击放大</span>`;
      container.querySelectorAll<SVGForeignObjectElement>('foreignObject').forEach((fo) => {
        fo.style.overflow = 'visible';
      });
    } catch (err) {
      console.warn('Failed to render Mermaid diagram:', err);
      (figure as HTMLElement).style.display = '';
      container.remove();
    }
  }

  if (activeWrapper && dialogEl?.open) {
    populateLightboxFromWrapper(activeWrapper);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    void renderMermaidDiagrams();
  });
} else {
  void renderMermaidDiagrams();
}

document.addEventListener('astro:page-load', () => {
  void renderMermaidDiagrams();
});

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
      void renderMermaidDiagrams();
    }
  }
});
observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
