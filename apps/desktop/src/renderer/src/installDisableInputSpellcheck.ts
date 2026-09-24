function disableSpellcheckOn(node: Node): void {
  if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
    node.spellcheck = false
  }
  if (node instanceof Element) {
    node.querySelectorAll('input, textarea').forEach((el) => {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.spellcheck = false
      }
    })
  }
}

export function installDisableInputSpellcheck(): () => void {
  disableSpellcheckOn(document.documentElement)

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => disableSpellcheckOn(node))
    }
  })

  observer.observe(document.documentElement, { childList: true, subtree: true })
  return () => observer.disconnect()
}
