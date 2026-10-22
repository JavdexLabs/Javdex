// Experimental offscreen Linux playback. libmpv and driver code stay in this
// helper process; Electron receives only exported DMA-BUF descriptors over an
// inherited anonymous SOCK_SEQPACKET pair. No X11/Wayland window is created.
#define GL_GLEXT_PROTOTYPES
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GL/gl.h>
#include <GL/glext.h>
#include <gbm.h>
#include <xf86drm.h>
#include <drm_fourcc.h>
#include "linuxVulkanModifiers.h"
#define JAVDEX_STANDALONE_PLAYBACK
#include "mpvCore.h"
#include "linuxDmaBuf.h"
#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <poll.h>
#include <signal.h>
#include <sys/eventfd.h>
#include <sys/prctl.h>
#include <sys/stat.h>

namespace {
using namespace javdex;
using namespace javdex::dmabuf;
// Resolve core GL calls through the same EGL implementation as libmpv. A
// separately bundled libOpenGL forwarder can disagree with host dispatch.
decltype(&::glBindFramebuffer) glBindFramebuffer = nullptr;
decltype(&::glBindTexture) glBindTexture = nullptr;
decltype(&::glCheckFramebufferStatus) glCheckFramebufferStatus = nullptr;
decltype(&::glClear) glClear = nullptr;
decltype(&::glClearColor) glClearColor = nullptr;
decltype(&::glColorMask) glColorMask = nullptr;
decltype(&::glDeleteFramebuffers) glDeleteFramebuffers = nullptr;
decltype(&::glDeleteTextures) glDeleteTextures = nullptr;
decltype(&::glDisable) glDisable = nullptr;
decltype(&::glFinish) glFinish = nullptr;
decltype(&::glFramebufferTexture2D) glFramebufferTexture2D = nullptr;
decltype(&::glGenFramebuffers) glGenFramebuffers = nullptr;
decltype(&::glGenTextures) glGenTextures = nullptr;
decltype(&::glGetError) glGetError = nullptr;
decltype(&::glGetIntegerv) glGetIntegerv = nullptr;
decltype(&::glGetString) glGetString = nullptr;
decltype(&::glTexParameteri) glTexParameteri = nullptr;
void loadGlFunctions() {
    glBindFramebuffer = reinterpret_cast<decltype(glBindFramebuffer)>(eglGetProcAddress("glBindFramebuffer"));
    if (!glBindFramebuffer) throw std::runtime_error("Required EGL OpenGL entry point is unavailable");
    glBindTexture = reinterpret_cast<decltype(glBindTexture)>(eglGetProcAddress("glBindTexture"));
    if (!glBindTexture) throw std::runtime_error("Required EGL OpenGL entry point is unavailable");
    glCheckFramebufferStatus = reinterpret_cast<decltype(glCheckFramebufferStatus)>(eglGetProcAddress("glCheckFramebufferStatus"));
    if (!glCheckFramebufferStatus) throw std::runtime_error("Required EGL OpenGL entry point is unavailable");
    glClear = reinterpret_cast<decltype(glClear)>(eglGetProcAddress("glClear"));
    if (!glClear) throw std::runtime_error("Required EGL OpenGL entry point is unavailable");
    glClearColor = reinterpret_cast<decltype(glClearColor)>(eglGetProcAddress("glClearColor"));
    if (!glClearColor) throw std::runtime_error("Required EGL OpenGL entry point is unavailable");
    glColorMask = reinterpret_cast<decltype(glColorMask)>(eglGetProcAddress("glColorMask"));
    if (!glColorMask) throw std::runtime_error("Required EGL OpenGL entry point is unavailable");
    glDeleteFramebuffers = reinterpret_cast<decltype(glDeleteFramebuffers)>(eglGetProcAddress("glDeleteFramebuffers"));
    if (!glDeleteFramebuffers) throw std::runtime_error("Required EGL OpenGL entry point is unavailable");
    glDeleteTextures = reinterpret_cast<decltype(glDeleteTextures)>(eglGetProcAddress("glDeleteTextures"));
    if (!glDeleteTextures) throw std::runtime_error("Required EGL OpenGL entry point is unavailable");
    glDisable = reinterpret_cast<decltype(glDisable)>(eglGetProcAddress("glDisable"));
    if (!glDisable) throw std::runtime_error("Required EGL OpenGL entry point is unavailable");
    glFinish = reinterpret_cast<decltype(glFinish)>(eglGetProcAddress("glFinish"));
    if (!glFinish) throw std::runtime_error("Required EGL OpenGL entry point is unavailable");
    glFramebufferTexture2D = reinterpret_cast<decltype(glFramebufferTexture2D)>(eglGetProcAddress("glFramebufferTexture2D"));
    if (!glFramebufferTexture2D) throw std::runtime_error("Required EGL OpenGL entry point is unavailable");
    glGenFramebuffers = reinterpret_cast<decltype(glGenFramebuffers)>(eglGetProcAddress("glGenFramebuffers"));
    if (!glGenFramebuffers) throw std::runtime_error("Required EGL OpenGL entry point is unavailable");
    glGenTextures = reinterpret_cast<decltype(glGenTextures)>(eglGetProcAddress("glGenTextures"));
    if (!glGenTextures) throw std::runtime_error("Required EGL OpenGL entry point is unavailable");
    glGetError = reinterpret_cast<decltype(glGetError)>(eglGetProcAddress("glGetError"));
    if (!glGetError) throw std::runtime_error("Required EGL OpenGL entry point is unavailable");
    glGetIntegerv = reinterpret_cast<decltype(glGetIntegerv)>(eglGetProcAddress("glGetIntegerv"));
    if (!glGetIntegerv) throw std::runtime_error("Required EGL OpenGL entry point is unavailable");
    glGetString = reinterpret_cast<decltype(glGetString)>(eglGetProcAddress("glGetString"));
    if (!glGetString) throw std::runtime_error("Required EGL OpenGL entry point is unavailable");
    glTexParameteri = reinterpret_cast<decltype(glTexParameteri)>(eglGetProcAddress("glTexParameteri"));
    if (!glTexParameteri) throw std::runtime_error("Required EGL OpenGL entry point is unavailable");
}
MpvCore playback;
Leases leases;
Bounds requested;
bool rendererControls = true;
bool selfTestRequested = false, selfTestSent = false;
PublicationState publication;
std::string presentation = "expanded";
int wakeFd = -1, pixelWidth = 1, pixelHeight = 1;
uint64_t now() { return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count(); }
void *getProcAddress(void *, const char *name) { return reinterpret_cast<void *>(eglGetProcAddress(name)); }
void wake(void *) {
    const uint64_t value = 1;
    // eventfd is nonblocking; a saturated counter already guarantees a wake.
    // No mpv or EGL calls are allowed from this callback.
    if (wakeFd >= 0) { ssize_t written; do { written = write(wakeFd, &value, sizeof(value)); } while (written < 0 && errno == EINTR); }
}
bool extension(const char *list, const char *name) {
    if (!list) return false;
    const std::string all = std::string(" ") + list + ' ';
    return all.find(std::string(" ") + name + ' ') != std::string::npos;
}
struct Buffer {
    gbm_bo *bo = nullptr;
    EGLImageKHR image = EGL_NO_IMAGE_KHR;
    GLuint texture = 0, framebuffer = 0;
    int fd = -1, width = 0, height = 0;
    uint32_t stride = 0, offset = 0;
    uint64_t size = 0, modifier = DRM_FORMAT_MOD_INVALID;
};
class Gpu {
    int node = -1;
    gbm_device *device = nullptr;
    EGLDisplay display = EGL_NO_DISPLAY;
    EGLContext context = EGL_NO_CONTEXT;
    PFNEGLCREATEIMAGEKHRPROC createImage = nullptr;
    PFNEGLDESTROYIMAGEKHRPROC destroyImage = nullptr;
    using ImageTarget = void (APIENTRYP)(GLenum, void *);
    ImageTarget imageTarget = nullptr;
    bool explicitModifiers = false;
    int maximum = maxDimension;
    std::array<Buffer, slotCount> buffers{};
    void release(Buffer &buffer) noexcept {
        if (buffer.framebuffer) glDeleteFramebuffers(1, &buffer.framebuffer);
        if (buffer.texture) glDeleteTextures(1, &buffer.texture);
        if (buffer.image != EGL_NO_IMAGE_KHR && destroyImage) destroyImage(display, buffer.image);
        if (buffer.fd >= 0) close(buffer.fd);
        if (buffer.bo) gbm_bo_destroy(buffer.bo);
        buffer = {};
    }
public:
    bool alive() const { return context != EGL_NO_CONTEXT; }
    void shutdown() noexcept {
        for (auto &buffer : buffers) release(buffer);
        if (display != EGL_NO_DISPLAY) {
            eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
            if (context != EGL_NO_CONTEXT) eglDestroyContext(display, context);
            eglTerminate(display);
        }
        context = EGL_NO_CONTEXT; display = EGL_NO_DISPLAY;
        if (device) gbm_device_destroy(device);
        device = nullptr;
        if (node >= 0) close(node);
        node = -1; createImage = nullptr; destroyImage = nullptr; imageTarget = nullptr;
    }
    std::vector<uint64_t> consumerModifiers;
    void initialize(const char *path) {
        node = open(path, O_RDWR | O_CLOEXEC | O_NOCTTY);
        if (node < 0) throw std::runtime_error("Cannot open DRM render node (missing device or permission)");
        struct stat status{};
        if (fstat(node, &status) != 0 || !S_ISCHR(status.st_mode) || drmGetNodeTypeFromFd(node) != DRM_NODE_RENDER)
            throw std::runtime_error("Selected device is not a DRM render node");
        if (const char *loader = std::getenv("JAVDEX_PLAYBACK_VULKAN_LOADER"))
            consumerModifiers = javdex::vulkanDmaBufModifiers(loader, node);
        device = gbm_create_device(node);
        if (!device) throw std::runtime_error("Cannot create GBM device on DRM render node");
        auto platformDisplay = reinterpret_cast<PFNEGLGETPLATFORMDISPLAYEXTPROC>(eglGetProcAddress("eglGetPlatformDisplayEXT"));
        if (!platformDisplay) throw std::runtime_error("EGL platform display extension is unavailable");
        display = platformDisplay(EGL_PLATFORM_GBM_KHR, device, nullptr);
        EGLint major = 0, minor = 0;
        if (display == EGL_NO_DISPLAY || !eglInitialize(display, &major, &minor))
            throw std::runtime_error("Cannot initialize EGL on DRM render node");
        const auto *extensions = eglQueryString(display, EGL_EXTENSIONS);
        if (!extension(extensions, "EGL_EXT_image_dma_buf_import")
            || !extension(extensions, "EGL_KHR_image_base")
            || !extension(extensions, "EGL_KHR_surfaceless_context")
            || !extension(extensions, "EGL_KHR_create_context"))
            throw std::runtime_error("Required EGL DMA-BUF, image, context or surfaceless extension is unavailable");
        explicitModifiers = extension(extensions, "EGL_EXT_image_dma_buf_import_modifiers");
        if (!eglBindAPI(EGL_OPENGL_API)) throw std::runtime_error("EGL OpenGL API is unavailable");
        const EGLint configuration[] = {EGL_SURFACE_TYPE, 0, EGL_RENDERABLE_TYPE, EGL_OPENGL_BIT,
            EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_NONE};
        EGLConfig config{}; EGLint count = 0;
        if (!eglChooseConfig(display, configuration, &config, 1, &count) || count != 1)
            throw std::runtime_error("No compatible EGL OpenGL configuration");
        const EGLint attributes[] = {EGL_CONTEXT_MAJOR_VERSION_KHR, 3, EGL_CONTEXT_MINOR_VERSION_KHR, 2,
            EGL_CONTEXT_OPENGL_PROFILE_MASK_KHR, EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT_KHR, EGL_NONE};
        context = eglCreateContext(display, config, EGL_NO_CONTEXT, attributes);
        if (context == EGL_NO_CONTEXT || !eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, context))
            throw std::runtime_error("Cannot create surfaceless OpenGL 3.2 context");
        loadGlFunctions();
        const char *renderer = reinterpret_cast<const char *>(glGetString(GL_RENDERER));
        std::string name = renderer ? renderer : "";
        std::transform(name.begin(), name.end(), name.begin(), [](unsigned char value) { return static_cast<char>(std::tolower(value)); });
        if (name.empty() || name.find("llvmpipe") != std::string::npos || name.find("softpipe") != std::string::npos
            || name.find("software") != std::string::npos || name.find("swrast") != std::string::npos)
            throw std::runtime_error("Shared-texture playback requires a hardware EGL renderer");
        createImage = reinterpret_cast<PFNEGLCREATEIMAGEKHRPROC>(eglGetProcAddress("eglCreateImageKHR"));
        destroyImage = reinterpret_cast<PFNEGLDESTROYIMAGEKHRPROC>(eglGetProcAddress("eglDestroyImageKHR"));
        imageTarget = reinterpret_cast<ImageTarget>(eglGetProcAddress("glEGLImageTargetTexture2DOES"));
        if (!createImage || !destroyImage || !imageTarget) throw std::runtime_error("EGL image texture functions are unavailable");
        GLint maxTexture = 0, maxRenderbuffer = 0;
        glGetIntegerv(GL_MAX_TEXTURE_SIZE, &maxTexture); glGetIntegerv(GL_MAX_RENDERBUFFER_SIZE, &maxRenderbuffer);
        maximum = std::min({maxDimension, maxTexture, maxRenderbuffer});
        if (maximum < 1) throw std::runtime_error("Invalid OpenGL render limits");
    }
    Buffer &prepare(size_t index, int width, int height) {
        if (index >= slotCount || width < 1 || height < 1 || width > maximum || height > maximum)
            throw std::runtime_error("DMA-BUF viewport exceeds GPU limits");
        auto &buffer = buffers[index];
        if (buffer.bo && buffer.width == width && buffer.height == height) return buffer;
        // Called only for an unleased slot. Resize never frees or overwrites a
        // BO still held by Chromium; at most three BOs exist across all sizes.
        release(buffer);
        if (!consumerModifiers.empty()) {
            // Allocate only a layout that the Vulkan consumer can import. An
            // EGL-renderable proprietary layout need not be Vulkan-compatible.
            for (const auto modifier : consumerModifiers) {
                buffer.bo = gbm_bo_create_with_modifiers2(device, width, height, GBM_FORMAT_ARGB8888,
                    &modifier, 1, GBM_BO_USE_RENDERING);
                if (buffer.bo) break;
            }
        } else {
            buffer.bo = gbm_bo_create(device, width, height, GBM_FORMAT_ARGB8888, GBM_BO_USE_RENDERING | GBM_BO_USE_LINEAR);
            if (!buffer.bo && explicitModifiers)
                buffer.bo = gbm_bo_create(device, width, height, GBM_FORMAT_ARGB8888, GBM_BO_USE_RENDERING);
        }
        if (!buffer.bo) throw std::runtime_error("Cannot allocate renderable GBM buffer");
        buffer.modifier = gbm_bo_get_modifier(buffer.bo);
        if (!consumerModifiers.empty() && std::find(consumerModifiers.begin(), consumerModifiers.end(), buffer.modifier) == consumerModifiers.end())
            throw std::runtime_error("GBM allocation does not match the negotiated Vulkan layout");
        if (gbm_bo_get_plane_count(buffer.bo) != 1 || buffer.modifier == DRM_FORMAT_MOD_INVALID
            || (!explicitModifiers && buffer.modifier != DRM_FORMAT_MOD_LINEAR)
            || gbm_bo_get_format(buffer.bo) != GBM_FORMAT_ARGB8888)
            throw std::runtime_error("GBM did not provide a supported single-plane BGRA buffer");
        buffer.width = width; buffer.height = height;
        buffer.stride = gbm_bo_get_stride_for_plane(buffer.bo, 0); buffer.offset = gbm_bo_get_offset(buffer.bo, 0);
        buffer.size = bufferSize(width, height, buffer.stride, buffer.offset);
        buffer.fd = gbm_bo_get_fd_for_plane(buffer.bo, 0);
        if (buffer.fd < 0 || fcntl(buffer.fd, F_SETFD, FD_CLOEXEC) < 0) throw std::runtime_error("Cannot export GBM DMA-BUF descriptor");
        // DMA-BUF supports size discovery through SEEK_END. Keep the exported
        // allocation size (including padding), not a guessed plane length.
        const auto allocationSize = lseek(buffer.fd, 0, SEEK_END);
        if (allocationSize < 0 || static_cast<uint64_t>(allocationSize) < buffer.size
            || static_cast<uint64_t>(allocationSize) > maxBufferBytes || lseek(buffer.fd, 0, SEEK_SET) < 0)
            throw std::runtime_error("Cannot verify DMA-BUF allocation size");
        buffer.size = static_cast<uint64_t>(allocationSize);
        std::vector<EGLint> imageAttributes = {EGL_WIDTH, width, EGL_HEIGHT, height,
            EGL_LINUX_DRM_FOURCC_EXT, DRM_FORMAT_ARGB8888, EGL_DMA_BUF_PLANE0_FD_EXT, buffer.fd,
            EGL_DMA_BUF_PLANE0_OFFSET_EXT, static_cast<EGLint>(buffer.offset),
            EGL_DMA_BUF_PLANE0_PITCH_EXT, static_cast<EGLint>(buffer.stride)};
        if (explicitModifiers) imageAttributes.insert(imageAttributes.end(),
            {EGL_DMA_BUF_PLANE0_MODIFIER_LO_EXT, static_cast<EGLint>(buffer.modifier & 0xffffffff),
                EGL_DMA_BUF_PLANE0_MODIFIER_HI_EXT, static_cast<EGLint>(buffer.modifier >> 32)});
        imageAttributes.push_back(EGL_NONE);
        buffer.image = createImage(display, EGL_NO_CONTEXT, EGL_LINUX_DMA_BUF_EXT, nullptr, imageAttributes.data());
        if (buffer.image == EGL_NO_IMAGE_KHR) throw std::runtime_error("Cannot import GBM DMA-BUF into EGL image");
        for (unsigned errors = 0; glGetError() != GL_NO_ERROR; errors++)
            if (errors >= 15) throw std::runtime_error("OpenGL context error state did not clear");
        glGenTextures(1, &buffer.texture); glBindTexture(GL_TEXTURE_2D, buffer.texture);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        imageTarget(GL_TEXTURE_2D, buffer.image);
        glGenFramebuffers(1, &buffer.framebuffer); glBindFramebuffer(GL_FRAMEBUFFER, buffer.framebuffer);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, buffer.texture, 0);
        if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE || glGetError() != GL_NO_ERROR)
            throw std::runtime_error("DMA-BUF framebuffer is not renderable");
        glBindFramebuffer(GL_FRAMEBUFFER, 0); glBindTexture(GL_TEXTURE_2D, 0);
        return buffer;
    }
    void testPattern(Buffer &buffer) {
        glBindFramebuffer(GL_FRAMEBUFFER, buffer.framebuffer); glDisable(GL_SCISSOR_TEST);
        glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
        glClearColor(64.0f / 255, 191.0f / 255, 128.0f / 255, 1); glClear(GL_COLOR_BUFFER_BIT);
        finish(buffer);
    }
    void finish(Buffer &buffer) {
        // libmpv may leave arbitrary GL state and does not promise opaque alpha.
        // Force only alpha to one; RGB remains exactly the rendered video/OSD.
        glBindFramebuffer(GL_FRAMEBUFFER, buffer.framebuffer); glDisable(GL_SCISSOR_TEST);
        glColorMask(GL_FALSE, GL_FALSE, GL_FALSE, GL_TRUE); glClearColor(0, 0, 0, 1); glClear(GL_COLOR_BUFFER_BIT);
        glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
        // Conservative producer completion. The consumer's release callback ACK
        // is the independent lifetime fence before this BO can be reused.
        glFinish();
        if (glGetError() != GL_NO_ERROR) throw std::runtime_error("DMA-BUF frame rendering failed");
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
    }
} gpu;
int preparedSlot = -1;
std::string preparedMetadata;
uint64_t preparedSequence = 0;
void destroyPlayer() {
    // The helper exits after destroy. Closing our references does not revoke
    // Chromium's owned DMA-BUF FDs; outstanding BOs are never reused here.
    playback.shutdown(); gpu.shutdown();
    preparedSlot = -1; preparedMetadata.clear(); publication.setVisible(false);
}
void updateBounds(const Bounds &rect) {
    const int width = pixels(rect.width, rect.scale), height = pixels(rect.height, rect.scale);
    requested = rect;
    if (width != pixelWidth || height != pixelHeight) {
        pixelWidth = width; pixelHeight = height; publication.request();
        // Unsent work has no consumer ownership, so it can be replaced by the
        // newest viewport. Its sequence was not committed to the lease pool.
        preparedSlot = -1; preparedMetadata.clear();
    }
}
void create(const Bounds &rect) {
    if (gpu.alive() || playback.alive()) throw std::runtime_error("Shared-texture playback is already initialized");
    updateBounds(rect);
    const char *selected = std::getenv("JAVDEX_DRM_RENDER_NODE");
    if (selected && *selected) {
        if (*selected != '/') throw std::runtime_error("DRM render node override must be an absolute path");
        gpu.initialize(selected); gpu.prepare(0, pixelWidth, pixelHeight);
    } else {
        bool initialized = false;
        std::string reason = "No accessible DRM render node; a real GPU render node is required";
        for (unsigned index = 128; index < 256; index++) {
            const std::string path = "/dev/dri/renderD" + std::to_string(index);
            if (access(path.c_str(), F_OK) != 0) continue;
            try { gpu.initialize(path.c_str()); gpu.prepare(0, pixelWidth, pixelHeight); initialized = true; break; }
            catch (const std::exception &error) { reason = error.what(); gpu.shutdown(); }
        }
        if (!initialized) throw std::runtime_error(reason);
    }
    // This standalone EGL context deliberately has no native compositor/display
    // decoder interop. auto-copy supports VAAPI where available, with software
    // decode fallback; the rendered output still stays in GPU shared textures.
    // Both Wayland EGL and X11 ANGLE Vulkan need rendering/completion and IPC
    // headroom. With zero lead, mpv misses deadlines even with an immediate-ACK
    // consumer. Keep nonblocking render and all producer/consumer fences;
    // reserve 20ms for either DMA-BUF path, independent of modifier negotiation.
    playback.initialize(getProcAddress, nullptr, false, wake, nullptr, "auto-copy", false, "0.02");
    publication.request();
}
uint64_t timeline = 0;
bool dispatch(const std::vector<std::string> &fields) {
    const auto &op = fields.at(0);
    if (op == "create" && fields.size() == 8 && fields[1] == "0" && fields[7] == "dmabuf") create(rectangle(fields, 2));
    else if (op == "destroy" && fields.size() == 1) { destroyPlayer(); return false; }
    else if (op == "timing-reset" && fields.size() == 2) {
        const double value = finiteNumber(fields[1]);
        if (value < 1 || value > maxSequence || std::floor(value) != value) throw std::runtime_error("Invalid timing epoch");
        timeline = static_cast<uint64_t>(value);
        preparedSlot = -1; preparedMetadata.clear(); publication.request();
    }
    else if (!playback.alive()) throw std::runtime_error("No shared-texture playback session");
    else if (op == "self-test" && fields.size() == 1 && !selfTestSent) selfTestRequested = true;
    else if (op == "bounds" && fields.size() == 6) updateBounds(rectangle(fields, 1));
    else if (op == "renderer-controls" && fields.size() == 2 && (fields[1] == "0" || fields[1] == "1")) rendererControls = fields[1] == "1";
    else if (op == "occlusions" && fields.size() <= 257 && (fields.size() - 1) % 8 == 0) {
        // Renderer composition handles occlusion; still validate the wire input.
        for (size_t i = 1; i < fields.size(); i++) if (std::abs(finiteNumber(fields[i])) > 100000)
            throw std::runtime_error("Invalid playback occlusion");
    } else if (op == "visible" && fields.size() == 2 && (fields[1] == "0" || fields[1] == "1")) { publication.setVisible(fields[1] == "1"); }
    else if (op == "presentation" && fields.size() == 2 && (fields[1] == "expanded" || fields[1] == "docked" || fields[1] == "fullscreen")) presentation = fields[1];
    else if ((op == "command" || op == "generated-subtitle-command") && fields.size() >= 2 && fields.size() <= 9)
        playback.command({fields.begin() + 1, fields.end()}, op == "generated-subtitle-command");
    else if (op == "generated-subtitles" && fields.size() == 5 && (fields[3] == "0" || fields[3] == "1")) {
        const double revision = finiteNumber(fields[4]);
        if (revision < 1 || revision > maxSequence || std::floor(revision) != revision) throw std::runtime_error("Invalid subtitle revision");
        playback.generatedSubtitles(fields[1], fields[2], fields[3] == "1", static_cast<uint64_t>(revision));
    } else throw std::runtime_error("Invalid playback operation");
    return true;
}
int64_t renderStartUs = 0, targetTimeUs = 0;
int64_t monotonicUs() {
    timespec ts{};
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) throw std::runtime_error("Cannot read frame clock");
    return int64_t(ts.tv_sec) * 1000000 + ts.tv_nsec / 1000;
}
std::string metadata(const Buffer &buffer, int slot, uint64_t sequence, bool selfTest = false) {
    return "{\"protocol\":\"javdex-dmabuf-v1\",\"sequence\":" + std::to_string(sequence) + ",\"slot\":" + std::to_string(slot)
        + ",\"width\":" + std::to_string(buffer.width) + ",\"height\":" + std::to_string(buffer.height)
        + ",\"timeline\":" + std::to_string(timeline) + ",\"targetTimeUs\":" + std::to_string(targetTimeUs) + ",\"renderStartUs\":" + std::to_string(renderStartUs)
        + (selfTest ? ",\"selfTest\":\"solid-v1\"" : "")
        + ",\"pixelFormat\":\"bgra\",\"stride\":" + std::to_string(buffer.stride) + ",\"offset\":" + std::to_string(buffer.offset)
        + ",\"size\":" + std::to_string(buffer.size) + ",\"modifier\":\"" + std::to_string(buffer.modifier) + "\",\"producerComplete\":true}";
}
void render() {
    if (!playback.alive()) return;
    // Always pump mpv, even when the consumer has all slots or socket pressure
    // prevents publication. A requested frame remains pending across polls.
    const bool updated = playback.updateRequested();
    if (updated) publication.request();
    if (!publication.visible()) {
        // Hidden/unbound surfaces have no consumer. Discard unsent work and
        // consume mpv updates without leasing BOs or accumulating a timeout.
        preparedSlot = -1; preparedMetadata.clear(); publication.stalled(false, now());
        if (updated) {
            if (!playback.skipRender()) throw std::runtime_error("libmpv could not skip a hidden frame");
            /* No physical swap feedback is available through Canvas. */
        }
        publication.request();
        return;
    }
    // Known pixels, independent of media. One leased 640x360 buffer per helper;
    // normal release fencing applies. The host bounds validation time.
    if (selfTestRequested && !selfTestSent) {
        const int slot = leases.available();
        if (slot >= 0) {
            auto &buffer = gpu.prepare(slot, 640, 360);
            gpu.testPattern(buffer);
            renderStartUs = monotonicUs(); targetTimeUs = 0;
            const auto sequence = leases.next();
            if (sendFrame(transportFd, metadata(buffer, slot, sequence, true), buffer.fd)) {
                leases.publish(slot, sequence); selfTestSent = true;
            }
        }
        if (updated && !playback.skipRender()) throw std::runtime_error("libmpv could not skip a hidden frame");
        publication.request(); return;
    }
    if (!publication.pending() && preparedSlot < 0) { publication.stalled(false, now()); return; }
    bool rendered = false;
    if (preparedSlot < 0) {
        const int slot = leases.available();
        if (slot >= 0) {
            auto &buffer = gpu.prepare(slot, pixelWidth, pixelHeight);
            const auto delay = playback.nextFrameDelayUs();
            renderStartUs = monotonicUs();
            targetTimeUs = delay ? renderStartUs + delay : 0;
            if (!playback.render(pixelWidth, pixelHeight, static_cast<int>(buffer.framebuffer), false))
                throw std::runtime_error("libmpv could not render the shared texture");
            gpu.finish(buffer); rendered = true; preparedSlot = slot; preparedSequence = leases.next();
            preparedMetadata = metadata(buffer, slot, preparedSequence); publication.consumed();
        }
    }
    if (preparedSlot >= 0) {
        auto &buffer = gpu.prepare(preparedSlot, pixelWidth, pixelHeight);
        if (sendFrame(transportFd, preparedMetadata, buffer.fd)) {
            leases.publish(preparedSlot, preparedSequence); /* No physical swap feedback is available through Canvas. */
            // Actual renderer presentation is tracked by the host. Exporting a
            // BO is not proof that Chromium displayed it.
            preparedSlot = -1; preparedMetadata.clear(); publication.stalled(false, now()); return;
        }
    }
    if (updated && !rendered) {
        // The consumer owns all writable BOs (or an earlier packet is waiting
        // for socket space). Drop this queued mpv frame rather than block its
        // playback clock; redraw demand still points at the newest frame.
        if (!playback.skipRender()) throw std::runtime_error("libmpv could not skip a backpressured frame");
        /* No physical swap feedback is available through Canvas. */
    }
    if (publication.stalled(true, now())) throw std::runtime_error("DMA-BUF consumer stalled waiting for frame release");
}
std::string state() {
    auto result = playback.stateJson(); result.pop_back();
    return result + ",\"backend\":\"linux-dmabuf\",\"pixelWidth\":" + std::to_string(pixelWidth) + ",\"pixelHeight\":" + std::to_string(pixelHeight)
        + ",\"rendererFullscreenControls\":" + (rendererControls ? "true" : "false") + ",\"nativeVideoFocused\":false"
        + ",\"exportedFrames\":" + std::to_string(leases.latest()) + ",\"dmaBufInFlight\":" + std::to_string(leases.inFlight()) + '}';
}
class Output {
    std::string bytes;
    uint64_t blocked = 0;
public:
    bool pending() const { return !bytes.empty(); }
    void emit(const std::string &message) {
        if (bytes.size() + message.size() > 1024 * 1024) throw std::runtime_error("Playback state output overflow");
        bytes += message + '\n'; flush();
    }
    void flush() {
        while (!bytes.empty()) {
            const auto count = write(STDOUT_FILENO, bytes.data(), bytes.size());
            if (count < 0 && errno == EINTR) continue;
            if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
                if (!blocked) blocked = now();
                if (now() - blocked >= stallTimeoutMs) throw std::runtime_error("Playback state consumer stalled");
                return;
            }
            if (count <= 0) throw std::runtime_error("Playback host disconnected");
            bytes.erase(0, static_cast<size_t>(count)); blocked = 0;
        }
    }
};
void nonblocking(int fd) {
    const int flags = fcntl(fd, F_GETFL);
    if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) throw std::runtime_error("Cannot configure playback pipe");
}
} // namespace
int main(int argc, char **argv) {
    if (argc != 2 || std::string(argv[1]) != "--stdio-v1") return 2;
    const auto host = getppid();
    if (host == 1 || prctl(PR_SET_PDEATHSIG, SIGTERM) != 0 || getppid() != host) return 2;
    signal(SIGPIPE, SIG_IGN);
    Output output;
    try {
        nonblocking(STDIN_FILENO); nonblocking(STDOUT_FILENO); validateTransport(transportFd);
        wakeFd = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
        if (wakeFd < 0) throw std::runtime_error("Cannot create playback wakeup event");
        std::string input; uint64_t lastState = 0; bool running = true;
        while (running) {
            pollfd channels[] = {{STDIN_FILENO, POLLIN, 0}, {transportFd, static_cast<short>(POLLIN | (preparedSlot >= 0 ? POLLOUT : 0)), 0},
                {wakeFd, POLLIN, 0}, {STDOUT_FILENO, static_cast<short>(output.pending() ? POLLOUT : 0), 0}};
            const int ready = poll(channels, 4, 16);
            if (ready < 0 && errno != EINTR) throw std::runtime_error("Playback input failed");
            if (channels[0].revents & (POLLIN | POLLHUP)) {
                char buffer[16384];
                // Bounded reads allow mpv and the ACK channel to make progress
                // even while receiving a large generated subtitle document.
                for (size_t reads = 0; reads < 64; reads++) {
                    const auto count = read(STDIN_FILENO, buffer, sizeof(buffer));
                    if (!count) { running = false; break; }
                    if (count < 0) { if (errno == EINTR) { reads--; continue; } if (errno == EAGAIN || errno == EWOULDBLOCK) break; throw std::runtime_error("Playback input disconnected"); }
                    input.append(buffer, static_cast<size_t>(count));
                    while (input.size() >= 4) {
                        const auto length = read32(input, 0);
                        if (length < 4 || length > maxMessage) throw std::runtime_error("Invalid playback message length");
                        if (input.size() < length + 4) break;
                        running = dispatch(decode(input.substr(4, length))); input.erase(0, length + 4);
                        if (!running) break;
                    }
                    if (input.size() > maxMessage + 4) throw std::runtime_error("Playback input overflow");
                    if (!running) break;
                }
            }
            if (!running) break;
            if (channels[0].revents & (POLLERR | POLLNVAL)) throw std::runtime_error("Playback input disconnected");
            if (channels[1].revents & (POLLERR | POLLNVAL | POLLHUP)) throw std::runtime_error("DMA-BUF consumer disconnected");
            if (channels[1].revents & POLLIN) drainAcknowledgements(transportFd, leases);
            if (channels[2].revents & POLLIN) { uint64_t value; while (read(wakeFd, &value, sizeof(value)) == sizeof(value)) {} }
            playback.drainEvents(); render(); output.flush();
            if (now() - lastState >= 50) { output.emit(state()); lastState = now(); }
        }
        destroyPlayer(); close(wakeFd); wakeFd = -1; close(transportFd); return 0;
    } catch (const std::exception &error) {
        // Only our fixed diagnostics and libmpv error names reach this channel;
        // media command arguments, URLs and native device paths are never echoed.
        try { output.emit("{\"alive\":false,\"error\":" + javdex::jsonString(error.what()) + ",\"errorKind\":\"native\"}"); } catch (...) {}
        try { destroyPlayer(); } catch (...) {}
        if (wakeFd >= 0) close(wakeFd);
        wakeFd = -1; close(transportFd); return 1;
    }
}
