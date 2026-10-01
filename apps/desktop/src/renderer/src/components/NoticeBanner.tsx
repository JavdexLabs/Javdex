import type { ComponentPropsWithoutRef } from 'react'
import styles from './NoticeBanner.module.css'

export type NoticeTone = 'warning' | 'info'

export default function NoticeBanner({ tone, className, ...props }: ComponentPropsWithoutRef<'div'> & { tone: NoticeTone }): JSX.Element {
  return <div {...props} className={`${styles.banner} ${styles[tone]}${className ? ` ${className}` : ''}`} />
}

export function NoticeBannerCopy({ title, body, settingsTypography = false, className }: {
  title: string
  body: string
  settingsTypography?: boolean
  className?: string
}): JSX.Element {
  return <div className={`${styles.copy}${settingsTypography ? ` ${styles.copySettings}` : ''}${className ? ` ${className}` : ''}`}>
    <strong>{title}</strong>
    <span>{body}</span>
  </div>
}

export function NoticeBannerActions({ className, ...props }: ComponentPropsWithoutRef<'div'>): JSX.Element {
  return <div {...props} className={`${styles.actions}${className ? ` ${className}` : ''}`} />
}
