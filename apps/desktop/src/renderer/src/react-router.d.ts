import 'react-router'

declare module 'react-router' {
  interface NavigateFunction {
    (to: To, options?: NavigateOptions): void
    (delta: number): void
  }
}
