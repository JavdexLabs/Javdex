import { ExternalLink, GitFork, Heart, Library, ShieldCheck } from 'lucide-react'
import { APP_DISPLAY_NAME } from '@shared/appIdentity'
import { api } from '../../api'
import { UI_ICON_MD, UI_ICON_SM } from '../iconDefaults'
import AppUpdatePanel from './AppUpdatePanel'
import Button from '../Button'
import styles from './AboutSettingsPanel.module.css'
import { SettingsCard, SettingsDisclosure } from './SettingsPrimitives'

const appLogoUrl = `${import.meta.env?.BASE_URL ?? '/'}icon-192.png`

const PROJECT_FACTS = [
  { label: '运行方式', value: '桌面应用' },
  { label: '技术栈', value: 'Electron · React · TypeScript · SQLite' },
  { label: '开源许可', value: 'GPL-3.0-or-later' },
  { label: '数据存储', value: '本机或自建服务端；原始媒体由你管理' }
]

export default function AboutSettingsPanel(): JSX.Element {
  return (
    <div className={styles.root}>
      <section className={styles.hero} aria-labelledby="about-app-title">
        <div className={styles.appMark}>
          <img src={appLogoUrl} alt="Javdex 软件图标" draggable={false} />
        </div>
        <div className={styles.heroCopy}>
          <h2 id="about-app-title">{APP_DISPLAY_NAME}</h2>
          <p>本地优先、插件驱动、可扩展的媒体库管理工具。</p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => void api.appUpdate.openProjectPage('project')}
        >
          <GitFork {...UI_ICON_SM} aria-hidden />
          GitHub 项目
          <ExternalLink {...UI_ICON_SM} aria-hidden />
        </Button>
      </section>

      <AppUpdatePanel />

      <div className={styles.infoGrid}>
        <SettingsCard
          as="section"
          className={styles.infoCard}
          aria-labelledby="about-project-title"
        >
          <div className={styles.infoCardHead}>
            <Library {...UI_ICON_MD} aria-hidden />
            <div>
              <h3 id="about-project-title">项目信息</h3>
              <p>软件不提供媒体内容，支持内置与外部播放器。</p>
            </div>
          </div>
          <dl className={styles.factList}>
            {PROJECT_FACTS.map((item) => (
              <div key={item.label}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        </SettingsCard>

        <SettingsCard
          as="section"
          className={styles.infoCard}
          aria-labelledby="about-open-source-title"
        >
          <div className={styles.infoCardHead}>
            <ShieldCheck {...UI_ICON_MD} aria-hidden />
            <div>
              <h3 id="about-open-source-title">开源与隐私</h3>
              <p>开源、本地优先；版本检测使用公开 GitHub Release。</p>
            </div>
          </div>
          <div className={styles.linkList}>
            <button type="button" onClick={() => void api.appUpdate.openProjectPage('releases')}>
              <span>所有版本与下载</span>
              <ExternalLink {...UI_ICON_SM} aria-hidden />
            </button>
            <button type="button" onClick={() => void api.appUpdate.openProjectPage('license')}>
              <span>查看 GPL 许可证</span>
              <ExternalLink {...UI_ICON_SM} aria-hidden />
            </button>
          </div>
          <SettingsDisclosure title="许可与数据说明">
            <p>源代码按 GPL v3 或后续版本发布，可按许可再分发，不提供任何保证。</p>
            <p>资料库可保存在本机或自建服务端。云端模型仅在所选功能调用时接收请求内容。</p>
          </SettingsDisclosure>
        </SettingsCard>
      </div>

      <footer className={styles.footer}>
        <span>Copyright © 2026 Javdex</span>
        <span>
          <Heart {...UI_ICON_SM} aria-hidden /> 为本地媒体整理而构建
        </span>
      </footer>
    </div>
  )
}
