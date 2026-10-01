export default {
  extends: ['stylelint-config-standard'],
  overrides: [
    {
      files: ['apps/web/src/**/*.module.css'],
      rules: {
        'declaration-no-important': true,
        'max-nesting-depth': 2,
        'selector-class-pattern': '^(?:[a-z][a-zA-Z0-9]*|yarl__(?:toolbar|counter|button|slide|navigation_prev|navigation_next))$',
        'custom-property-pattern': '^(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*|yarl__[a-z_]+)$',
        'selector-max-compound-selectors': 3,
        'selector-max-specificity': '0,3,0',
        'selector-pseudo-class-no-unknown': [true, { ignorePseudoClasses: ['global'] }]
      }
    },
    {
      files: ['apps/desktop/src/renderer/src/**/*.module.css'],
      rules: {
        'declaration-no-important': true,
        'max-nesting-depth': 2,
        'selector-class-pattern': '^[a-z][a-zA-Z0-9]*$',
        'selector-max-compound-selectors': 3,
        'selector-max-specificity': '0,3,0',
        'selector-pseudo-class-no-unknown': [true, { ignorePseudoClasses: ['global'] }]
      }
    }
  ]
}
