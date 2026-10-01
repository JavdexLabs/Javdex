import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspectConsumerStyles, inspectModuleStyles } from './lib/css-style-ownership.mjs'

const owners = new Map([['hint', new Set(['global.css'])], ['content', new Set(['global.css'])]])

test('inventory distinguishes module identifiers from actual global and undefined class strings', () => {
  const result = inspectConsumerStyles({ file: 'fixture.tsx', owners, source: `
import styles from './Fixture.module.css'
const view = <div className={styles.content}>
  <span className={\`hint \${selected ? 'legacy-missing' : styles.hint}\`}/>
</div>` })
  assert.deepEqual(result.modules, ['./Fixture.module.css'])
  assert.deepEqual(result.globalReferences, [{ name: 'hint', owners: ['global.css'] }])
  assert.deepEqual(result.unownedLiteralClasses, ['legacy-missing'])
  assert.equal(result.expressions.length, 2)
})

test('inventory includes className layout slots and retains candidates requiring manual closure', () => {
  const result = inspectConsumerStyles({ file: 'fixture.tsx', owners,
    source: `<Card headerClassName="missing-header" bodyClassName={classesFor(state)}/>` })
  assert.deepEqual(result.unownedLiteralClasses, ['missing-header'])
  assert.deepEqual(result.expressions, ['{classesFor(state)}'])
})

test('inventory ignores conditions, module keys, helper arguments and incomplete template fragments', () => {
  const result = inspectConsumerStyles({ file: 'fixture.tsx', owners, source: `
<><div className={density === 'workspace' ? 'hint' : styles[variant === 'custom' ? 'content' : 'plain']}/>
<div className={\`empty-state empty-state--\${variant} \${kind === 'video' ? 'selected' : ''}\`}/>
<div className={classesFor('avatar', state)}/><div className={enabled && 'active'}/>
<div className={fallback || 'default'}/></>` })
  assert.deepEqual(result.globalReferences, [{ name: 'hint', owners: ['global.css'] }])
  assert.deepEqual(result.unownedLiteralClasses, ['active', 'default', 'empty-state', 'selected'])
  assert.equal(result.expressions.length, 5)
})

test('inventory follows navigation class callbacks without treating conditions or nested helpers as output', () => {
  const result = inspectConsumerStyles({ file: 'fixture.tsx', owners, source: `
<><Link className={({ isActive }) => \`hint \${isActive ? 'active' : styles.content}\`}/>
<Link className={function (state) {
  function unused() { return 'not-a-class-output' }
  if (state.kind === 'library') return 'library-link'
  return styles.content
}}/></>` })
  assert.deepEqual(result.globalReferences, [{ name: 'hint', owners: ['global.css'] }])
  assert.deepEqual(result.unownedLiteralClasses, ['active', 'library-link'])
  assert.equal(result.expressions.length, 2)
})

test('inventory distinguishes literal inline objects from dynamic, spread and forwarded styles', () => {
  const result = inspectConsumerStyles({ file: 'fixture.tsx', owners, source: `
<><div style={{ width: 240, marginTop: -1, '--color': 'var(--text-primary)' }}/>
<div style={{ width: progress * 2 }}/><div style={{ ...layout, color: 'red' }}/>
<div style={style}/></>` })
  assert.deepEqual(result.inlineStyles.map(item => item.literalObject), [true, false, false, false])
  assert.equal(result.inlineStyles[0].line, 2)
  assert.match(result.inlineStyles[1].expression, /progress/)
})

test('inventory retains global attribute escapes and nested privacy contracts for explicit auditing', () => {
  const result = inspectModuleStyles({ file: 'fixture.module.css', source: `
.root :global([class~='legacy-head']) { margin: 0 }
:global(:root:where([data-privacy-mode='true'])) .image { filter: blur(12px) }
.local { padding: 2px }` })
  assert.equal(result.globalSelectors.length, 2)
  assert.equal(result.globalSelectors[0].line, 2)
  assert.match(result.globalSelectors[0].selector, /legacy-head/)
  assert.match(result.globalSelectors[1].selector, /:root:where/)
})
