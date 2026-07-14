import { ExternalLink, GitFork, Heart, Library, ShieldCheck } from 'lucide-react'
import { APP_DISPLAY_NAME } from '@shared/appIdentity'
import { api } from '../../api'
import { UI_ICON_MD, UI_ICON_SM } from '../iconDefaults'
import AppUpdatePanel from './AppUpdatePanel'
import appLogoUrl from '../../../../../resources/icon.png'

const PROJECT_FACTS = [
  { label: '运行方式', value: '桌面应用' },
  { label: '技术栈', value: 'Electron · React · TypeScript · SQLite' },
  { label: '开源许可', value: 'MIT License' },
  { label: '数据原则', value: '媒体库与资源保存在本机' }
]

export default function AboutSettingsPanel(): JSX.Element {
  return (
    <div className="about-settings">
      <section className="about-hero" aria-labelledby="about-app-title">
        <div className="about-app-mark">
          <img src={appLogoUrl} alt="Javdex 软件图标" draggable={false} />
        </div>
        <div className="about-hero-copy">
          <h2 id="about-app-title">{APP_DISPLAY_NAME}</h2>
          <p>本地优先、插件驱动、可扩展的媒体库管理工具。</p>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void api.appUpdate.openProjectPage('project')}
        >
          <GitFork {...UI_ICON_SM} aria-hidden />
          GitHub 项目
          <ExternalLink {...UI_ICON_SM} aria-hidden />
        </button>
      </section>

      <AppUpdatePanel />

      <div className="about-info-grid">
        <section className="settings-card about-info-card" aria-labelledby="about-project-title">
          <div className="about-info-card-head">
            <Library {...UI_ICON_MD} aria-hidden />
            <div>
              <h3 id="about-project-title">项目信息</h3>
              <p>软件不提供媒体内容，播放由系统默认播放器完成。</p>
            </div>
          </div>
          <dl className="about-fact-list">
            {PROJECT_FACTS.map((item) => (
              <div key={item.label}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="settings-card about-info-card" aria-labelledby="about-open-source-title">
          <div className="about-info-card-head">
            <ShieldCheck {...UI_ICON_MD} aria-hidden />
            <div>
              <h3 id="about-open-source-title">开源与隐私</h3>
              <p>源代码按 MIT License 发布；版本检测仅请求公开 GitHub Release。</p>
            </div>
          </div>
          <div className="about-link-list">
            <button type="button" onClick={() => void api.appUpdate.openProjectPage('releases')}>
              <span>所有版本与下载</span>
              <ExternalLink {...UI_ICON_SM} aria-hidden />
            </button>
            <button type="button" onClick={() => void api.appUpdate.openProjectPage('license')}>
              <span>查看 MIT License</span>
              <ExternalLink {...UI_ICON_SM} aria-hidden />
            </button>
          </div>
        </section>
      </div>

      <footer className="about-footer">
        <span>Copyright © 2026 Javdex</span>
        <span><Heart {...UI_ICON_SM} aria-hidden /> 为本地媒体整理而构建</span>
      </footer>
    </div>
  )
}
