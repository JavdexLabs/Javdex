import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useHorizontalDragScroll } from "../hooks/useHorizontalDragScroll";
import {
  Building2,
  Clapperboard,
  Film,
  Image as ImageIcon,
  Layers3,
  Link,
  Trash2,
  Upload,
} from "lucide-react";
import type {
  ClassificationEntityRef,
  ClassificationImageInput,
  ClassificationImageUpdateResult,
} from "@shared/classificationTypes";
import { api, assetUrl } from "../api";
import { classificationImageKeys } from "../query/queryKeys";
import EmptyState from "./EmptyState";
import Modal from "./Modal";
import { useTheme } from "./ThemeProvider";
import { useToast } from "./Toast";
import { UI_ICON_SM } from "./iconDefaults";
import {
  classificationImageDisplayState,
  fileClassificationImageInput,
  remoteClassificationImageInput,
  videoCoverClassificationImageInput,
} from "./classificationImageState";
import Button from "./Button";
import styles from "./ClassificationImageModal.module.css";

type SourceMode = "file" | "url" | "video";

interface Props {
  entity: ClassificationEntityRef;
  entityLabel: string;
  imagePath: string | null;
  fallbackCoverPath: string | null;
  onCancel: () => void;
  onChanged: (result: ClassificationImageUpdateResult) => void | Promise<void>;
}

function remotePreviewUrl(mimeType: string, dataBase64: string): string {
  return `data:${mimeType};base64,${dataBase64}`;
}

export default function ClassificationImageModal({
  entity,
  entityLabel,
  imagePath,
  fallbackCoverPath,
  onCancel,
  onChanged,
}: Props): JSX.Element {
  const toast = useToast();
  const { privacyMode } = useTheme();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const objectUrlRef = useRef<string | null>(null);
  const remoteRequestRef = useRef(0);
  const current = classificationImageDisplayState(imagePath, fallbackCoverPath);
  const [mode, setMode] = useState<SourceMode>("file");
  const [pending, setPending] = useState<
    ClassificationImageInput | null | undefined
  >(undefined);
  const [previewUrl, setPreviewUrl] = useState<string | null>(
    assetUrl(current.path),
  );
  const [previewLabel, setPreviewLabel] = useState<string>(current.label);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [loadingRemote, setLoadingRemote] = useState(false);
  const [saving, setSaving] = useState(false);
  const mediaEditorsHidden =
    privacyMode.privacyModeEnabled &&
    privacyMode.privacyModeScopes.includes("mediaEditors");
  const coverScroll = useHorizontalDragScroll();
  const candidatesQuery = useQuery({
    queryKey: classificationImageKeys.candidates(entity),
    queryFn: () => api.classificationImages.candidates(entity),
    enabled: !mediaEditorsHidden,
  });
  const coverCandidates = candidatesQuery.data ?? [];
  const placeholder =
    entity.kind === "organization" ? (
      <Building2 {...UI_ICON_SM} aria-hidden />
    ) : entity.kind === "director" ? (
      <Clapperboard {...UI_ICON_SM} aria-hidden />
    ) : (
      <Layers3 {...UI_ICON_SM} aria-hidden />
    );

  const clearObjectUrl = (): void => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
  };

  useEffect(
    () => () => {
      remoteRequestRef.current += 1;
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    },
    [],
  );

  const resetPending = (): void => {
    remoteRequestRef.current += 1;
    setLoadingRemote(false);
    clearObjectUrl();
    setPending(undefined);
    setPreviewUrl(assetUrl(current.path));
    setPreviewLabel(current.label);
  };

  const selectMode = (nextMode: SourceMode): void => {
    setMode(nextMode);
    resetPending();
  };

  const previewRemote = async (): Promise<void> => {
    const input = remoteClassificationImageInput(remoteUrl);
    if (!input || input.source !== "url") return;
    let parsed: URL;
    try {
      parsed = new URL(input.remoteUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        throw new Error();
    } catch {
      toast.show("请输入有效的 HTTP/HTTPS 图片链接", "error");
      return;
    }
    const requestId = ++remoteRequestRef.current;
    setLoadingRemote(true);
    try {
      const preview = await api.assets.fetchRemoteImagePreview(
        parsed.toString(),
      );
      if (requestId !== remoteRequestRef.current) return;
      clearObjectUrl();
      setPending({ source: "url", remoteUrl: parsed.toString() });
      setPreviewUrl(remotePreviewUrl(preview.mimeType, preview.dataBase64));
      setPreviewLabel("待保存主图");
    } catch (error) {
      if (requestId !== remoteRequestRef.current) return;
      toast.show(String((error as Error).message), "error");
    } finally {
      if (requestId === remoteRequestRef.current) setLoadingRemote(false);
    }
  };

  const save = async (): Promise<void> => {
    if (pending === undefined || saving || mediaEditorsHidden) return;
    setSaving(true);
    try {
      const result = await api.classificationImages.set(entity, pending);
      await onChanged(result);
      if (result.cleanupFailures.length > 0) {
        toast.show("主图已更新，但旧图片清理失败，可稍后重试", "info");
      } else {
        toast.show(pending ? "正式主图已更新" : "正式主图已移除", "success");
      }
      onCancel();
    } catch (error) {
      toast.show(String((error as Error).message), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`管理${entityLabel}主图`}

      size="lg"
      bodyOverflow="hidden"
      confirmText={saving ? "保存中…" : "保存主图"}
      confirmDisabled={
        pending === undefined || saving || loadingRemote || mediaEditorsHidden
      }
      busy={saving}
      onCancel={onCancel}
      onConfirm={() => void save()}
    >
      {mediaEditorsHidden ? (
        <EmptyState
          variant="compact"
          icon={<ImageIcon {...UI_ICON_SM} aria-hidden />}
          title="隐私模式已隐藏媒体编辑"
          description="关闭“媒体编辑”保护范围后可管理分类主图。"
        />
      ) : (
        <div className={styles.editor}>
          <div className={styles.current}>
            <div
              className={`${styles.preview} classification-image-preview${
                entity.kind === "organization"
                  ? ` ${styles.previewOrganization}`
                  : ""
              }`}
            >
              {previewUrl ? <img src={previewUrl} alt="" /> : placeholder}
            </div>
            <div>
              <strong>{previewLabel}</strong>
              <p>正式主图由 Javdex 管理；移除后会自动使用关联影片封面。</p>
            </div>
            {imagePath ? (
              <Button
                type="button"
                variant="ghost"

                size="sm"
                onClick={() => {
                  remoteRequestRef.current += 1;
                  setLoadingRemote(false);
                  clearObjectUrl();
                  setPending(null);
                  setPreviewUrl(assetUrl(fallbackCoverPath));
                  setPreviewLabel(fallbackCoverPath ? "动态回退" : "暂无图片");
                }}
              >
                <Trash2 {...UI_ICON_SM} aria-hidden />
                移除正式主图
              </Button>
            ) : null}
          </div>

          <div className={styles.source}>
            <div
              className={styles.sourceTabs}
              role="tablist"
              aria-label="主图来源"
            >
              <button
                type="button"
                role="tab"
                aria-selected={mode === "file"}
                onClick={() => selectMode("file")}
              >
                <Upload {...UI_ICON_SM} aria-hidden />
                本地图片
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "url"}
                onClick={() => selectMode("url")}
              >
                <Link {...UI_ICON_SM} aria-hidden />
                图片链接
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "video"}
                onClick={() => selectMode("video")}
              >
                <Film {...UI_ICON_SM} aria-hidden />
                影片封面
              </button>
            </div>

            <div className={styles.sourceBody}>
              <div
                className={styles.sourcePage}
                data-active={mode === "file"}
                role="tabpanel"
                hidden={mode !== "file"}
              >
                <div className={styles.sourceStatic}>
                  <p>选择一张本地图片。保存后会复制到 Javdex 媒体资源目录。</p>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload {...UI_ICON_SM} aria-hidden />
                    选择图片
                  </Button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif,image/avif,.jpg,.jpeg,.png,.webp,.gif,.avif"
                    hidden
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      const input = fileClassificationImageInput(
                        api.assets.getPathForFile(file),
                      );
                      if (!input) return;
                      clearObjectUrl();
                      objectUrlRef.current = URL.createObjectURL(file);
                      setPending(input);
                      setPreviewUrl(objectUrlRef.current);
                      setPreviewLabel("待保存主图");
                      event.target.value = "";
                    }}
                  />
                </div>
              </div>

              <div
                className={styles.sourcePage}
                data-active={mode === "url"}
                role="tabpanel"
                hidden={mode !== "url"}
              >
                <div className={styles.urlSource}>
                  <input
                    className="text-input"
                    type="url"
                    placeholder="https://example.com/image.jpg"
                    value={remoteUrl}
                    onChange={(event) => {
                      setRemoteUrl(event.target.value);
                      resetPending();
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={loadingRemote}
                    onClick={() => void previewRemote()}
                  >
                    {loadingRemote ? "加载中…" : "加载并预览"}
                  </Button>
                </div>
              </div>

              <div
                ref={coverScroll.ref}
                className={`${styles.sourcePage}${
                  coverCandidates.length > 0
                    ? ` ${styles.sourcePageScroll}`
                    : ""
                }`}
                data-active={mode === "video"}
                data-dragging={coverScroll.isDragging}
                role="tabpanel"
                hidden={mode !== "video"}
                onPointerDownCapture={coverScroll.onPointerDownCapture}
                onPointerMove={coverScroll.onPointerMove}
                onPointerUp={coverScroll.onPointerUp}
                onPointerCancel={coverScroll.onPointerCancel}
              >
                {candidatesQuery.isLoading ? (
                  <p className={styles.sourceEmpty}>加载关联封面…</p>
                ) : candidatesQuery.isError ? (
                  <p className={styles.sourceEmpty}>关联封面加载失败</p>
                ) : coverCandidates.length === 0 ? (
                  <p className={styles.sourceEmpty}>暂无关联影片封面</p>
                ) : (
                  coverCandidates.map((candidate) => {
                    const selected =
                      pending?.source === "video-cover" &&
                      pending.videoId === candidate.videoId;
                    return (
                      <button
                        key={candidate.videoId}
                        type="button"
                        className={styles.candidate}
                        title={candidate.code}
                        aria-label={candidate.code}
                        aria-pressed={selected}
                        onClick={() => {
                          if (coverScroll.shouldSuppressClick()) return;
                          clearObjectUrl();
                          setPending(
                            videoCoverClassificationImageInput(
                              candidate.videoId,
                            ),
                          );
                          setPreviewUrl(assetUrl(candidate.coverPath));
                          setPreviewLabel("待保存主图");
                        }}
                      >
                        <span
                          className={`${styles.candidateCover} classification-image-candidate-cover`}
                        >
                          <img
                            src={assetUrl(candidate.coverPath) ?? ""}
                            alt=""
                            loading="lazy"
                            draggable={false}
                          />
                        </span>
                        <span className={styles.candidateCode}>
                          {candidate.code}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
