import TextInput from '../TextInput'
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import QRCode from "qrcode";
import { Check, X, LoaderCircle, Link2, LogOut, MonitorSmartphone, Pencil } from "lucide-react";
import { UI_ICON_SM } from "../iconDefaults";
import type { WebAccessStatus } from "@shared/webTypes";
import { api } from "../../api";
import Button from "../Button";
import IconButton from "../IconButton";
import { WEB_ACCESS_LABEL } from "../../settings/settingsRoutes";
import { SettingsCard, SettingsDisclosure, SettingsEmptyPanel, SettingsStatusPill } from "./SettingsPrimitives";
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
  coordination,
}: {
  status: WebAccessStatus;
  onChange: (value: WebAccessStatus) => void;
  coordination?: { lock: MutableRefObject<boolean>; revision: MutableRefObject<number>;
    busy: boolean; onBusyChange: (busy: boolean) => void };
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
  const deviceHeading = useRef<HTMLSpanElement>(null);
  const confirmSource = useRef<HTMLButtonElement | null>(null);
  const requestConfirm = (value: NonNullable<typeof confirm>, source?: HTMLButtonElement): void => {
    source?.focus();
    confirmSource.current = source ?? null;
    setConfirm(value);
  };
  const ownLock = useRef(false);
  const ownRevision = useRef(0);
  const lock = coordination?.lock ?? ownLock;
  const revision = coordination?.revision ?? ownRevision;
  const [candidate, setCandidate] = useState<{
    code: string;
    name: string;
    expires: number;
    remember: boolean;
  } | null>(null);
  const pairSlot = useRef<HTMLDivElement>(null);
  const pairToggle = useRef<HTMLButtonElement>(null);
  const closeFocusPending = useRef(false);
  const previousCandidate = useRef(candidate);
  const previousPairing = useRef(false);
  const pairFocusPending = useRef(false);
  const [operationBusy, setBusy] = useState(false);
  const busy = operationBusy || coordination?.busy === true;
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (confirm || busy || !confirmSource.current) return;
    const source = confirmSource.current;
    confirmSource.current = null;
    (source.isConnected && !source.disabled ? source : deviceHeading.current)?.focus({ preventScroll: true });
  }, [confirm, busy]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (lock.current) return;
    lock.current = true;
    revision.current++;
    setBusy(true);
    coordination?.onBusyChange(true);
    setError("");
    setDecisionFeedback("");
    try {
      await action();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setDecision(null);
      setBusy(false);
      coordination?.onBusyChange(false);
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
  }, [onChange, lock, revision]);
  const pairing = status.pairingUntil > now;
  const remaining = Math.max(
    0,
    Math.min(300, Math.ceil((status.pairingUntil - now) / 1000)),
  );
  useEffect(() => {
    if ((pairing && !previousPairing.current) || previousCandidate.current !== candidate) pairFocusPending.current = true;
    previousPairing.current = pairing;
    previousCandidate.current = candidate;
    if (!pairing && !candidate) {
      pairFocusPending.current = false;
      if (!busy && closeFocusPending.current) {
        pairToggle.current?.focus({ preventScroll: true });
        closeFocusPending.current = false;
      }
    }
    if (!busy && pairFocusPending.current && status.running) {
      const target = pairSlot.current?.querySelector<HTMLElement>(candidate ? '[data-pair-identity]' : 'input:not(:disabled)');
      if (target) { target.focus({ preventScroll: true }); pairFocusPending.current = false; }
    }
  }, [pairing, status.running, busy, candidate]);
  return (
    <>
      <SettingsCard
        as="section"
        aria-label="设备配对"
        headerClassName={styles.cardHeader}
        title={<span className={styles.sectionTitle}><Link2 {...UI_ICON_SM} />设备配对</span>}
        hint="在新设备网页获取六位码，在这里核对并允许登录。"
        actions={<div className={styles.actions}>
          <SettingsStatusPill status={pairing && status.running ? 'info' : 'muted'}>
            {!status.running ? '服务未开启' : pairing ? `配对中 ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` : '未开启配对'}
          </SettingsStatusPill>
          <Button ref={pairToggle} size="sm" disabled={busy || !status.running} onClick={() => void run(async () => { onChange(await api.webAccess.pairOpen()); setCandidate(null) })}>{pairing ? '延长配对' : '开启配对'}</Button>
          {pairing && status.running && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => {
            onChange(await api.webAccess.pairClose());
            setCandidate(null); setCode('');
            setDecisionFeedback('配对已关闭，未完成的配对码已失效。');
            closeFocusPending.current = true;
          })}>关闭配对</Button>}
        </div>}
      >
        <div className={styles.pairBody}>
          <div className={styles.pairSlot} data-confirming={Boolean(candidate && pairing && status.running)} ref={pairSlot}>
            {candidate && pairing && status.running ? <>
              <div className={styles.pairIdentity} data-pair-identity tabIndex={-1}>
                <strong className={styles.singleLine} title={candidate.name}>{candidate.name}</strong>
                <div className={styles.pairMeta}><span className={styles.pairCode}>配对码 {candidate.code}</span>
                  <SettingsStatusPill status="muted">{candidate.remember ? '记住此设备' : '临时登录'}</SettingsStatusPill><SettingsStatusPill status="muted">只读访问</SettingsStatusPill>
                </div>
              </div>
              <div className={styles.actions}>
                <Button variant="primary" className={styles.decisionButton} aria-busy={decision === "allow"} disabled={busy || candidate.expires <= now} onClick={() => void run(async () => { setDecision("allow"); onChange(await api.webAccess.pairDecide(candidate.code, true)); setDecisionFeedback("已允许登录"); setCandidate(null); setCode('') })}>{decision === "allow" ? <LoaderCircle {...UI_ICON_SM} className={styles.spinner} aria-hidden="true" /> : <Check {...UI_ICON_SM} aria-hidden="true" />}允许登录</Button>
                <Button variant="danger" className={styles.decisionButton} aria-busy={decision === "deny"} disabled={busy} onClick={() => void run(async () => { setDecision("deny"); onChange(await api.webAccess.pairDecide(candidate.code, false)); setDecisionFeedback("已拒绝"); setCandidate(null) })}>{decision === "deny" ? <LoaderCircle {...UI_ICON_SM} className={styles.spinner} aria-hidden="true" /> : <X {...UI_ICON_SM} aria-hidden="true" />}拒绝</Button>
              </div>
            </> : pairing && status.running ? <>
              <label className={styles.field}>新设备显示的配对码
                <TextInput density="workspace" className={styles.codeInput} value={code} disabled={busy || !pairing || !status.running} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" maxLength={6}
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
            </> : <ol className={styles.pairSteps} aria-label="配对步骤">
              <li className={styles.pairStep}><span className={styles.pairStepNumber}>1</span>开启配对</li>
              <li className={styles.pairStep}><span className={styles.pairStepNumber}>2</span>输入新设备网页显示的六位码</li>
              <li className={styles.pairStep}><span className={styles.pairStepNumber}>3</span>核对设备并允许登录</li>
            </ol>}
          </div>
          <div className={styles.inlineFeedback} role="status">
            {error && !confirm ? error : decisionFeedback ? decisionFeedback : candidate && candidate.expires <= now ? '配对码已过期，请重新获取' : candidate ? '仅允许你正在操作的设备，配对后获得只读访问权限。' : status.pairingActivity.length ? status.pairingActivity.map(item => `${item.name} · ${item.state === 'connected' ? '已连接' : '已批准，等待连接'}`).join('；') : pairing ? '请在新设备打开网页并获取配对码。' : status.running ? '配对开放 5 分钟，核对设备后才允许登录。' : `开启并保存${WEB_ACCESS_LABEL}后，可配对新设备。`}
          </div>
        </div>
      </SettingsCard>
      <SettingsCard
        as="section"
        aria-label="授权设备"
        headerClassName={styles.cardHeader}
        title={<span className={styles.sectionTitle} ref={deviceHeading} tabIndex={-1}><MonitorSmartphone {...UI_ICON_SM} />授权设备<SettingsStatusPill status="muted">{status.devices.length}</SettingsStatusPill></span>}
        hint="管理已授权的浏览器，设备可只读浏览和播放。"
        actions={<div className={styles.actions}>
          <Button size="sm" variant="ghost" disabled={busy || status.devices.length === 0} onClick={event => {
            setError(""); requestConfirm({ kind: "all" }, event?.currentTarget);
          }}>退出所有设备</Button>
          {status.error && !status.running && <Button size="sm" variant="danger" disabled={busy} onClick={event => {
            setError(""); requestConfirm({ kind: "reset" }, event?.currentTarget);
          }}>重置浏览器授权</Button>}
        </div>}
      >
        {status.devices.length === 0 ? <SettingsEmptyPanel variant="compact">暂无授权设备。登录或配对后，设备会显示在这里。</SettingsEmptyPanel> :
          <div className={styles.tableScroll} role="region" aria-label="授权设备列表，可横向滚动" tabIndex={0}>
            <table className={styles.deviceTable} aria-label="授权设备列表">
              <colgroup><col className={styles.nameColumn} /><col className={styles.loginColumn} /><col className={styles.timeColumn} /><col /><col className={styles.actionsColumn} /></colgroup>
              <thead><tr>{['设备', '登录类型', '最近访问', '有效期', '操作'].map(label => <th className={`${styles.deviceCell} ${styles.deviceHead}`} scope="col" key={label}>{label}</th>)}</tr></thead>
              <tbody>{status.devices.map((device, index) => {
                const cell = `${styles.deviceCell}${index === status.devices.length - 1 ? ` ${styles.lastCell}` : ''}`;
                return <tr key={device.id} data-device-id={device.id}>
                  <th scope="row" className={cell}><strong className={styles.deviceName} title={device.name}>{device.name}</strong></th>
                  <td className={cell}><SettingsStatusPill status="muted">{device.remember ? '已记住' : '临时登录'}</SettingsStatusPill></td>
                  <td className={cell}><time className={styles.deviceTime} title={new Date(device.touched).toLocaleString()} dateTime={new Date(device.touched).toISOString()}>
                    {now - device.touched < 60000 ? '刚刚' : now - device.touched < 3600000 ? `${Math.floor((now - device.touched) / 60000)} 分钟前` : new Date(device.touched).toLocaleString()}
                  </time></td>
                  <td className={cell}><span className={styles.deviceTime}>{device.expires === null ? '长期有效' : new Date(device.expires).toLocaleString()}</span></td>
                  <td className={cell}><div className={styles.deviceActions}>
                    <IconButton size="control" icon={<Pencil {...UI_ICON_SM} />} label={`重命名“${device.name}”`} disabled={busy} onClick={event => {
                      setNewName(device.name); requestConfirm({ kind: 'rename', id: device.id, name: device.name }, event?.currentTarget);
                    }} />
                    <IconButton size="control" tone="danger" icon={<LogOut {...UI_ICON_SM} />} label={`撤销“${device.name}”的授权`} disabled={busy} onClick={event => {
                      setError(''); requestConfirm({ kind: 'revoke', id: device.id, name: device.name }, event?.currentTarget);
                    }} />
                  </div></td>
                </tr>;
              })}</tbody>
            </table>
          </div>}
        <SettingsDisclosure className={styles.deviceRules} title="授权有效期与退出规则">
          <p>记住的设备长期有效，退出登录、撤销授权或修改密码后失效；临时登录不跨应用重启保留。</p>
        </SettingsDisclosure>
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
              <TextInput
                density="workspace"
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
