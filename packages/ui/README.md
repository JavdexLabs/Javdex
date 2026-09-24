# Shared presentation components

Contains the existing Checkbox component and its stylesheet, moved unchanged from the desktop renderer because the browser already used it. There is no new design system or universal page layer.

Components depend on React and caller-provided semantic CSS tokens only; never import either application, Electron, filesystem or database. Desktop and browser page flows remain separate.
