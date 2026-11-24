/** Fixed bundled YAML. Embedded so compiled/prebuilt CDS needs no runtime source-file lookup. */
export const CODE_REVIEW_SEMGREP_RULES = String.raw`
rules:
  - id: cds.javascript.eval
    languages: [javascript, typescript]
    message: 动态 eval 会执行输入字符串，请确认输入可信并优先改用数据解析。
    severity: WARNING
    metadata:
      category: security
    pattern: eval(...)
  - id: cds.javascript.function-constructor
    languages: [javascript, typescript]
    message: Function 构造器会动态执行字符串，请改用显式函数与数据参数。
    severity: WARNING
    metadata:
      category: security
    pattern: new Function(...)
  - id: cds.javascript.nan-comparison
    languages: [javascript, typescript]
    message: NaN 与任何值的相等比较都为假，请使用 Number.isNaN 判断。
    severity: WARNING
    metadata:
      category: bug
    pattern-either:
      - pattern: $VALUE == NaN
      - pattern: $VALUE === NaN
      - pattern: $VALUE != NaN
      - pattern: $VALUE !== NaN
  - id: cds.javascript.child-process-shell
    languages: [javascript, typescript]
    message: child_process 的 shell 命令存在注入风险，请使用 execFile 并分开传递参数。
    severity: WARNING
    metadata:
      category: security
    pattern-either:
      - pattern: require('child_process').exec(...)
      - pattern: require('node:child_process').exec(...)
      - pattern: require('child_process').execSync(...)
      - pattern: require('node:child_process').execSync(...)
  - id: cds.python.eval
    languages: [python]
    message: 动态 eval 会执行输入字符串，请确认输入可信并优先改用数据解析。
    severity: WARNING
    metadata:
      category: security
    pattern: eval(...)
  - id: cds.python.shell-true
    languages: [python]
    message: subprocess 启用 shell=True 存在命令注入风险，请传递参数列表并禁用 shell。
    severity: WARNING
    metadata:
      category: security
    pattern: subprocess.$FUNC(..., shell=True, ...)
  - id: cds.python.assert-tuple
    languages: [python]
    message: assert 非空元组始终为真，请将错误消息写在断言表达式后的逗号右侧。
    severity: WARNING
    metadata:
      category: bug
    pattern: assert ($CONDITION, $MESSAGE)
`;
