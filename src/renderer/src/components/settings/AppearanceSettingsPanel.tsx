import type { AppSettings, ThemeId } from '@shared/types'
import { THEME_OPTIONS } from '../../theme'
import SettingsSwitchRow from '../SettingsSwitchRow'
import { SettingsCard } from './SettingsPrimitives'

export default function AppearanceSettingsPanel({
  settings,
  theme,
  onThemeChange,
  onPatchSettings
}: {
  settings: AppSettings
  theme: ThemeId
  onThemeChange: (theme: ThemeId) => void
  onPatchSettings: (patch: Partial<AppSettings>) => void
}): JSX.Element {
  return (
    <>
      <SettingsCard title="主题" hint="界面配色，立即生效。">
        <div className="theme-grid">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`theme-option theme-option--${option.id}${theme === option.id ? ' active' : ''}`}
              onClick={() => onThemeChange(option.id)}
            >
              <span className={`theme-swatch theme-swatch-${option.id}`} />
              <span className="theme-option-label">{option.label}</span>
              <span className="theme-option-hint">{option.hint}</span>
            </button>
          ))}
        </div>
      </SettingsCard>

      <SettingsCard
        title="详情页背景"
        hint="打开详情页时，用库里已有的图片做柔和背景。若你已单独设过背景，会优先保留你的选择。"
      >
        <div className="settings-toggle-list">
          <SettingsSwitchRow
            title="影片详情"
            description="用第一张样张图做背景"
            checked={settings.videoDetailUseFirstSampleBackground}
            onChange={(checked) => onPatchSettings({ videoDetailUseFirstSampleBackground: checked })}
          />
          <SettingsSwitchRow
            title="演员详情"
            description="用第一张写真做背景"
            checked={settings.actressDetailUseFirstGalleryBackground}
            onChange={(checked) => onPatchSettings({ actressDetailUseFirstGalleryBackground: checked })}
          />
        </div>
      </SettingsCard>
    </>
  )
}
