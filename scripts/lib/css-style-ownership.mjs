import postcss from 'postcss'
import ts from 'typescript'

export function inspectModuleStyles({ file, source }) {
  const globalSelectors = []
  postcss.parse(source, { from: file }).walkRules(rule => {
    if (rule.selector.includes(':global')) {
      globalSelectors.push({ selector: rule.selector, line: rule.source.start.line })
    }
  })
  return { file, globalSelectors }
}

export function inspectConsumerStyles({ file, source, owners }) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const references = new Set()
  const literalClasses = new Set()
  const expressions = []
  const inlineStyles = []
  function collectText(value, afterExpression = false, beforeExpression = false) {
    // A template fragment touching an expression is not a complete class name.
    let complete = value
    if (afterExpression) complete = complete.replace(/^\S*/, '')
    if (beforeExpression) complete = complete.replace(/\S*$/, '')
    for (const token of complete.split(/\s+/).filter(token => /^[_a-zA-Z][\w-]*$/.test(token))) {
      literalClasses.add(token)
      if (owners.has(token)) references.add(token)
    }
  }
  function collectLiterals(part) {
    if (!part) return
    // Only output branches: comparisons, module keys and helper arguments are not classes.
    if (ts.isStringLiteralLike(part)) collectText(part.text)
    else if (ts.isJsxExpression(part)) collectLiterals(part.expression)
    else if (ts.isParenthesizedExpression(part) || ts.isAsExpression(part) || ts.isNonNullExpression(part)) collectLiterals(part.expression)
    else if (ts.isConditionalExpression(part)) {
      collectLiterals(part.whenTrue)
      collectLiterals(part.whenFalse)
    } else if (ts.isTemplateExpression(part)) {
      collectText(part.head.text, false, true)
      for (const span of part.templateSpans) {
        collectLiterals(span.expression)
        collectText(span.literal.text, true, !ts.isTemplateTail(span.literal))
      }
    } else if (ts.isBinaryExpression(part)) {
      if (part.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) collectLiterals(part.right)
      else if ([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(part.operatorToken.kind)) {
        collectLiterals(part.left)
        collectLiterals(part.right)
      }
    } else if (ts.isArrowFunction(part) || ts.isFunctionExpression(part)) {
      if (!ts.isBlock(part.body)) collectLiterals(part.body)
      else {
        const collectReturns = node => {
          if (ts.isReturnStatement(node)) collectLiterals(node.expression)
          else if (!ts.isFunctionLike(node)) ts.forEachChild(node, collectReturns)
        }
        collectReturns(part.body)
      }
    }
  }
  function literalValue(node) {
    return ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)
      || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)
      || (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand))
  }
  function visit(node) {
    if (ts.isJsxAttribute(node) && node.initializer) {
      if (/className$/i.test(node.name.getText(ast))) {
        collectLiterals(node.initializer)
        if (!ts.isStringLiteral(node.initializer)) expressions.push(node.initializer.getText(ast))
      }
      if (node.name.getText(ast) === 'style') {
        const expression = ts.isJsxExpression(node.initializer) ? node.initializer.expression : undefined
        inlineStyles.push({
          line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
          expression: node.initializer.getText(ast),
          // Syntactically literal, not a semantic verdict: dynamic placement and props need review.
          literalObject: Boolean(expression && ts.isObjectLiteralExpression(expression)
            && expression.properties.every(property => ts.isPropertyAssignment(property)
              && !ts.isComputedPropertyName(property.name) && literalValue(property.initializer)))
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return {
    file,
    modules: [...source.matchAll(/from\s+['"]([^'"]+\.module\.css)['"]/g)].map(match => match[1]),
    globalReferences: [...references].sort().map(name => ({ name, owners: [...owners.get(name)] })),
    unownedLiteralClasses: [...literalClasses].filter(name => !owners.has(name)).sort(),
    expressions,
    inlineStyles
  }
}
