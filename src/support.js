export const regexMerge = (...args) => {
  const hasOptions = (!!args[args.length - 1]) && (args[args.length - 1].constructor === Object)
  const opts = {
    stripAnchors: true,
    anchor: null,
    flags: null,
    ...(hasOptions ? args.pop() : {})
  }

  const flags = []
  const result = []
  let anchorStart = opts.anchor
  let anchorEnd = opts.anchor

  for (let idx = 0, len = args.length; idx < len; idx += 1) {
    const arg = args[idx]
    if (arg instanceof RegExp) {
      flags.push(...arg.flags)
      const { source } = arg
      const anchoredStart = source[0] === '^'
      let anchoredEnd = false
      if (source[source.length - 1] === '$') {
        let c = 2
        while (source[source.length - c] === '\\') {
          c += 1
        }
        anchoredEnd = c % 2 === 0
      }
      if (anchoredStart && anchorStart === null) {
        anchorStart = true
      }
      if (anchoredEnd && anchorEnd === null) {
        anchorEnd = true
      }
      result.push(source.slice(
        opts.stripAnchors === true && anchoredStart ? 1 : 0,
        opts.stripAnchors === true && anchoredEnd ? -1 : undefined
      ))
    } else {
      result.push(arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    }
  }

  return new RegExp(
    [
      anchorStart === true ? '^' : '',
      ...result,
      anchorEnd === true ? '$' : ''
    ].join(''),
    opts.flags === null
      ? [...new Set(flags)].join('')
      : opts.flags
  )
}
