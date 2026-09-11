import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Check, X, LoaderCircle } from "lucide-react";
import { UI_ICON_SM } from "../iconDefaults";
import type { WebAccessStatus } from "@shared/webTypes";
import { api } from "../../api";
import Button from "../Button";
import { WEB_ACCESS_LABEL } from "../../settings/settingsRoutes";
import { SettingsCard } from "./SettingsPrimitives";
import ConfirmModal from "../ConfirmModal";
import styles from "./WebAccessPanel.module.css";

export function AddressCode({ url }: { url: string }): JSX.Element {
  const [image, setImage] = useState("");
  useEffect(() => {
    let alive = true;
    void QRCode.toDataURL(url, { width: 180, margin: 2 })
      .then((value) => {
        if (alive) setImage(value);
      })
      .catch(() => {
        if (alive) setImage("");
      });
    return () => {
      alive = false;
    };
  }, [url]);
  return (
    <div>
      {image && (
        <img
          className={styles.qrImage}
          src={image}
          width={180}
          height={180}
          alt={`扫码打开 ${url}，随后配对登录`}
        />
      )}
      <p className={styles.url}>{url}</p>
    </div>
  );
}
export default function WebDevices({
  status,
  onChange,
}: {
  status: WebAccessStatus;
  onChange: (value: WebAccessStatus) => void;
}): JSX.Element {
  const [code, setCode] = useState("");
  const [decision, setDecision] = useState<"allow" | "deny" | null>(null);
  const [decisionFeedback, setDecisionFeedback] = useState("");
  const [confirm, setConfirm] = useState<{
    kind: "revoke" | "rename" | "reset" | "all";
    id?: string;
    name?: string;
  } | null>(null);
  const [newName, setNewName] = useState("");
  const lock = useRef(false);
  const revision = useRef(0);
  const [candidate, setCandidate] = useState<{
    code: string;
    name: string;
    expires: number;
    remember: boolean;
  } | null>(null);
  const pairSlot = useRef<HTMLDivElement>(null);
  const previousCandidate = useRef(candidate);
  useEffect(() => {
    if (previousCandidate.current !== candidate) {
      pairSlot.current?.querySelector<HTMLElement>(candidate ? '[data-pair-identity]' : 'input:not(:disabled)')?.focus({ preventScroll: true });
      previousCandidate.current = candidate;
    }
  }, [candidate]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (lock.current) return;
    lock.current = true;
    revision.current++;
    setBusy(true);
    setError("");
    setDecisionFeedback("");
    try {
      await action();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setDecision(null);
      setBusy(false);
      lock.current = false;
    }
  };
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async (): Promise<void> => {
      const current = revision.current;
      if (!lock.current) {
        try {
          const next = await api.webAccess.status();
          if (alive && !lock.current && current === revision.current)
            onChange(next);
        } catch {
          /* Keep the last snapshot; the next poll retries. */
        }
      }
      if (alive) timer = setTimeout(() => void refresh(), 2000);
    };
    timer = setTimeout(() => void refresh(), 2000);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [onChange]);
  const pairing = status.pairingUntil > now;
  const remaining = Math.max(
    0,
    Math.min(300, Math.ceil((status.pairingUntil - now) / 1000)),
  );
  return (
    <>
      <SettingsCard
        title="设备配对"
        hint="在新设备网页获取六位码，在这里核对并允许登录。"
      >
        <div className={styles.pairBody}>
          <div className={styles.stableRow}>
            <span className={styles.singleLine}>{!status.running ? `开启${WEB_ACCESS_LABEL}后可配对新设备` : pairing ? `配对已开启 · 剩余 ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` : '允许新设备发起配对，有效期 5 分钟'}</span>
            <Button disabled={busy || !status.running} onClick={() => void run(async () => { onChange(await api.webAccess.pairOpen()); setCandidate(null) })}>{pairing ? '延长配对' : '开启配对'}</Button>
          </div>
          <div className={styles.pairSlot} data-confirming={Boolean(candidate && pairing && status.running)} ref={pairSlot}>
            {candidate && pairing && status.running ? <>
              <div className={styles.pairIdentity} data-pair-identity tabIndex={-1}>
                <strong className={styles.singleLine} title={candidate.name}>{candidate.name}</strong>
                <span className={styles.singleLine}>配对码 {candidate.code} · {candidate.remember ? '记住此设备' : '临时登录'} · 只读访问</span>
              </div>
              <div className={styles.actions}>
                <Button variant="primary" className={styles.decisionButton} aria-busy={decision === "allow"} disabled={busy || candidate.expires <= now} onClick={() => void run(async () => { setDecision("allow"); onChange(await api.webAccess.pairDecide(candidate.code, true)); setDecisionFeedback("已允许登录"); setCandidate(null); setCode('') })}>{decision === "allow" ? <LoaderCircle {...UI_ICON_SM} className={styles.spinner} aria-hidden="true" /> : <Check {...UI_ICON_SM} aria-hidden="true" />}允许登录</Button>
                <Button variant="danger" className={styles.decisionButton} aria-busy={decision === "deny"} disabled={busy} onClick={() => void run(async () => { setDecision("deny"); onChange(await api.webAccess.pairDecide(candidate.code, false)); setDecisionFeedback("已拒绝"); setCandidate(null) })}>{decision === "deny" ? <LoaderCircle {...UI_ICON_SM} className={styles.spinner} aria-hidden="true" /> : <X {...UI_ICON_SM} aria-hidden="true" />}拒绝</Button>
              </div>
            </> : <>
              <label className={styles.field}>新设备显示的配对码
                <input className={`text-input ${styles.codeInput}`} value={code} disabled={busy || !pairing || !status.running} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" maxLength={6}
                  onPaste={e => {
                    e.preventDefault();
                    const input = e.currentTarget;
                    const digits = e.clipboardData.getData('text').replace(/\D/g, '');
                    const start = input.selectionStart ?? code.length;
                    const end = input.selectionEnd ?? start;
                    const inserted = digits.slice(0, 6 - (code.length - (end - start)));
                    setCode(code.slice(0, start) + inserted + code.slice(end));
                    setCandidate(null);
                    requestAnimationFrame(() => {
                      if (input.isConnected) input.setSelectionRange(start + inserted.length, start + inserted.length);
                    });
                  }}
                  onChange={e => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setCandidate(null) }} />
              </label>
              <Button disabled={busy || !pairing || !status.running || code.length !== 6} onClick={() => void run(async () => { setCandidate({ ...(await api.webAccess.pairInspect(code)), code }) })}>核对设备</Button>
            </>}
          </div>
          <div className={styles.inlineFeedback} role="status">
            {error && !confirm ? error : decisionFeedback ? decisionFeedback : candidate && candidate.expires <= now ? '配对码已过期，请重新获取' : candidate ? '请核对设备名称和配对码，仅允许你正在操作的设备。' : status.pairingActivity.length ? status.pairingActivity.map(item => `${item.name} · ${item.state === 'connected' ? '已连接' : '已批准，等待连接'}`).join('；') : !status.running ? `开启${WEB_ACCESS_LABEL}后即可配对。` : pairing ? '在新设备网页获取六位码，输入后核对设备。' : '开启配对后，在新设备网页获取六位码。'}
          </div>
        </div>
      </SettingsCard>
      <SettingsCard
        title={`授权设备 · ${status.devices.length}`}
        hint="记住的设备长期有效，退出登录、撤销授权或修改密码后失效；临时登录不跨应用重启保留。"
      >
        {status.devices.length === 0 && (
          <p className={styles.hint}>暂无授权设备，登录或配对后会自动出现。</p>
        )}
        <div className={styles.deviceList}>
          {status.devices.map((device) => (
            <div key={device.id} className={styles.deviceRow}>
              <div className={styles.deviceCopy}>
                <div className={styles.deviceTitle}>
                  <strong className={styles.deviceName}>{device.name}</strong>
                  <span className={styles.badge}>
                    {device.remember ? "已记住" : "临时登录"}
                  </span>
                </div>
                <p className={styles.deviceMeta}>
                  最近访问{" "}
                  <time
                    title={new Date(device.touched).toLocaleString()}
                    dateTime={new Date(device.touched).toISOString()}
                  >
                    {now - device.touched < 60000
                      ? "刚刚"
                      : now - device.touched < 3600000
                        ? `${Math.floor((now - device.touched) / 60000)} 分钟前`
                        : new Date(device.touched).toLocaleString()}
                  </time>
                  {" · "}{device.expires === null ? "长期有效" : `到期时间 ${new Date(device.expires).toLocaleString()}`}
                </p>
              </div>
              <Button
                disabled={busy}
                onClick={() => {
                  setNewName(device.name);
                  setConfirm({
                    kind: "rename",
                    id: device.id,
                    name: device.name,
                  });
                }}
              >
                重命名
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  setError("");
                  setConfirm({
                    kind: "revoke",
                    id: device.id,
                    name: device.name,
                  });
                }}
              >
                撤销
              </Button>
            </div>
          ))}
        </div>
        <div className={styles.deviceFooter}>
          <Button
            variant="danger"
            disabled={busy || status.devices.length === 0}
            onClick={() => {
              setError("");
              setConfirm({ kind: "all" });
            }}
          >
            退出所有设备
          </Button>
          {status.error && !status.running && (
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                setError("");
                setConfirm({ kind: "reset" });
              }}
            >
              重置浏览器授权
            </Button>
          )}
        </div>
      </SettingsCard>
      {confirm && (
        <ConfirmModal
          title={
            confirm.kind === "rename"
              ? "重命名设备"
              : confirm.kind === "reset"
                ? "重置浏览器授权"
                : confirm.kind === "all"
                  ? "退出所有设备"
                  : "撤销设备授权"
          }
          danger={confirm.kind !== "rename"}
          busy={busy}
          closeDisabled={busy}
          confirmText={confirm.kind === "rename" ? "保存" : "确认"}
          confirmDisabled={confirm.kind === "rename" && !newName.trim()}
          onCancel={() => {
            if (!lock.current) setConfirm(null);
          }}
          onConfirm={() =>
            void run(async () => {
              const next =
                confirm.kind === "rename"
                  ? await api.webAccess.deviceRename(
                      confirm.id!,
                      newName.trim(),
                    )
                  : confirm.kind === "revoke"
                    ? await api.webAccess.deviceRemove(confirm.id!)
                    : confirm.kind === "reset"
                      ? await api.webAccess.deviceReset()
                      : await api.webAccess.revoke();
              onChange(next);
              setConfirm(null);
            })
          }
        >
          {confirm.kind === "rename" ? (
            <label className={styles.field}>
              设备名称
              <input
                className="text-input"
                value={newName}
                maxLength={80}
                disabled={busy}
                onChange={(e) => setNewName(e.target.value)}
              />
            </label>
          ) : (
            <p>
              {confirm.kind === "revoke"
                ? `将退出“${confirm.name}”并停止它的播放。其他设备不受影响。`
                : "所有浏览器需要重新登录或配对，当前播放连接会关闭。账号、密码和媒体库保持不变。"}
            </p>
          )}
          {error && <p role="alert">{error}</p>}
        </ConfirmModal>
      )}

    </>
  );
}
