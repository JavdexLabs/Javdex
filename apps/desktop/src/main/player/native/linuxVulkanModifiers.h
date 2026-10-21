#pragma once

// Query the consumer's supported layouts on the exact DRM render node. The
// Vulkan loader is supplied by Electron, not installed or selected globally.
#define VK_NO_PROTOTYPES
#include <vulkan/vulkan.h>
#include <dlfcn.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <algorithm>
#include <stdexcept>
#include <string>
#include <vector>

namespace javdex {
inline std::vector<uint64_t> vulkanDmaBufModifiers(const char *loaderPath, int renderFd) {
    struct Query {
        void *library = nullptr;
        VkInstance instance = VK_NULL_HANDLE;
        PFN_vkGetInstanceProcAddr get = nullptr;
        ~Query() {
            if (instance) reinterpret_cast<PFN_vkDestroyInstance>(get(instance, "vkDestroyInstance"))(instance, nullptr);
            if (library) dlclose(library);
        }
    } query;
    if (!loaderPath || loaderPath[0] != '/') throw std::runtime_error("Missing private Vulkan loader path");
    query.library = dlopen(loaderPath, RTLD_NOW | RTLD_LOCAL);
    if (!query.library) throw std::runtime_error("Cannot load Vulkan capability query");
    query.get = reinterpret_cast<PFN_vkGetInstanceProcAddr>(dlsym(query.library, "vkGetInstanceProcAddr"));
    if (!query.get) throw std::runtime_error("Vulkan loader entry point unavailable");
    auto create = reinterpret_cast<PFN_vkCreateInstance>(query.get(VK_NULL_HANDLE, "vkCreateInstance"));
    VkApplicationInfo application{};
    application.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO;
    application.pApplicationName = "Javdex DMA-BUF capability query";
    application.apiVersion = VK_API_VERSION_1_1;
    VkInstanceCreateInfo createInfo{};
    createInfo.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO;
    createInfo.pApplicationInfo = &application;
    if (!create || create(&createInfo, nullptr, &query.instance) != VK_SUCCESS)
        throw std::runtime_error("Cannot query Vulkan DMA-BUF capabilities");
    auto enumerate = reinterpret_cast<PFN_vkEnumeratePhysicalDevices>(query.get(query.instance, "vkEnumeratePhysicalDevices"));
    auto extensions = reinterpret_cast<PFN_vkEnumerateDeviceExtensionProperties>(query.get(query.instance, "vkEnumerateDeviceExtensionProperties"));
    auto properties = reinterpret_cast<PFN_vkGetPhysicalDeviceProperties2>(query.get(query.instance, "vkGetPhysicalDeviceProperties2"));
    auto formats = reinterpret_cast<PFN_vkGetPhysicalDeviceFormatProperties2>(query.get(query.instance, "vkGetPhysicalDeviceFormatProperties2"));
    auto imageFormats = reinterpret_cast<PFN_vkGetPhysicalDeviceImageFormatProperties2>(query.get(query.instance, "vkGetPhysicalDeviceImageFormatProperties2"));
    if (!enumerate || !extensions || !properties || !formats || !imageFormats)
        throw std::runtime_error("Vulkan capability entry points unavailable");
    uint32_t count = 0;
    if (enumerate(query.instance, &count, nullptr) != VK_SUCCESS || !count || count > 32)
        throw std::runtime_error("Invalid Vulkan device list");
    std::vector<VkPhysicalDevice> devices(count);
    if (enumerate(query.instance, &count, devices.data()) != VK_SUCCESS || count > devices.size())
        throw std::runtime_error("Vulkan device list changed");
    struct stat node{};
    if (fstat(renderFd, &node) != 0 || !S_ISCHR(node.st_mode)) throw std::runtime_error("Invalid render node");
    VkPhysicalDevice selected = VK_NULL_HANDLE;
    for (uint32_t i = 0; i < count; i++) {
        uint32_t extensionCount = 0;
        if (extensions(devices[i], nullptr, &extensionCount, nullptr) != VK_SUCCESS || extensionCount > 1024) continue;
        std::vector<VkExtensionProperties> available(extensionCount);
        if (extensions(devices[i], nullptr, &extensionCount, available.data()) != VK_SUCCESS) continue;
        const auto has = [&](const char *name) { return std::any_of(available.begin(), available.end(),
            [&](const auto &entry) { return std::string(entry.extensionName) == name; }); };
        if (!has(VK_EXT_PHYSICAL_DEVICE_DRM_EXTENSION_NAME) || !has(VK_EXT_EXTERNAL_MEMORY_DMA_BUF_EXTENSION_NAME)
            || !has(VK_EXT_IMAGE_DRM_FORMAT_MODIFIER_EXTENSION_NAME)) continue;
        VkPhysicalDeviceDrmPropertiesEXT drm{};
        drm.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DRM_PROPERTIES_EXT;
        VkPhysicalDeviceProperties2 info{};
        info.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2;
        info.pNext = &drm;
        properties(devices[i], &info);
        if (!drm.hasRender || drm.renderMajor != major(node.st_rdev) || drm.renderMinor != minor(node.st_rdev)) continue;
        if (selected) throw std::runtime_error("Ambiguous Vulkan render node");
        selected = devices[i];
    }
    if (!selected) throw std::runtime_error("No Vulkan DMA-BUF device matches the render node");
    VkDrmFormatModifierPropertiesListEXT list{};
    list.sType = VK_STRUCTURE_TYPE_DRM_FORMAT_MODIFIER_PROPERTIES_LIST_EXT;
    VkFormatProperties2 format{};
    format.sType = VK_STRUCTURE_TYPE_FORMAT_PROPERTIES_2;
    format.pNext = &list;
    formats(selected, VK_FORMAT_B8G8R8A8_UNORM, &format);
    if (!list.drmFormatModifierCount || list.drmFormatModifierCount > 256)
        throw std::runtime_error("No bounded Vulkan BGRA modifier list");
    std::vector<VkDrmFormatModifierPropertiesEXT> candidates(list.drmFormatModifierCount);
    list.pDrmFormatModifierProperties = candidates.data();
    formats(selected, VK_FORMAT_B8G8R8A8_UNORM, &format);
    if (list.drmFormatModifierCount > candidates.size()) throw std::runtime_error("Vulkan modifier list changed");
    std::vector<uint64_t> result;
    constexpr VkFormatFeatureFlags required = VK_FORMAT_FEATURE_SAMPLED_IMAGE_BIT | VK_FORMAT_FEATURE_SAMPLED_IMAGE_FILTER_LINEAR_BIT;
    for (uint32_t i = 0; i < list.drmFormatModifierCount; i++) {
        const auto &candidate = candidates[i];
        if (candidate.drmFormatModifierPlaneCount != 1 || (candidate.drmFormatModifierTilingFeatures & required) != required) continue;
        VkPhysicalDeviceImageDrmFormatModifierInfoEXT modifier{};
        modifier.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_IMAGE_DRM_FORMAT_MODIFIER_INFO_EXT;
        modifier.drmFormatModifier = candidate.drmFormatModifier;
        modifier.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
        VkPhysicalDeviceExternalImageFormatInfo external{};
        external.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_EXTERNAL_IMAGE_FORMAT_INFO;
        external.pNext = &modifier;
        external.handleType = VK_EXTERNAL_MEMORY_HANDLE_TYPE_DMA_BUF_BIT_EXT;
        VkPhysicalDeviceImageFormatInfo2 request{};
        request.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_IMAGE_FORMAT_INFO_2;
        request.pNext = &external;
        request.format = VK_FORMAT_B8G8R8A8_UNORM;
        request.type = VK_IMAGE_TYPE_2D;
        request.tiling = VK_IMAGE_TILING_DRM_FORMAT_MODIFIER_EXT;
        request.usage = VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT;
        VkExternalImageFormatProperties import{};
        import.sType = VK_STRUCTURE_TYPE_EXTERNAL_IMAGE_FORMAT_PROPERTIES;
        VkImageFormatProperties2 response{};
        response.sType = VK_STRUCTURE_TYPE_IMAGE_FORMAT_PROPERTIES_2;
        response.pNext = &import;
        if (imageFormats(selected, &request, &response) != VK_SUCCESS
            || !(import.externalMemoryProperties.externalMemoryFeatures & VK_EXTERNAL_MEMORY_FEATURE_IMPORTABLE_BIT)) continue;
        if (std::find(result.begin(), result.end(), candidate.drmFormatModifier) == result.end()) result.push_back(candidate.drmFormatModifier);
    }
    if (result.empty()) throw std::runtime_error("No importable single-plane Vulkan BGRA layout");
    return result;
}
} // namespace javdex
