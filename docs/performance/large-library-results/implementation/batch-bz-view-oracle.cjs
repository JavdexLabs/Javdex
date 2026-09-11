"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fileDetail = fileDetail;
exports.fileView = fileView;
exports.isAttentionFile = isAttentionFile;
exports.hasNfoPendingTarget = hasNfoPendingTarget;
exports.resourceView = resourceView;
function fileDetail(entry) {
    const primary = (() => {
        switch (entry.outcome) {
            case 'added':
                return entry.createdVideo ? '新建影片并添加资源' : '挂载到已有影片';
            case 'updated':
                return {
                    relocated: '路径已重定位',
                    metadata_refreshed: '文件信息已刷新',
                    strm_target_synced: 'STRM 目标已同步'
                }[entry.updateKind];
            case 'pending':
                return `${entry.normalizedCode || '番号未知'} · ${entry.sourceKind === 'strm' ? 'STRM' : '本地文件'} · ${entry.addedToQueue ? '已加入待确认队列' : '仍在待确认队列'}`;
            case 'skipped':
                return {
                    unchanged: '未变化',
                    below_min_duration: '低于最短时长',
                    duplicate: '重复资源'
                }[entry.skipReason];
            case 'unrecognized':
                return '文件名未识别出番号';
            case 'strm_failure':
                return entry.message;
            case 'processing_failure':
                return entry.message;
        }
    })();
    if (!entry.nfo)
        return primary;
    const nfoLabel = {
        imported: 'NFO 已导入',
        skipped: 'NFO 已跳过',
        warning: 'NFO 警告',
        'pending-candidate': 'NFO 候选待确认',
        'identity-conflict': 'NFO 身份冲突'
    }[entry.nfo.disposition];
    const warnings = entry.nfo.warnings?.map((warning) => warning.message).join('；');
    return `${primary} · ${nfoLabel}${warnings ? ` · ${warnings}` : ''}`;
}
function fileView(entry, index) {
    return {
        key: `file:${index}:${entry.filePath}`,
        title: entry.filePath.split(/[\\/]/).pop() || entry.filePath,
        detail: fileDetail(entry),
        outcome: entry.outcome,
        path: entry.filePath,
        rootId: entry.rootId,
        videoId: 'videoId' in entry ? entry.videoId : undefined,
        groupId: entry.outcome === 'pending' ? entry.groupId ?? undefined : undefined
    };
}
function isAttentionFile(entry) {
    return (['unrecognized', 'strm_failure', 'processing_failure'].includes(entry.outcome) ||
        entry.nfo?.disposition === 'warning' ||
        entry.nfo?.disposition === 'identity-conflict' ||
        entry.nfo?.disposition === 'pending-candidate');
}
function hasNfoPendingTarget(entry) {
    if (entry.nfo?.disposition === 'identity-conflict') {
        return (entry.nfo.pendingIdentityId != null);
    }
    if (entry.nfo?.disposition === 'pending-candidate') {
        return (entry.nfo.pendingScrapeId != null);
    }
    return false;
}
function resourceView(entry, index) {
    const reason = {
        missing: '源文件缺失',
        removed_library_path: '媒体库路径已移除',
        promoted_after_removal: '原主资源移除后提升'
    }[entry.reason];
    return {
        key: `resource:${index}:${entry.resourceId}`,
        title: `${entry.videoCode}${entry.videoTitle ? ` · ${entry.videoTitle}` : ''}`,
        detail: `${entry.resourceKind.toUpperCase()} · ${reason} · ${entry.displayName || entry.sourcePath || '外部目标已隐藏'}`,
        path: entry.sourcePath ?? undefined,
        videoId: entry.videoId
    };
}
