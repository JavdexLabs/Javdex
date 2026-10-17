import TextInput from '../TextInput'
import { useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, Globe, KeyRound, QrCode, RefreshCw, Server, ShieldCheck } from "lucide-react";
import type { WebAccessStatus } from "@shared/webTypes";
import { api } from "../../api";
import { useSettingsDraft } from "../../settings/useSettingsDraft";
import { useSettingsFormGuard } from "../../settings/SettingsLeaveGuard";
import SettingsSwitchRow from "../SettingsSwitchRow";
import SettingsToggleList from "../SettingsToggleList";
import Button from "../Button";
import IconButton from "../IconButton";
import { UI_ICON_SM } from "../iconDefaults";
import { SettingsCard, SettingsStatusPill } from "./SettingsPrimitives";
import SettingsFormActions from "./SettingsFormActions";
import { WEB_ACCESS_LABEL } from "../../settings/settingsRoutes";
import styles from "./WebAccessPanel.module.css";
import WebDevices, { AddressCode } from "./WebDevices";
import SelectControl from "../SelectControl";
import Modal from "../Modal";
import { useDesktopSession } from "../../desktop/DesktopSessionContext";

export default function WebAccessPanel(): JSX.Element {
  const { session, capabilities } = useDesktopSession();
  if (!capabilities.manageBrowserPairing.allowed) {
    return <div role="status">{session.state === "frozen"
      ? "资料库已冻结，暂时无法管理网页访问与配对。"
      : session.message || "请先连接服务端并取得写入权限，再管理网页访问与配对。"}</div>;
  }
  return <ConnectedWebAccessPanel key={`${session.catalogId}:${session.generation}`} />;
}

function ConnectedWebAccessPanel(): JSX.Element {
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
  const { session } = useDesktopSession();
  const remoteCatalog = session.mode === "remote";
  const form = useSettingsDraft({
    enabled: status.enabled,
    port: String(status.port),
    username: status.username,
    password: "",
  });
  const [saving, setSaving] = useState(false);
  const [devicesBusy, setDevicesBusy] = useState(false);
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
  const operationRevision = useRef(0);
  const save = async (): Promise<boolean> => {
    if (lock.current) return false;
    const submitted = form.draft;
    const port = Number(submitted.port);
    if (!remoteCatalog) {
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
    }
    lock.current = true;
    operationRevision.current++;
    setSaving(true);
    setError(null);
    try {
      const next = await api.webAccess.apply(
        remoteCatalog
          ? {
              enabled: submitted.enabled,
              port: status.port || 8096,
              username: status.username || "viewer",
            }
          : {
              ...submitted,
              port,
              password: submitted.password || undefined,
            },
      );
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
    busy: saving || devicesBusy,
    save,
    discard: form.reset,
  });
  const config = (
    <div ref={configuration}>
      <SettingsCard
        as="section"
        aria-label="服务配置"
        headerClassName={styles.cardHeader}
        title={<span className={styles.sectionTitle}><Server {...UI_ICON_SM} />服务配置</span>}
        hint={
          remoteCatalog
            ? "关闭浏览入口不会关闭管理接口。端口和访问账号由服务端部署配置决定。"
            : "保存后生效；完全退出 Javdex 后服务停止。"
        }
        actions={
          <SettingsFormActions
            placement="header"
            dirty={form.dirty}
            saving={saving}
            disabled={devicesBusy}
            conflict={form.conflict}
            error={error}
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
          <SettingsToggleList>
            <SettingsSwitchRow
              title={`开启${WEB_ACCESS_LABEL}`}
              description={
                remoteCatalog
                  ? "关闭后网页无法登录或配对，管理接口保持可用。"
                  : "手机、平板、电视和电脑连上同一网络后，可用浏览器打开媒体库。"
              }
              checked={form.draft.enabled}
              disabled={saving}
              onChange={(enabled) => form.setDraft((d) => ({ ...d, enabled }))}
            />
          </SettingsToggleList>
          {remoteCatalog ? null : (
          <div className={styles.fields}>
            <label className={styles.field}>
              端口
              <TextInput
                density="workspace" className={styles.input}
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
              <TextInput
                density="workspace" className={styles.input}
                autoComplete="off"
                aria-invalid={Boolean(error?.startsWith("账号"))}
                value={form.draft.username}
                disabled={saving}
                onChange={(e) =>
                  form.setDraft((d) => ({ ...d, username: e.target.value }))
                }
              />
            </label>
            <div className={`${styles.field} ${styles.passwordField}`}>
              {status.hasPassword && !changingPassword ? (
                <>
                  <span>访问密码</span>
                  <div className={styles.passwordValue}>
                    <span className={styles.passwordStatus}><KeyRound {...UI_ICON_SM} />已设置</span>
                    <Button
                      size="sm"
                      variant="ghost"
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
                  <TextInput
                    density="workspace" className={styles.input}
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
          )}
          <p className={styles.networkNote}><ShieldCheck {...UI_ICON_SM} className={styles.inlineIcon} />
            仅在自己的网络使用，请勿把端口映射到公网。
          </p>
        </div>
      </SettingsCard>
    </div>
  );
  return (
    <div className={styles.root}>
      {config}
      <SettingsCard
        as="section"
        aria-label="访问入口"
        headerClassName={styles.cardHeader}
        title={<span className={styles.sectionTitle}><Globe {...UI_ICON_SM} />访问入口</span>}
        hint="在其他设备浏览和播放；媒体库管理仍在桌面端完成。"
        actions={
          <div className={styles.actions}>
            <span role="status"><SettingsStatusPill status={status.running ? 'success' : status.error ? 'warning' : 'muted'}>
              {status.running ? "运行中" : status.error ? "启动失败" : "未开启"}
            </SettingsStatusPill></span>
            <IconButton
              size="control"
              label="刷新服务状态"
              icon={<RefreshCw {...UI_ICON_SM} />}
              disabled={saving}
              onClick={() =>
                void api.webAccess
                  .status()
                  .then(onChange)
                  .catch((e) => setAddressFeedback(e.message))
              }
            />
            {status.enabled && !status.running && <Button size="sm" disabled={saving || form.dirty}
              title={form.dirty ? '请先保存或取消配置更改' : undefined} onClick={() => void save()}>重试启动</Button>}
          </div>
        }
      >
        <div className={styles.accessBody}>
          <div className={styles.accessToolbar}>
            <div className={styles.addressSelect}><SelectControl aria-label="访问地址" value={url} disabled={!status.running || !url} onChange={e => { setSelectedUrl(e.target.value); setAddressFeedback("") }}>
              {!url && <option value="">服务未运行</option>}
              {status.urls.map(value => <option key={value} value={value}>{value}{value.includes('127.0.0.1') ? ' · 仅本机' : ''}</option>)}
            </SelectControl></div>
            <div className={styles.actions}>
              <IconButton size="control" icon={addressFeedback === '地址已复制' ? <Check {...UI_ICON_SM} /> : <Copy {...UI_ICON_SM} />} label="复制访问地址" disabled={!status.running || !url} onClick={() => void navigator.clipboard.writeText(url).then(() => setAddressFeedback('地址已复制')).catch(() => setAddressFeedback(`复制失败，请手动复制：${url}`))} />
              <IconButton size="control" icon={<ExternalLink {...UI_ICON_SM} />} label="打开访问地址" disabled={!status.running || !url} onClick={() => void api.externalLinks.open(url).catch(e => setAddressFeedback(e.message))} />
              <Button size="sm" className={styles.iconLabel} disabled={!status.running || !url} onClick={() => setQrOpen(true)}><QrCode {...UI_ICON_SM} />扫码访问</Button>
            </div>
          </div>
          <div className={styles.accessFeedback}>
            <div className={styles.inlineFeedback} data-error={Boolean(status.error)} role="status">{addressFeedback || (helpOpen ? '其他设备需连接同一网络（例如同一个 Wi-Fi），不要使用仅本机地址。可切换其他地址尝试，并检查防火墙是否允许此端口。' : status.error || (!status.running ? '请在上方开启并保存。' : '此地址用于只读浏览与播放，首次访问需登录或配对。'))}</div>
            <div className={styles.actions}><Button size="sm" variant="ghost" aria-expanded={helpOpen} onClick={() => setHelpOpen(!helpOpen)}>{helpOpen ? '收起说明' : '无法连接？'}</Button>
              {addressFeedback && <Button size="sm" variant="ghost" onClick={() => setAddressFeedback("")}>关闭提示</Button>}</div>
          </div>
        </div>
      </SettingsCard>
      <WebDevices status={status} onChange={onChange} coordination={{ lock, revision: operationRevision,
        busy: saving, onBusyChange: setDevicesBusy }} />
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
    </div>
  );
}
