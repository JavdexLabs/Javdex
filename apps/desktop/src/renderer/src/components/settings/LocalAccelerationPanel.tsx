import type { LocalModelCommand, LocalModelSnapshot } from '@shared/desktop/localModels'
import Button from '../Button'
import SelectControl from '../SelectControl'
import { SettingsCard, SettingsDisclosure, SettingsRow, SettingsValueRow } from './SettingsPrimitives'
import styles from './LocalAccelerationPanel.module.css'
import LocalModelOperationFeedback, { type ModelOperationFailure } from './LocalModelOperationFeedback'

export default function LocalAccelerationPanel({ state, disabled, execute, failure, requestError }: {
  state: LocalModelSnapshot; disabled: boolean; execute: (command: LocalModelCommand) => Promise<boolean>
  failure?: ModelOperationFailure; requestError: () => void
}) {
  const acceleration = state.acceleration
  if (!acceleration) return null
  const policy = acceleration.policy
  const value = policy.mode === 'gpu' ? `gpu:${policy.device}` : policy.mode
  return <SettingsCard title="计算设备" hint="修改后自动验证当前选用模型，结果显示在下方。" aria-label="本地模型计算设备">
    <SettingsRow title="运行方式" description="选择后立即保存，对新任务生效。GPU 不可用时自动使用 CPU。">
      <div className={styles.modeControl}><SelectControl aria-label="本地模型运行方式" value={value} disabled={disabled} onChange={event => {
        const next = event.target.value
        void execute({ action: 'acceleration', expectedRevision: state.revision,
          policy: next.startsWith('gpu:') ? { mode: 'gpu', device: next.slice(4) } : { mode: next as 'auto' | 'cpu' } })
      }}>
        <option value="auto">自动选择</option><option value="cpu">仅 CPU</option>
        {acceleration.devices.map(device => <option key={device.id} value={`gpu:${device.id}`}>{device.name} · {device.backend.toUpperCase()}</option>)}
        {policy.mode === 'gpu' && !acceleration.devices.some(device => device.id === policy.device)
          && <option value={value}>已选显卡不可用 · 自动回退 CPU</option>}
      </SelectControl></div>
    </SettingsRow>
    <SettingsValueRow label="已检测到的显卡" value={acceleration.devices.map(device => `${device.name} · ${device.backend.toUpperCase()}`).join('、')
      || (state.supported ? (policy.mode === 'auto' && !acceleration.supported ? '使用平台默认后端，以下方验证结果为准'
        : acceleration.detectionComplete === false ? 'GPU 检测尚未完成，请在下方安装 GPU 加速支持' : '未检测到可用独显，可使用 CPU') : '当前平台仅支持管理文件')} actions={
      <Button size="sm" disabled={disabled} onClick={() => void execute({ action: 'detect-devices' })}>重新检测并验证</Button>
    } />
    {failure && ['acceleration', 'detect-devices'].includes(failure.command.action) && !state.operation && <LocalModelOperationFeedback failure={failure} disabled={disabled} execute={execute} details={requestError} />}
    <SettingsDisclosure title="运行支持与设备详情">
      <p>语音和文本分别安装运行环境，GPU 加速支持可选。安装完成后，当前选用精度会自动进行短推理验证。</p>
      <p>验证不使用影片或麦克风内容。有任务运行时等待任务结束；新的任务或文件操作会中止检查，空闲后继续。实际运行仍可能因显存占用变化而使用 CPU，具体原因显示在对应模型上。</p>
      <p>Windows 独显使用 CUDA 或 Vulkan，macOS 自动模式使用平台后端。没有独显时可正常使用 CPU。</p>
      <p>展开运行环境可查看组件、文件大小和安装状态。</p>
    </SettingsDisclosure>
  </SettingsCard>
}
