import { useEffect, useRef, useState } from "react";
import type { WebAccessStatus } from "@shared/webTypes";
import { api } from "../../api";
import { useSettingsDraft } from "../../settings/useSettingsDraft";
import { useSettingsFormGuard } from "../../settings/SettingsLeaveGuard";
import SettingsSwitchRow from "../SettingsSwitchRow";
import Button from "../Button";
import { SettingsCard } from "./SettingsPrimitives";
import SettingsFormActions from "./SettingsFormActions";
import { WEB_ACCESS_LABEL } from "../../settings/settingsRoutes";
import styles from "./WebAccessPanel.module.css";
import WebDevices, { AddressCode } from "./WebDevices";
import SelectControl from "../SelectControl";
import Modal from "../Modal";

export default function WebAccessPanel(): JSX.Element {
  const [status, setStatus] = useState<WebAccessStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = (): void => {
    void api.webAccess
      .status()
      .then(setStatus)
      .catch((e) => setError(e.message));
  };
  useEffect(load, []);
  if (!status)
    return (
      <div role="status">
        {error ?? `正在读取${WEB_ACCESS_LABEL}状态…`}
        {error && <Button onClick={load}>重试</Button>}
      </div>
    );
  return <WebAccessForm status={status} onChange={setStatus} />;
}
function WebAccessForm({
  status,
  onChange,
}: {
  status: WebAccessStatus;
  onChange: (status: WebAccessStatus) => void;
}): JSX.Element {
  const form = useSettingsDraft({
    enabled: status.enabled,
    port: String(status.port),
    username: status.username,
    password: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedUrl, setSelectedUrl] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [addressFeedback, setAddressFeedback] = useState("");
  const configuration = useRef<HTMLDivElement>(null);
  const url = status.urls.includes(selectedUrl)
    ? selectedUrl
    : status.urls.find((value) => !value.includes("127.0.0.1")) ||
      status.urls[0] ||
      "";
  useEffect(() => {
    if (addressFeedback !== "地址已复制") return;
    const timer = setTimeout(() => setAddressFeedback(""), 3000);
    return () => clearTimeout(timer);
  }, [addressFeedback]);
  const lock = useRef(false);
  const save = async (): Promise<boolean> => {
    if (lock.current) return false;
    const submitted = form.draft;
    const port = Number(submitted.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      setError("端口需为 1024–65535 的整数");
      return false;
    }
    if (!/^[\w.-]{1,64}$/.test(submitted.username)) {
      setError("账号使用 1–64 位字母、数字、点、横线或下划线");
      return false;
    }
    if (
      (submitted.enabled && !status.hasPassword && !submitted.password) ||
      (submitted.password &&
        (submitted.password.length < 12 || submitted.password.length > 128))
    ) {
      setError("请设置 12–128 个字符的访问密码");
      return false;
    }
    lock.current = true;
    setSaving(true);
    setError(null);
    try {
      const next = await api.webAccess.apply({
        ...submitted,
        port,
        password: submitted.password || undefined,
      });
      onChange(next);
      form.accept(
        {
          enabled: next.enabled,
          port: String(next.port),
          username: next.username,
          password: "",
        },
        submitted,
      );
      if (!next.error) setChangingPassword(false);
      return !next.error;
    } catch (reason) {
      setError((reason as Error).message);
      return false;
    } finally {
      lock.current = false;
      setSaving(false);
    }
  };
  useSettingsFormGuard({
    label: WEB_ACCESS_LABEL,
    dirty: form.dirty,
    busy: saving,
    save,
    discard: form.reset,
  });
  const config = (
    <div ref={configuration}>
      <SettingsCard
        title="服务配置"
        hint="保存后生效；完全退出 Javdex 后服务停止。"
        actions={
          <SettingsFormActions
            placement="header"
            dirty={form.dirty}
            saving={saving}
            conflict={form.conflict}
            onSave={() => void save()}
            onCancel={() => {
              form.reset();
              setError(null);
              setChangingPassword(false);
            }}
          />
        }
      >
        <div className={styles.form}>
          <div className="settings-toggle-list">
            <SettingsSwitchRow
              title={`开启${WEB_ACCESS_LABEL}`}
              description="手机、平板、电视和电脑连上同一网络后，可用浏览器打开媒体库。"
              checked={form.draft.enabled}
              disabled={saving}
              onChange={(enabled) => form.setDraft((d) => ({ ...d, enabled }))}
            />
          </div>
          <div className={styles.fields}>
            <label className={styles.field}>
              端口
              <input
                className={`text-input ${styles.input}`}
                aria-label="端口"
                inputMode="numeric"
                aria-invalid={Boolean(error?.startsWith("端口"))}
                value={form.draft.port}
                disabled={saving}
                onChange={(e) =>
                  form.setDraft((d) => ({ ...d, port: e.target.value }))
                }
              />
              <small className={styles.fieldHint}>
                {error?.startsWith("端口") ? error : "1024–65535"}
              </small>
            </label>
            <label className={styles.field}>
              访问账号
              <input
                className={`text-input ${styles.input}`}
                autoComplete="off"
                aria-invalid={Boolean(error?.startsWith("账号"))}
                value={form.draft.username}
                disabled={saving}
                onChange={(e) =>
                  form.setDraft((d) => ({ ...d, username: e.target.value }))
                }
              />
            </label>
            <div className={styles.field}>
              {status.hasPassword && !changingPassword ? (
                <>
                  <span>访问密码</span>
                  <div className={styles.address}>
                    <span className={styles.hint}>密码已设置</span>
                    <Button
                      size="sm"
                      disabled={saving}
                      onClick={() => setChangingPassword(true)}
                    >
                      更换密码
                    </Button>
                  </div>
                </>
              ) : (
                <label className={styles.field}>
                  {status.hasPassword ? "新密码（留空保留）" : "访问密码"}
                  <input
                    className={`text-input ${styles.input}`}
                    aria-label={status.hasPassword ? "新密码（留空保留）" : "访问密码"}
                  type="password"
                    autoComplete="new-password"
                    maxLength={128}
                    aria-invalid={Boolean(error?.startsWith("请设置"))}
                    value={form.draft.password}
                    disabled={saving}
                    onChange={(e) =>
                      form.setDraft((d) => ({ ...d, password: e.target.value }))
                    }
                  />
                  <small className={styles.fieldHint}>
                    使用独立的 12–128 个字符密码
                  </small>
                </label>
              )}
            </div>
          </div>
          {error && (
            <p className={styles.statusCopy} role="alert">
              {error}
            </p>
          )}
          <p className={styles.hint}>
            仅在自己的网络使用，请勿把端口映射到公网。
          </p>
        </div>
      </SettingsCard>
    </div>
  );
  return (
    <>
      {config}
      <SettingsCard
        title="访问入口"
        hint="在其他设备浏览和播放；媒体库管理仍在桌面端完成。"
        actions={
          <div className={styles.actions}>
            <span
              className={styles.state}
              data-running={status.running}
              role="status"
            >
              {status.running ? "可打开" : status.error ? "启动失败" : "未开启"}
            </span>
            <Button
              size="sm"
              disabled={saving}
              onClick={() =>
                void api.webAccess
                  .status()
                  .then(onChange)
                  .catch((e) => setAddressFeedback(e.message))
              }
            >
              刷新
            </Button>
            {status.enabled && !status.running && <Button size="sm" disabled={saving || form.dirty}
              title={form.dirty ? '请先保存或取消配置更改' : undefined} onClick={() => void save()}>重试启动</Button>}
          </div>
        }
      >
        <div className={styles.accessBody}>
          <div className={styles.stableRow}>
            <div className={styles.addressSelect}><SelectControl aria-label="访问地址" value={url} disabled={!status.running || !url} onChange={e => { setSelectedUrl(e.target.value); setAddressFeedback("") }}>
              {!url && <option value="">服务未运行</option>}
              {status.urls.map(value => <option key={value} value={value}>{value}{value.includes('127.0.0.1') ? ' · 仅本机' : ''}</option>)}
            </SelectControl></div>
            <div className={styles.actions}>
              <Button size="sm" disabled={!status.running || !url} onClick={() => void navigator.clipboard.writeText(url).then(() => setAddressFeedback('地址已复制')).catch(() => setAddressFeedback(`复制失败，请手动复制：${url}`))}>复制</Button>
              <Button size="sm" disabled={!status.running || !url} onClick={() => void api.externalLinks.open(url).catch(e => setAddressFeedback(e.message))}>打开</Button>
              <Button size="sm" disabled={!status.running || !url} onClick={() => setQrOpen(true)}>二维码</Button>
            </div>
          </div>
          <div className={styles.accessFeedback}>
            <Button size="sm" variant="ghost" aria-expanded={helpOpen} onClick={() => setHelpOpen(!helpOpen)}>{helpOpen ? '收起说明' : '无法连接？'}</Button>
            <div className={styles.inlineFeedback} role="status">{addressFeedback || (helpOpen ? '其他设备需连接同一网络（例如同一个 Wi-Fi），不要使用仅本机地址。可切换其他地址尝试，并检查防火墙是否允许此端口。' : status.error || (!status.running ? '请在上方开启并保存。' : '连上同一网络后，用浏览器打开此地址。'))}</div>
            {addressFeedback && <Button size="sm" variant="ghost" onClick={() => setAddressFeedback("")}>关闭提示</Button>}
          </div>
        </div>
      </SettingsCard>
      <WebDevices status={status} onChange={onChange} />
      {qrOpen && status.running && url && (
        <Modal
          title="扫码访问"
          size="sm"
          hideActions
          onCancel={() => setQrOpen(false)}
        >
          <div className={styles.qr}>
            <AddressCode url={url} />
            <p className={styles.hint}>
              连上同一网络后扫码；二维码只打开网页，仍需登录或配对。
            </p>
          </div>
        </Modal>
      )}
    </>
  );
}
